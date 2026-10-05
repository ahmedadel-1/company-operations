import { randomBytes } from 'node:crypto';

import { isPermissionKey, isScope } from '@company-ops/shared';
import type { Scope } from '@company-ops/shared';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockOrganizationForAdminChange } from '../../platform/db/sql/locks.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { scopesFor } from '../authorization/effective-permissions.js';
import {
  ADMIN_ROLE_KEY,
  assertMayGrantSensitiveCommercial,
  holdsAdminRole,
  isAdministratorEquivalent,
} from './administrators.js';
import type { RoleView } from './role-grant.service.js';

export interface RoleGrantInput {
  readonly key: string;
  readonly scope: string;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly permissions: readonly RoleGrantInput[];
}

export interface UpdateRoleInput {
  readonly name?: string | undefined;
  readonly permissions?: readonly RoleGrantInput[] | undefined;
}

interface LoadedRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly permissions: readonly { readonly key: string; readonly scope: Scope }[];
}

const grantKey = (grant: { key: string; scope: string }): string => `${grant.key}:${grant.scope}`;

/**
 * Custom roles and editable grants (P9-8, ADR-0012, SECURITY §2.3). Rules, enforced in one transaction
 * holding the organization's admin-change lock (the same lock as role grants):
 * - `role.manage` at ORG scope;
 * - the ORG_ADMIN role is immutable (it is the recovery path for every other role);
 * - a role that is, or would become, administrator-equivalent (carries `role.manage`) is created or
 *   changed only by ORG_ADMIN holders;
 * - nobody edits a role they hold themselves (no self-escalation);
 * - a sensitive commercial permission is added only by ORG_ADMIN holders or by someone holding it
 *   organization-wide (ADR-0026);
 * - system roles keep their name and cannot be deleted; their grants are editable;
 * - a custom role is deleted only while no member, request type or approval step references it;
 * - grants are validated against the code-defined catalog and scopes.
 * Every change bumps `authz_version` of the role's holders (sessions reload permissions on the next
 * request) and is audited with the added and removed grants.
 */
export class RoleAdminService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async create(action: ActionContext, input: CreateRoleInput): Promise<RoleView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertOrgWideRoleManagement(action);
    const name = normalizeName(input.name);
    const permissions = normalizeGrants(input.permissions);
    return this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      await this.assertMayTouchAdministratorRoles(tx, action, organizationId, permissions);
      await assertMayGrantSensitiveCommercial(
        tx,
        action,
        organizationId,
        permissions.map((grant) => grant.key),
      );
      await assertNameAvailable(tx, organizationId, name, null);
      const role = await tx.role.create({
        data: { organizationId, key: `CUSTOM_${randomBytes(5).toString('hex').toUpperCase()}`, name, isSystem: false },
        select: { id: true },
      });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((grant) => ({
            organizationId,
            roleId: role.id,
            permissionKey: grant.key,
            scope: grant.scope,
          })),
        });
      }
      await recordAudit(tx, organizationId, {
        action: 'role.created',
        entityType: 'role',
        entityId: role.id,
        actor: userActor(action),
        metadata: { name, added: permissions.map(grantKey) },
        context: action.request,
      });
      return view(await loadRole(tx, organizationId, role.id));
    });
  }

  async update(action: ActionContext, roleId: string, input: UpdateRoleInput): Promise<RoleView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertOrgWideRoleManagement(action);
    if (input.name === undefined && input.permissions === undefined) {
      throw new InvalidInputError('name', 'Change the name or the permissions.');
    }
    const name = input.name === undefined ? undefined : normalizeName(input.name);
    const permissions = input.permissions === undefined ? undefined : normalizeGrants(input.permissions);
    return this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      const role = await loadRole(tx, organizationId, roleId);
      await this.assertEditable(tx, action, organizationId, role);
      if (permissions !== undefined) {
        await this.assertMayTouchAdministratorRoles(tx, action, organizationId, permissions);
      }
      if (name !== undefined && name !== role.name) {
        if (role.isSystem) {
          throw new ForbiddenError('System roles keep their name.');
        }
        await assertNameAvailable(tx, organizationId, name, role.id);
        await tx.role.update({
          where: { organizationId_id: { organizationId, id: role.id } },
          data: { name },
          select: { id: true },
        });
      }
      const before = new Set(role.permissions.map(grantKey));
      const after = new Set((permissions ?? role.permissions).map(grantKey));
      const added = (permissions ?? []).filter((grant) => !before.has(grantKey(grant)));
      const removed = role.permissions.filter((grant) => !after.has(grantKey(grant)));
      await assertMayGrantSensitiveCommercial(
        tx,
        action,
        organizationId,
        added.map((grant) => grant.key),
      );
      for (const grant of removed) {
        await tx.rolePermission.deleteMany({
          where: { organizationId, roleId: role.id, permissionKey: grant.key, scope: grant.scope },
        });
      }
      if (added.length > 0) {
        await tx.rolePermission.createMany({
          data: added.map((grant) => ({
            organizationId,
            roleId: role.id,
            permissionKey: grant.key,
            scope: grant.scope,
          })),
        });
      }
      if (added.length > 0 || removed.length > 0) {
        await bumpHolders(tx, organizationId, role.id);
      }
      if (added.length > 0 || removed.length > 0 || (name !== undefined && name !== role.name)) {
        await recordAudit(tx, organizationId, {
          action: 'role.updated',
          entityType: 'role',
          entityId: role.id,
          actor: userActor(action),
          metadata: {
            ...(name !== undefined && name !== role.name ? { name } : {}),
            added: added.map(grantKey),
            removed: removed.map(grantKey),
          },
          context: action.request,
        });
      }
      return view(await loadRole(tx, organizationId, role.id));
    });
  }

  async delete(action: ActionContext, roleId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertOrgWideRoleManagement(action);
    await this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      const role = await loadRole(tx, organizationId, roleId);
      if (role.isSystem) {
        throw new ForbiddenError('System roles cannot be deleted.');
      }
      await this.assertEditable(tx, action, organizationId, role);
      // Sequential: one transaction connection.
      const members = await tx.memberRole.count({ where: { organizationId, roleId: role.id } });
      const requestTypes = await tx.requestTypeRole.count({ where: { organizationId, roleId: role.id } });
      const steps = await tx.workflowStep.count({ where: { organizationId, approverRoleId: role.id } });
      if (members + requestTypes + steps > 0) {
        throw new ConflictError(
          `The role is still in use (${String(members)} member(s), ${String(requestTypes)} request type(s), ${String(steps)} approval step(s)).`,
        );
      }
      await tx.role.delete({ where: { organizationId_id: { organizationId, id: role.id } } });
      await recordAudit(tx, organizationId, {
        action: 'role.deleted',
        entityType: 'role',
        entityId: role.id,
        actor: userActor(action),
        metadata: { name: role.name, removed: role.permissions.map(grantKey) },
        context: action.request,
      });
    });
  }

  private assertOrgWideRoleManagement(action: ActionContext): void {
    if (!scopesFor(action.principal.permissions, 'role.manage').includes('ORG')) {
      throw new ForbiddenError();
    }
  }

  private async assertEditable(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    role: LoadedRole,
  ): Promise<void> {
    if (role.key === ADMIN_ROLE_KEY) {
      throw new ForbiddenError('The organization admin role cannot be changed.');
    }
    const holds = await tx.memberRole.findFirst({
      where: { organizationId, roleId: role.id, memberId: action.principal.memberId },
      select: { id: true },
    });
    if (holds !== null) {
      throw new ForbiddenError('You cannot change a role you hold.');
    }
    await this.assertMayTouchAdministratorRoles(tx, action, organizationId, role.permissions);
  }

  private async assertMayTouchAdministratorRoles(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    permissions: readonly { key: string }[],
  ): Promise<void> {
    const adminEquivalent = isAdministratorEquivalent({
      key: '',
      permissionKeys: permissions.map((grant) => grant.key),
    });
    if (adminEquivalent && !(await holdsAdminRole(tx, organizationId, action.principal.memberId))) {
      throw new ForbiddenError('Only organization admins can change administrator roles.');
    }
  }
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > 80) {
    throw new InvalidInputError('name', 'The role name must have 1 to 80 characters.');
  }
  return name;
}

function normalizeGrants(grants: readonly RoleGrantInput[]): { key: string; scope: Scope }[] {
  const seen = new Set<string>();
  const result: { key: string; scope: Scope }[] = [];
  for (const grant of grants) {
    if (!isPermissionKey(grant.key) || !isScope(grant.scope)) {
      throw new InvalidInputError('permissions', `Unknown permission or scope: ${grant.key} (${grant.scope}).`);
    }
    if (!seen.has(grantKey(grant))) {
      seen.add(grantKey(grant));
      result.push({ key: grant.key, scope: grant.scope });
    }
  }
  return result.sort((a, b) => grantKey(a).localeCompare(grantKey(b)));
}

async function assertNameAvailable(
  tx: TenantDb,
  organizationId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await tx.role.findFirst({
    where: {
      organizationId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId === null ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (clash !== null) {
    throw new ConflictError('A role with this name already exists.');
  }
}

async function loadRole(tx: TenantDb, organizationId: string, roleId: string): Promise<LoadedRole> {
  const role = await tx.role.findFirst({
    where: { organizationId, id: roleId },
    select: {
      id: true,
      key: true,
      name: true,
      isSystem: true,
      permissions: {
        select: { permissionKey: true, scope: true },
        orderBy: [{ permissionKey: 'asc' }, { scope: 'asc' }],
      },
    },
  });
  if (role === null) {
    throw new NotFoundError('Role');
  }
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    isSystem: role.isSystem,
    permissions: role.permissions.map((grant) => ({ key: grant.permissionKey, scope: grant.scope })),
  };
}

async function bumpHolders(tx: TenantDb, organizationId: string, roleId: string): Promise<void> {
  await tx.organizationMember.updateMany({
    where: { organizationId, roles: { some: { roleId } } },
    data: { authzVersion: { increment: 1 } },
  });
}

function view(role: LoadedRole): RoleView {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    isSystem: role.isSystem,
    administratorEquivalent: isAdministratorEquivalent({
      key: role.key,
      permissionKeys: role.permissions.map((grant) => grant.key),
    }),
    permissions: role.permissions,
  };
}
