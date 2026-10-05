import { Logger, NotFoundException } from '@nestjs/common';

import {
  deserializePermissions,
  hasPermission,
  isMfaSatisfied,
  MFA_ACR,
  recordAudit,
  requiresMfaAtLogin,
  serializePermissions,
} from '@company-ops/core';
import type {
  AuditRequestContext,
  IdentityService,
  InvitationRedemptionService,
  MemberPrincipal,
  PrismaClient,
} from '@company-ops/core';
import { isPrivilegedPermission } from '@company-ops/shared';
import type { PermissionKey } from '@company-ops/shared';

import type { OidcService, OidcTransaction, ValidatedLogin } from './oidc/oidc.service.js';
import type { SessionStore } from './session/session.store.js';
import type { SessionRecord } from './session/session.types.js';

export type LoginOutcome =
  | { readonly kind: 'session'; readonly sessionId: string; readonly record: SessionRecord; readonly returnTo: string }
  /** The member's roles require MFA at login and the token's `acr` is lower: restart with acr=mfa. */
  | { readonly kind: 'mfa-required'; readonly preferredOrganizationId: string; readonly returnTo: string }
  | { readonly kind: 'rejected'; readonly reason: 'no_active_membership' | 'invitation_invalid' };

export type RequestSessionCheck =
  | { readonly kind: 'valid'; readonly record: SessionRecord }
  | { readonly kind: 'rotated'; readonly sessionId: string; readonly record: SessionRecord }
  | { readonly kind: 'invalid' };

export interface AuthPolicy {
  readonly mfaMaxAgeMs: number;
}

const sessionPrincipalFields = (principal: MemberPrincipal) => ({
  organizationId: principal.organizationId,
  memberId: principal.memberId,
  authzVersion: principal.authzVersion,
  roleKeys: [...principal.roleKeys],
  permissions: serializePermissions(principal.permissions),
});

/**
 * Session lifecycle on top of OIDC (SECURITY §3): login completion, MFA-at-login, organization
 * switch with rotation, per-request revalidation of membership and grants, and logout.
 */
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly identities: IdentityService,
    private readonly sessions: SessionStore,
    private readonly oidc: OidcService,
    private readonly invitations: InvitationRedemptionService,
    private readonly policy: AuthPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async completeLogin(
    login: ValidatedLogin,
    transaction: OidcTransaction,
    context: AuditRequestContext,
  ): Promise<LoginOutcome> {
    const user = await this.identities.upsertUser({
      issuer: login.issuer,
      subject: login.subject,
      email: login.email,
      displayName: login.displayName,
    });
    let preferredOrganizationId = transaction.preferredOrganizationId;
    if (transaction.invitationToken !== null) {
      // The invitee followed an invitation link: it is bound to whoever authenticated now (ADR-0012).
      const redemption = await this.invitations.redeem(transaction.invitationToken, user.id, context);
      if (redemption.kind === 'invalid') {
        this.logger.warn({ userId: user.id }, 'Login rejected: invitation invalid, expired or already used');
        return { kind: 'rejected', reason: 'invitation_invalid' };
      }
      preferredOrganizationId = redemption.organizationId;
    }
    const memberships = await this.identities.listActiveMemberships(user.id);
    const preferred = memberships.find((m) => m.organizationId === preferredOrganizationId);
    const target = preferred ?? memberships[0];
    const principal = target === undefined ? null : await this.identities.loadPrincipal(user.id, target.organizationId);
    if (principal === null) {
      this.logger.warn({ userId: user.id }, 'Login rejected: no active membership');
      return { kind: 'rejected', reason: 'no_active_membership' };
    }

    const mfaAuthenticatedAt = login.acr === MFA_ACR ? (login.authTime ?? this.now()) : null;
    if (requiresMfaAtLogin(principal.roleKeys) && mfaAuthenticatedAt === null) {
      return {
        kind: 'mfa-required',
        preferredOrganizationId: principal.organizationId,
        returnTo: transaction.returnTo,
      };
    }

    const { id, record } = await this.sessions.create({
      userId: user.id,
      ...sessionPrincipalFields(principal),
      acr: login.acr,
      mfaAuthenticatedAt,
      idpSessionId: login.idpSessionId,
      idToken: login.idToken,
    });
    await recordAudit(this.prisma, principal.organizationId, {
      action: transaction.purpose === 'step-up' ? 'auth.step_up.succeeded' : 'auth.login.succeeded',
      entityType: 'user',
      entityId: user.id,
      actor: { type: 'USER', userId: user.id, memberId: principal.memberId },
      metadata: { acr: login.acr, mfa: mfaAuthenticatedAt !== null },
      context,
    });
    return { kind: 'session', sessionId: id, record, returnTo: transaction.returnTo };
  }

  /**
   * Per-request check (SECURITY §3.3): the membership and organization must still be ACTIVE; when
   * the member's grants changed (`authz_version`), permissions are reloaded and the id rotated.
   */
  async revalidate(sessionId: string, record: SessionRecord): Promise<RequestSessionCheck> {
    const state = await this.identities.getMemberAuthzState(record.userId, record.organizationId, record.memberId);
    if (!state.active) {
      await this.sessions.destroy(sessionId, record);
      return { kind: 'invalid' };
    }
    if (state.authzVersion === record.authzVersion) {
      return { kind: 'valid', record };
    }
    const principal = await this.identities.loadPrincipal(record.userId, record.organizationId);
    if (principal === null) {
      await this.sessions.destroy(sessionId, record);
      return { kind: 'invalid' };
    }
    const rotated = await this.sessions.rotate(sessionId, record, sessionPrincipalFields(principal));
    return { kind: 'rotated', sessionId: rotated.id, record: rotated.record };
  }

  /**
   * Periodic check for long-lived streams: the session still exists and is not idle (without
   * refreshing it), the membership is active and the grants have not changed since the stream
   * opened. A stream that fails it is closed; the client reconnects through the normal guard.
   */
  async isStreamSessionCurrent(sessionId: string, record: SessionRecord): Promise<boolean> {
    const live = await this.sessions.peek(sessionId);
    if (live === null) {
      return false;
    }
    const state = await this.identities.getMemberAuthzState(record.userId, record.organizationId, record.memberId);
    return state.active && state.authzVersion === record.authzVersion;
  }

  /**
   * Validates the target against the user's own active memberships (never trusting the client),
   * then rotates the session. Unknown, foreign and inactive organizations are all 404.
   */
  async switchOrganization(
    sessionId: string,
    record: SessionRecord,
    organizationId: string,
    context: AuditRequestContext,
  ): Promise<{ sessionId: string; record: SessionRecord } | { mfaRequired: true }> {
    const principal = await this.identities.loadPrincipal(record.userId, organizationId);
    if (principal === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Organization was not found.' });
    }
    if (requiresMfaAtLogin(principal.roleKeys) && !this.mfaSatisfied(record)) {
      return { mfaRequired: true };
    }
    const previous = { organizationId: record.organizationId, memberId: record.memberId };
    const rotated = await this.sessions.rotate(sessionId, record, sessionPrincipalFields(principal));
    await recordAudit(this.prisma, principal.organizationId, {
      action: 'auth.organization.switched_in',
      entityType: 'member',
      entityId: principal.memberId,
      actor: { type: 'USER', userId: record.userId, memberId: principal.memberId },
      context,
    });
    if (previous.organizationId !== principal.organizationId) {
      await recordAudit(this.prisma, previous.organizationId, {
        action: 'auth.organization.switched_out',
        entityType: 'member',
        entityId: previous.memberId,
        actor: { type: 'USER', userId: record.userId, memberId: previous.memberId },
        context,
      });
    }
    return { sessionId: rotated.id, record: rotated.record };
  }

  async logout(sessionId: string, record: SessionRecord, context: AuditRequestContext): Promise<string> {
    const idToken = this.sessions.decryptIdToken(record);
    await this.sessions.destroy(sessionId, record);
    await recordAudit(this.prisma, record.organizationId, {
      action: 'auth.logout',
      entityType: 'user',
      entityId: record.userId,
      actor: { type: 'USER', userId: record.userId, memberId: record.memberId },
      context,
    });
    return this.oidc.buildLogoutUrl(idToken);
  }

  async backchannelLogout(idpSessionId: string, context: AuditRequestContext): Promise<number> {
    const removed = await this.sessions.destroyByIdpSession(idpSessionId);
    for (const record of removed) {
      await recordAudit(this.prisma, record.organizationId, {
        action: 'auth.logout.backchannel',
        entityType: 'user',
        entityId: record.userId,
        actor: { type: 'SYSTEM' },
        context,
      });
    }
    return removed.length;
  }

  mfaSatisfied(record: SessionRecord): boolean {
    return isMfaSatisfied(
      { acr: record.acr, mfaAuthenticatedAt: record.mfaAuthenticatedAt },
      this.now(),
      this.policy.mfaMaxAgeMs,
    );
  }

  /** `granted` = holds the permission at any scope; `mfa` = it is privileged and MFA is not fresh. */
  checkPermission(record: SessionRecord, permission: PermissionKey): { granted: boolean; mfaMissing: boolean } {
    const granted = hasPermission(deserializePermissions(record.permissions), permission);
    return { granted, mfaMissing: granted && isPrivilegedPermission(permission) && !this.mfaSatisfied(record) };
  }
}
