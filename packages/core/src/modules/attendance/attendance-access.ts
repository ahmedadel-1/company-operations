import type { Prisma } from '@company-ops/db';

import { fromDateOnly } from '../projects/business-date.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { canAccessResource, listScope } from '../authorization/policy.js';
import type { ListScope, ResourceFacts } from '../authorization/policy.js';
import { holdsOrgWide } from '../projects/project-access.js';

/**
 * Attendance visibility (ADR-0022, SECURITY §2): own records with `attendance.self`; others through
 * `attendance.team` evaluated by the policy engine — TEAM = reach team members, DEPARTMENT = the
 * employee's current department, PROJECT = employees with an active membership on a reached project,
 * ORG = everyone. Filters are applied in SQL; anything outside them is 404.
 */

/** Profile filter for a team scope; `null` when the scope reaches nobody. */
export function profileScopeWhere(scope: ListScope, today: string): Prisma.EmployeeProfileWhereInput | null {
  if (scope.all) return {};
  const or: Prisma.EmployeeProfileWhereInput[] = [];
  if (scope.memberIds.length > 0) or.push({ memberId: { in: [...scope.memberIds] } });
  if (scope.departmentIds.length > 0) or.push({ departmentId: { in: [...scope.departmentIds] } });
  if (scope.projectIds.length > 0) {
    const day = fromDateOnly(today);
    or.push({
      projectMemberships: {
        some: {
          projectId: { in: [...scope.projectIds] },
          startDate: { lte: day },
          OR: [{ endDate: null }, { endDate: { gte: day } }],
        },
      },
    });
  }
  return or.length === 0 ? null : { OR: or };
}

export function teamScope(action: ActionContext): ListScope {
  return listScope(action.principal, 'attendance.team');
}

/** Facts of one employee for resource-level checks (current department and active projects). */
export async function employeeFacts(
  db: TenantDb,
  organizationId: string,
  profileId: string,
  today: string,
): Promise<ResourceFacts | null> {
  const day = fromDateOnly(today);
  const profile = await db.employeeProfile.findFirst({
    where: { organizationId, id: profileId },
    select: {
      memberId: true,
      departmentId: true,
      projectMemberships: {
        where: { startDate: { lte: day }, OR: [{ endDate: null }, { endDate: { gte: day } }] },
        select: { projectId: true },
        take: 200,
      },
    },
  });
  if (profile === null) return null;
  return {
    organizationId,
    ownerMemberIds: [profile.memberId],
    subjectMemberIds: [profile.memberId],
    departmentIds: profile.departmentId === null ? [] : [profile.departmentId],
    projectIds: profile.projectMemberships.map((row) => row.projectId),
  };
}

export type AttendanceAccess = 'SELF' | 'TEAM' | 'NONE';

/** Whether the caller may see an employee's attendance, and why. */
export function accessTo(action: ActionContext, facts: ResourceFacts): AttendanceAccess {
  if (facts.ownerMemberIds?.includes(action.principal.memberId) === true) {
    return hasPermission(action.principal.permissions, 'attendance.self') ? 'SELF' : 'NONE';
  }
  return canAccessResource(action.principal, 'attendance.team', facts) ? 'TEAM' : 'NONE';
}

/** Reviews: `attendance.admin` organization-wide, or `attendance.team` in scope; never one's own evidence. */
export function canReview(action: ActionContext, facts: ResourceFacts): boolean {
  if (facts.ownerMemberIds?.includes(action.principal.memberId) === true) return false;
  return (
    holdsOrgWide(action.principal, 'attendance.admin') || canAccessResource(action.principal, 'attendance.team', facts)
  );
}

export function isAttendanceAdmin(action: ActionContext): boolean {
  return holdsOrgWide(action.principal, 'attendance.admin');
}
