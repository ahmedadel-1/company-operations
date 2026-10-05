import { MemberStatus } from '@company-ops/db';
import { isPermissionKey, isSensitiveCommercialPermission } from '@company-ops/shared';

import { ForbiddenError, InvalidTransitionError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { scopesFor } from '../authorization/effective-permissions.js';

export const ADMIN_ROLE_KEY = 'ORG_ADMIN';

/**
 * A role is administrator-equivalent when it is ORG_ADMIN or carries `role.manage` (whoever holds
 * it can grant themselves anything). Only ORG_ADMIN holders may grant or revoke such roles.
 */
export function isAdministratorEquivalent(role: { key: string; permissionKeys: readonly string[] }): boolean {
  return role.key === ADMIN_ROLE_KEY || role.permissionKeys.includes('role.manage');
}

/** True when the member holds the ORG_ADMIN role (authoritative read inside the transaction). */
export async function holdsAdminRole(db: TenantDb, organizationId: string, memberId: string): Promise<boolean> {
  const grant = await db.memberRole.findFirst({
    where: { organizationId, memberId, role: { key: ADMIN_ROLE_KEY } },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Commercial anti-escalation (ADR-0026): a sensitive commercial or financial permission is handed out
 * (role grant, new role, added role grant) only by an ORG_ADMIN holder or by someone who holds that
 * permission organization-wide themselves.
 */
export async function assertMayGrantSensitiveCommercial(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  permissionKeys: readonly string[],
): Promise<void> {
  const missing = permissionKeys
    .filter(isPermissionKey)
    .filter(
      (key) => isSensitiveCommercialPermission(key) && !scopesFor(action.principal.permissions, key).includes('ORG'),
    );
  if (missing.length > 0 && !(await holdsAdminRole(db, organizationId, action.principal.memberId))) {
    throw new ForbiddenError('You cannot grant commercial or financial access you do not hold organization-wide.');
  }
}

/**
 * Refuses a change that would leave the organization without an ACTIVE ORG_ADMIN holder other
 * than `memberId`. Callers hold `lockOrganizationForAdminChange` for the transaction.
 */
export async function assertNotLastAdministrator(
  db: TenantDb,
  organizationId: string,
  memberId: string,
): Promise<void> {
  if (!(await holdsAdminRole(db, organizationId, memberId))) {
    return;
  }
  const others = await db.memberRole.count({
    where: {
      organizationId,
      memberId: { not: memberId },
      role: { key: ADMIN_ROLE_KEY },
      member: { status: MemberStatus.ACTIVE },
    },
  });
  if (others === 0) {
    throw new InvalidTransitionError('The organization must keep at least one active organization admin.');
  }
}
