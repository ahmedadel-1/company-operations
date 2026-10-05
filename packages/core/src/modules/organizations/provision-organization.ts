import { SYSTEM_ROLE_KEYS, SYSTEM_ROLE_TEMPLATES } from '@company-ops/shared';
import type { SystemRoleKey } from '@company-ops/shared';
import type { Prisma, PrismaClient } from '@company-ops/db';

import { recordAudit, recordPlatformAudit } from '../../platform/audit/audit-writer.js';
import type { AuditRequestContext, PlatformAuditActor } from '../../platform/audit/audit-writer.js';

export interface NewOrganization {
  readonly slug: string;
  readonly name: string;
  /** IANA time zone; required, no default (DATA_MODEL §3). */
  readonly timeZone: string;
  /** ISO weekdays 1-7; required, no default. */
  readonly workWeek: readonly number[];
  readonly defaultLocale?: 'en' | 'ar';
}

export interface ProvisionedOrganization {
  readonly organizationId: string;
  readonly roleIds: Readonly<Record<SystemRoleKey, string>>;
}

export class InvalidOrganizationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrganizationInputError';
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  return Intl.supportedValuesOf('timeZone').includes(timeZone) || timeZone === 'UTC';
}

function validate(input: NewOrganization): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.slug)) {
    throw new InvalidOrganizationInputError('slug must be lowercase letters, digits and hyphens.');
  }
  if (input.name.trim().length === 0 || input.name.length > 200) {
    throw new InvalidOrganizationInputError('name must be 1-200 characters.');
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new InvalidOrganizationInputError('timeZone must be an IANA time zone.');
  }
  const days = new Set(input.workWeek);
  if (
    days.size === 0 ||
    days.size !== input.workWeek.length ||
    [...days].some((d) => !Number.isInteger(d) || d < 1 || d > 7)
  ) {
    throw new InvalidOrganizationInputError('workWeek must list distinct ISO weekdays (1-7).');
  }
}

/**
 * Materializes the code-defined system role templates into one organization (ADR-0012). Existing
 * roles (matched by key) are left untouched so organization customizations are never overwritten.
 */
export async function materializeSystemRoles(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<{ roleIds: Record<SystemRoleKey, string>; created: SystemRoleKey[] }> {
  const existing = await tx.role.findMany({
    where: { organizationId, key: { in: [...SYSTEM_ROLE_KEYS] } },
    select: { id: true, key: true },
  });
  const byKey = new Map(existing.map((role) => [role.key, role.id]));
  const created: SystemRoleKey[] = [];
  const roleIds: Partial<Record<SystemRoleKey, string>> = {};

  for (const key of SYSTEM_ROLE_KEYS) {
    let roleId = byKey.get(key);
    if (roleId === undefined) {
      const template = SYSTEM_ROLE_TEMPLATES[key];
      const role = await tx.role.create({
        data: { organizationId, key, name: template.name, templateKey: key, isSystem: true },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: template.grants.map((grant) => ({
          organizationId,
          roleId: role.id,
          permissionKey: grant.permission,
          scope: grant.scope,
        })),
      });
      roleId = role.id;
      created.push(key);
    }
    roleIds[key] = roleId;
  }
  return { roleIds: roleIds as Record<SystemRoleKey, string>, created };
}

/**
 * Platform operation (ADR-0010): creates an organization with its system roles in one transaction
 * and records it in both the platform audit log and the new organization's audit log.
 */
export async function provisionOrganization(
  prisma: PrismaClient,
  input: NewOrganization,
  actor: PlatformAuditActor,
  context?: AuditRequestContext,
): Promise<ProvisionedOrganization> {
  validate(input);
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        slug: input.slug,
        name: input.name,
        timeZone: input.timeZone,
        workWeek: [...input.workWeek],
        defaultLocale: input.defaultLocale ?? 'en',
      },
      select: { id: true },
    });
    const { roleIds, created } = await materializeSystemRoles(tx, organization.id);

    await recordPlatformAudit(tx, {
      action: 'platform.organization.created',
      actor,
      targetOrganizationId: organization.id,
      metadata: { slug: input.slug, systemRoles: created },
      context,
    });
    const orgActor =
      actor.type === 'USER'
        ? { type: 'USER' as const, userId: actor.userId, memberId: null }
        : { type: 'SYSTEM' as const };
    await recordAudit(tx, organization.id, {
      action: 'organization.created',
      entityType: 'organization',
      entityId: organization.id,
      actor: orgActor,
      metadata: { slug: input.slug, timeZone: input.timeZone, workWeek: input.workWeek },
      context,
    });
    await recordAudit(tx, organization.id, {
      action: 'role.system_roles_materialized',
      entityType: 'organization',
      entityId: organization.id,
      actor: orgActor,
      metadata: { roles: created },
      context,
    });
    return { organizationId: organization.id, roleIds };
  });
}
