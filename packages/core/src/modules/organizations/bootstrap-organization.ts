import { MemberStatus } from '@company-ops/db';
import type { Prisma, PrismaClient } from '@company-ops/db';

import { recordAudit, recordPlatformAudit } from '../../platform/audit/audit-writer.js';
import { generateInvitationToken, hashInvitationToken, INVITATION_TTL_MS } from '../people/invitation-token.js';
import { materializeSystemRoles, provisionOrganization } from './provision-organization.js';
import type { NewOrganization } from './provision-organization.js';

export interface BootstrapInput {
  readonly organization: NewOrganization;
  readonly admin: {
    readonly fullName: string;
    readonly workEmail: string | null;
    readonly employeeNumber: string;
  };
  /** Revoke a still-open admin invitation and issue a new one. */
  readonly reissueInvitation: boolean;
}

export type BootstrapOutcome =
  /** Organization and/or first admin invitation created; `invitation` is shown once. */
  | {
      readonly kind: 'invited';
      readonly organizationId: string;
      readonly organizationCreated: boolean;
      readonly memberId: string;
      readonly invitation: { token: string; expiresAt: string };
    }
  /** An admin invitation is still open and `reissueInvitation` was false: nothing changed. */
  | { readonly kind: 'invitation_pending'; readonly organizationId: string; readonly memberId: string }
  /** The organization already has an ACTIVE ORG_ADMIN: nothing changed. */
  | { readonly kind: 'already_bootstrapped'; readonly organizationId: string };

/**
 * First-run bootstrap (ROADMAP P1-5, ADR-0010): creates the organization with its system roles and
 * invites the first ORG_ADMIN. There are no passwords: the admin redeems the single-use invitation
 * by signing in with the identity provider. Idempotent by organization slug; re-running never
 * creates a second organization or a second admin. Only ever run explicitly from the CLI, never by
 * application start-up. Recorded in the platform audit log and the organization's audit log.
 */
export async function bootstrapOrganization(prisma: PrismaClient, input: BootstrapInput): Promise<BootstrapOutcome> {
  let organization = await prisma.organization.findUnique({
    where: { slug: input.organization.slug },
    select: { id: true },
  });
  let organizationCreated = false;
  if (organization === null) {
    const provisioned = await provisionOrganization(prisma, input.organization, { type: 'CLI' });
    organization = { id: provisioned.organizationId };
    organizationCreated = true;
  }
  const organizationId = organization.id;

  return prisma.$transaction(async (tx) => {
    const { roleIds } = await materializeSystemRoles(tx, organizationId);
    const adminRoleId = roleIds.ORG_ADMIN;
    const activeAdmin = await tx.memberRole.findFirst({
      where: { organizationId, roleId: adminRoleId, member: { status: MemberStatus.ACTIVE } },
      select: { id: true },
    });
    if (activeAdmin !== null) {
      return { kind: 'already_bootstrapped', organizationId } as const;
    }
    const pending = await tx.memberRole.findFirst({
      where: { organizationId, roleId: adminRoleId, member: { status: MemberStatus.INVITED } },
      orderBy: { grantedAt: 'asc' },
      select: { memberId: true },
    });
    if (pending !== null) {
      if (!input.reissueInvitation) {
        return { kind: 'invitation_pending', organizationId, memberId: pending.memberId } as const;
      }
      await tx.memberInvitation.updateMany({
        where: { organizationId, memberId: pending.memberId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const invitation = await issue(tx, organizationId, pending.memberId);
      await audit(tx, organizationId, pending.memberId, 'platform.organization.admin_invitation_reissued', false);
      return {
        kind: 'invited',
        organizationId,
        organizationCreated: false,
        memberId: pending.memberId,
        invitation,
      } as const;
    }

    const member = await tx.organizationMember.create({
      data: { organizationId, status: MemberStatus.INVITED },
      select: { id: true },
    });
    await tx.employeeProfile.create({
      data: {
        organizationId,
        memberId: member.id,
        employeeNumber: input.admin.employeeNumber,
        fullName: input.admin.fullName,
        workEmail: input.admin.workEmail,
      },
      select: { id: true },
    });
    await tx.memberRole.create({ data: { organizationId, memberId: member.id, roleId: adminRoleId } });
    const invitation = await issue(tx, organizationId, member.id);
    await audit(tx, organizationId, member.id, 'platform.organization.admin_invited', organizationCreated);
    return { kind: 'invited', organizationId, organizationCreated, memberId: member.id, invitation } as const;
  });
}

async function issue(
  tx: Prisma.TransactionClient,
  organizationId: string,
  memberId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  await tx.memberInvitation.create({
    data: { organizationId, memberId, tokenHash: hashInvitationToken(token), expiresAt },
    select: { id: true },
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  memberId: string,
  action: string,
  organizationCreated: boolean,
): Promise<void> {
  await recordPlatformAudit(tx, {
    action,
    actor: { type: 'CLI' },
    targetOrganizationId: organizationId,
    metadata: { memberId, organizationCreated },
  });
  await recordAudit(tx, organizationId, {
    action: 'member.invited',
    entityType: 'member',
    entityId: memberId,
    actor: { type: 'SYSTEM' },
    metadata: { source: 'bootstrap', roleKey: 'ORG_ADMIN' },
  });
}
