import type { EmploymentStatus } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { computeEffectivePermissions } from './effective-permissions.js';
import type { Principal } from './policy.js';
import { ScopeReachResolver } from './scope-reach.js';

/** Another member's authorization, for decisions made on their behalf (assignment, notification). */
export interface MemberAccess {
  readonly memberId: string;
  readonly userId: string;
  readonly employmentStatus: EmploymentStatus | null;
  readonly principal: Principal;
}

/**
 * Loads the effective permissions and scope reach of other members of the active organization,
 * exactly as their own sessions would compute them. Only ACTIVE members with a bound identity are
 * returned: invited or disabled members can neither be assigned work nor receive ticket details.
 * Used to keep assignment, watcher and notification targets inside each target's own ticket scope.
 */
export async function loadMemberAccess(
  db: TenantDb,
  organizationId: string,
  memberIds: readonly string[],
): Promise<Map<string, MemberAccess>> {
  const ids = [...new Set(memberIds)];
  const result = new Map<string, MemberAccess>();
  if (ids.length === 0) {
    return result;
  }
  const members = await db.organizationMember.findMany({
    where: { organizationId, id: { in: ids }, status: 'ACTIVE', userId: { not: null } },
    select: {
      id: true,
      userId: true,
      profile: { select: { employmentStatus: true } },
      roles: { select: { role: { select: { permissions: { select: { permissionKey: true, scope: true } } } } } },
    },
  });
  const reach = new ScopeReachResolver(db);
  for (const member of members) {
    if (member.userId === null) {
      continue;
    }
    const permissions = computeEffectivePermissions(member.roles.flatMap((grant) => grant.role.permissions));
    const principal = await reach.principal({
      userId: member.userId,
      memberId: member.id,
      organizationId,
      permissions,
    });
    result.set(member.id, {
      memberId: member.id,
      userId: member.userId,
      employmentStatus: member.profile?.employmentStatus ?? null,
      principal,
    });
  }
  return result;
}
