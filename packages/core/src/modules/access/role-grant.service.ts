import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockOrganizationForAdminChange } from '../../platform/db/sql/locks.js';
import { ForbiddenError, NotFoundError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { scopesFor } from '../authorization/effective-permissions.js';
import {
  assertMayGrantSensitiveCommercial,
  assertNotLastAdministrator,
  holdsAdminRole,
  isAdministratorEquivalent,
} from './administrators.js';

export interface RoleGrantResult {
  readonly memberRoleId: string;
  readonly created: boolean;
}

export interface RoleView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly administratorEquivalent: boolean;
  readonly permissions: readonly { readonly key: string; readonly scope: string }[];
}

export interface MemberRoleView {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  readonly grantedAt: string;
  readonly grantedByMemberId: string | null;
}

/**
 * Role grants and revocations (P1-12, SECURITY §2.3). Escalation rules, all enforced inside one
 * transaction holding the organization's admin-change lock:
 * - `role.manage` must be held at ORG scope (roles are organization-wide);
 * - nobody changes their own grants;
 * - administrator-equivalent roles (ORG_ADMIN or any role carrying `role.manage`) are granted and
 *   revoked only by ORG_ADMIN holders;
 * - the last active ORG_ADMIN cannot lose the role;
 * - a role carrying a sensitive commercial permission is granted only by ORG_ADMIN holders or by
 *   someone holding that permission organization-wide (ADR-0026).
 * Both member and role ids are resolved in the active organization first (foreign ids are 404,
 * nothing written); composite foreign keys reject cross-organization links in the database too.
 * Every change bumps the member's `authz_version` (their sessions reload permissions on the next
 * request), is audited, and notifies the member through the outbox.
 */
export class RoleGrantService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async listRoles(action: ActionContext): Promise<RoleView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const roles = await this.db.role.findMany({
      where: { organizationId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        isSystem: true,
        permissions: { select: { permissionKey: true, scope: true }, orderBy: [{ permissionKey: 'asc' }] },
      },
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      isSystem: role.isSystem,
      administratorEquivalent: isAdministratorEquivalent({
        key: role.key,
        permissionKeys: role.permissions.map((p) => p.permissionKey),
      }),
      permissions: role.permissions.map((p) => ({ key: p.permissionKey, scope: p.scope })),
    }));
  }

  async listMemberRoles(action: ActionContext, memberId: string): Promise<MemberRoleView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const member = await this.db.organizationMember.findFirst({
      where: { organizationId, id: memberId },
      select: {
        roles: {
          orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
          select: { grantedAt: true, grantedByMemberId: true, role: { select: { id: true, key: true, name: true } } },
        },
      },
    });
    if (member === null) {
      throw new NotFoundError('Member');
    }
    return member.roles.map((grant) => ({
      roleId: grant.role.id,
      key: grant.role.key,
      name: grant.role.name,
      grantedAt: grant.grantedAt.toISOString(),
      grantedByMemberId: grant.grantedByMemberId,
    }));
  }

  async grant(action: ActionContext, memberId: string, roleId: string): Promise<RoleGrantResult> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertOrgWideRoleManagement(action);
    return this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      const { member, role } = await this.resolveTargets(tx, action, organizationId, memberId, roleId);
      const existing = await tx.memberRole.findFirst({
        where: { organizationId, memberId: member.id, roleId: role.id },
        select: { id: true },
      });
      if (existing !== null) {
        return { memberRoleId: existing.id, created: false };
      }
      await assertMayGrantSensitiveCommercial(tx, action, organizationId, role.permissionKeys);
      const grant = await tx.memberRole.create({
        data: { organizationId, memberId: member.id, roleId: role.id, grantedByMemberId: action.principal.memberId },
        select: { id: true },
      });
      await this.afterChange(tx, action, organizationId, member.id, role, 'role.granted', grant.id);
      return { memberRoleId: grant.id, created: true };
    });
  }

  async revoke(action: ActionContext, memberId: string, roleId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertOrgWideRoleManagement(action);
    await this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      const { member, role } = await this.resolveTargets(tx, action, organizationId, memberId, roleId);
      const existing = await tx.memberRole.findFirst({
        where: { organizationId, memberId: member.id, roleId: role.id },
        select: { id: true },
      });
      if (existing === null) {
        throw new NotFoundError('Role grant');
      }
      if (role.key === 'ORG_ADMIN') {
        await assertNotLastAdministrator(tx, organizationId, member.id);
      }
      await tx.memberRole.delete({ where: { organizationId_id: { organizationId, id: existing.id } } });
      await this.afterChange(tx, action, organizationId, member.id, role, 'role.revoked', existing.id);
    });
  }

  private assertOrgWideRoleManagement(action: ActionContext): void {
    if (!scopesFor(action.principal.permissions, 'role.manage').includes('ORG')) {
      throw new ForbiddenError();
    }
  }

  private async resolveTargets(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    memberId: string,
    roleId: string,
  ): Promise<{
    member: { id: string };
    role: { id: string; key: string; name: string; permissionKeys: readonly string[] };
  }> {
    const member = await tx.organizationMember.findFirst({
      where: { organizationId, id: memberId },
      select: { id: true },
    });
    if (member === null) {
      throw new NotFoundError('Member');
    }
    const role = await tx.role.findFirst({
      where: { organizationId, id: roleId },
      select: { id: true, key: true, name: true, permissions: { select: { permissionKey: true } } },
    });
    if (role === null) {
      throw new NotFoundError('Role');
    }
    if (member.id === action.principal.memberId) {
      throw new ForbiddenError('You cannot change your own roles.');
    }
    const adminEquivalent = isAdministratorEquivalent({
      key: role.key,
      permissionKeys: role.permissions.map((p) => p.permissionKey),
    });
    if (adminEquivalent && !(await holdsAdminRole(tx, organizationId, action.principal.memberId))) {
      throw new ForbiddenError('Only organization admins can change administrator roles.');
    }
    return {
      member,
      role: {
        id: role.id,
        key: role.key,
        name: role.name,
        permissionKeys: role.permissions.map((p) => p.permissionKey),
      },
    };
  }

  private async afterChange(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    memberId: string,
    role: { id: string; key: string; name: string },
    auditAction: 'role.granted' | 'role.revoked',
    grantId: string,
  ): Promise<void> {
    await tx.organizationMember.update({
      where: { organizationId_id: { organizationId, id: memberId } },
      data: { authzVersion: { increment: 1 } },
      select: { id: true },
    });
    await recordAudit(tx, organizationId, {
      action: auditAction,
      entityType: 'member',
      entityId: memberId,
      actor: userActor(action),
      metadata: { roleId: role.id, roleKey: role.key },
      context: action.request,
    });
    await enqueueOutboxEvent(tx, organizationId, {
      eventType: 'notification.requested',
      aggregateType: 'member',
      aggregateId: memberId,
      payload: {
        recipientMemberId: memberId,
        type: auditAction === 'role.granted' ? 'ROLE_GRANTED' : 'ROLE_REVOKED',
        severity: 'INFO',
        entityType: 'role',
        entityId: role.id,
        params: { roleName: role.name },
        dedupeKey: `${auditAction}:${grantId}`,
      },
    });
  }
}
