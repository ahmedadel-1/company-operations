import { MemberStatus, OrgStatus } from '@company-ops/db';
import type { PrismaClient } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import type { AuditRequestContext } from '../../platform/audit/audit-writer.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { hashInvitationToken, isWellFormedInvitationToken } from './invitation-token.js';

export type InvitationRedemption =
  | { readonly kind: 'accepted'; readonly organizationId: string; readonly memberId: string }
  | { readonly kind: 'invalid' };

/**
 * Redeems a single-use invitation for the identity that just authenticated (ADR-0012: identity is
 * bound by the token, never by email). Pre-tenant like `IdentityService`: the invitation is found by
 * its globally unique token hash, then every write is bound to that invitation's organization.
 * Unknown, expired, revoked, already-used tokens and users already in the organization all yield
 * `invalid` without revealing which.
 */
export class InvitationRedemptionService {
  constructor(private readonly prisma: PrismaClient) {}

  async redeem(
    token: string,
    userId: string,
    context: AuditRequestContext,
    now = new Date(),
  ): Promise<InvitationRedemption> {
    if (!isWellFormedInvitationToken(token)) {
      return { kind: 'invalid' };
    }
    const tokenHash = hashInvitationToken(token);
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.memberInvitation.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          memberId: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          createdByMemberId: true,
          member: { select: { status: true, userId: true } },
          organization: { select: { status: true } },
        },
      });
      if (invitation === null) {
        return { kind: 'invalid' };
      }
      if (
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null ||
        invitation.expiresAt <= now ||
        invitation.member.status !== MemberStatus.INVITED ||
        invitation.member.userId !== null ||
        invitation.organization.status !== OrgStatus.ACTIVE
      ) {
        return { kind: 'invalid' };
      }
      const { organizationId, memberId } = invitation;
      const existing = await tx.organizationMember.findFirst({
        where: { organizationId, userId },
        select: { id: true },
      });
      if (existing !== null) {
        return { kind: 'invalid' };
      }
      const claimed = await tx.memberInvitation.updateMany({
        where: { organizationId, id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now, acceptedByUserId: userId },
      });
      if (claimed.count !== 1) {
        return { kind: 'invalid' };
      }
      await tx.organizationMember.update({
        where: { organizationId_id: { organizationId, id: memberId } },
        data: { userId, status: MemberStatus.ACTIVE, authzVersion: { increment: 1 } },
        select: { id: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'member.invitation.accepted',
        entityType: 'member',
        entityId: memberId,
        actor: { type: 'USER', userId, memberId },
        metadata: { invitationId: invitation.id },
        context,
      });
      if (invitation.createdByMemberId !== null) {
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'notification.requested',
          aggregateType: 'member',
          aggregateId: memberId,
          payload: {
            recipientMemberId: invitation.createdByMemberId,
            type: 'INVITATION_ACCEPTED',
            severity: 'INFO',
            entityType: 'member',
            entityId: memberId,
            params: {},
            dedupeKey: `invitation.accepted:${invitation.id}`,
          },
        });
      }
      return { kind: 'accepted', organizationId, memberId };
    });
  }
}
