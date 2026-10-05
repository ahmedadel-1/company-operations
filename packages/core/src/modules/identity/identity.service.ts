import { MemberStatus, OrgStatus } from '@company-ops/db';
import type { PrismaClient } from '@company-ops/db';

import { computeEffectivePermissions } from '../authorization/effective-permissions.js';
import type { EffectivePermissions } from '../authorization/effective-permissions.js';

/** Identity asserted by a validated ID token. */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface MembershipSummary {
  readonly memberId: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
}

/** Everything a session needs about the member in its active organization. */
export interface MemberPrincipal {
  readonly memberId: string;
  readonly organizationId: string;
  readonly authzVersion: number;
  readonly roleKeys: readonly string[];
  readonly permissions: EffectivePermissions;
}

export interface MemberAuthzState {
  readonly active: boolean;
  readonly authzVersion: number;
}

/**
 * Pre-tenant identity resolution (login, session load, organization switch). This is the one place
 * that reads membership rows before a tenant context exists, so it uses the base client: every
 * query is bound to the authenticated user id and, where tenant rows are read, to an explicit
 * organization id as well. It never lists data of organizations the user is not a member of.
 */
export class IdentityService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Creates or refreshes the global user keyed by (issuer, subject); email is profile data only. */
  async upsertUser(identity: VerifiedIdentity, now: Date = new Date()): Promise<{ id: string }> {
    return this.prisma.user.upsert({
      where: { idpIssuer_idpSubject: { idpIssuer: identity.issuer, idpSubject: identity.subject } },
      create: {
        idpIssuer: identity.issuer,
        idpSubject: identity.subject,
        email: identity.email,
        displayName: identity.displayName,
        lastLoginAt: now,
      },
      update: { email: identity.email, displayName: identity.displayName, lastLoginAt: now },
      select: { id: true },
    });
  }

  async getUser(userId: string): Promise<{ id: string; displayName: string; email: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, email: true },
    });
  }

  /** Active memberships in active organizations, oldest first. */
  async listActiveMemberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { userId, status: MemberStatus.ACTIVE, organization: { status: OrgStatus.ACTIVE } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, organizationId: true, organization: { select: { slug: true, name: true } } },
    });
    return rows.map((row) => ({
      memberId: row.id,
      organizationId: row.organizationId,
      slug: row.organization.slug,
      name: row.organization.name,
    }));
  }

  /**
   * Loads the member's roles and effective permissions in one organization. Returns null unless the
   * membership and the organization are both ACTIVE.
   */
  async loadPrincipal(userId: string, organizationId: string): Promise<MemberPrincipal | null> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, status: MemberStatus.ACTIVE, organization: { status: OrgStatus.ACTIVE } },
      select: {
        id: true,
        organizationId: true,
        authzVersion: true,
        roles: {
          select: { role: { select: { key: true, permissions: { select: { permissionKey: true, scope: true } } } } },
        },
      },
    });
    if (member === null) {
      return null;
    }
    const roles = member.roles.map((grant) => grant.role);
    return {
      memberId: member.id,
      organizationId: member.organizationId,
      authzVersion: member.authzVersion,
      roleKeys: roles.map((role) => role.key).sort(),
      permissions: computeEffectivePermissions(roles.flatMap((role) => role.permissions)),
    };
  }

  /** Cheap per-request check: is the membership still usable, and have its grants changed? */
  async getMemberAuthzState(userId: string, organizationId: string, memberId: string): Promise<MemberAuthzState> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId, userId },
      select: { status: true, authzVersion: true, organization: { select: { status: true } } },
    });
    if (member === null) {
      return { active: false, authzVersion: -1 };
    }
    return {
      active: member.status === MemberStatus.ACTIVE && member.organization.status === OrgStatus.ACTIVE,
      authzVersion: member.authzVersion,
    };
  }

  async getOrganizationSummary(organizationId: string): Promise<{ id: string; slug: string; name: string } | null> {
    return this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, slug: true, name: true },
    });
  }
}
