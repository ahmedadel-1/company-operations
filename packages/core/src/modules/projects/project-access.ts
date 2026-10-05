import type { Prisma, ProjectStatus } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

import { ForbiddenError, InvalidTransitionError, NotFoundError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import type { ListScope, Principal, ResourceFacts } from '../authorization/policy.js';

const staffSelect = { memberId: true, departmentId: true } satisfies Prisma.EmployeeProfileSelect;

/** What every project authorization decision needs: lifecycle state plus who staffs the project. */
export const projectAccessSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  archivedAt: true,
  version: true,
  timeZone: true,
  startDate: true,
  dailyReportPolicy: true,
  projectManagerProfileId: true,
  technicalManagerProfileId: true,
  projectManager: { select: staffSelect },
  technicalManager: { select: staffSelect },
  members: { select: { profileId: true, projectRole: true, profile: { select: staffSelect } } },
} satisfies Prisma.ProjectSelect;

export type ProjectAccessRow = Prisma.ProjectGetPayload<{ select: typeof projectAccessSelect }>;

export interface LoadedProject {
  readonly row: ProjectAccessRow;
  readonly facts: ResourceFacts;
  readonly id: string;
}

/**
 * Scope facts of a project (SECURITY §2.1): PROJECT matches its id; SELF and TEAM match the members
 * who staff it (project members, PM, TM); DEPARTMENT matches the departments of those people.
 */
export function projectFacts(organizationId: string, row: ProjectAccessRow): ResourceFacts {
  const staff = [
    ...row.members.map((member) => member.profile),
    ...(row.projectManager === null ? [] : [row.projectManager]),
    ...(row.technicalManager === null ? [] : [row.technicalManager]),
  ];
  const memberIds = [...new Set(staff.map((person) => person.memberId))];
  const departmentIds = [
    ...new Set(staff.flatMap((person) => (person.departmentId === null ? [] : [person.departmentId]))),
  ];
  return {
    organizationId,
    projectIds: [row.id],
    ownerMemberIds: memberIds,
    subjectMemberIds: memberIds,
    departmentIds,
  };
}

/** True when the profile staffs the project (member, PM or TM). */
export function isProjectStaff(row: ProjectAccessRow, profileId: string): boolean {
  return (
    row.projectManagerProfileId === profileId ||
    row.technicalManagerProfileId === profileId ||
    row.members.some((member) => member.profileId === profileId)
  );
}

export async function loadProjectForAccess(
  db: TenantDb,
  organizationId: string,
  projectId: string,
): Promise<LoadedProject | null> {
  const row = await db.project.findFirst({ where: { organizationId, id: projectId }, select: projectAccessSelect });
  return row === null ? null : { row, facts: projectFacts(organizationId, row), id: row.id };
}

/** Loads a project the caller may view (`project.view` in scope); anything else is 404. */
export async function loadVisibleProject(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  projectId: string,
): Promise<LoadedProject> {
  const project = await loadProjectForAccess(db, organizationId, projectId);
  if (project === null || !canAccessResource(action.principal, 'project.view', project.facts)) {
    throw new NotFoundError('Project');
  }
  return project;
}

/** Visible but not permitted is 403 (SECURITY §2.2). */
export function assertProjectPermission(
  action: ActionContext,
  permission: PermissionKey,
  project: LoadedProject,
): void {
  if (!canAccessResource(action.principal, permission, project.facts)) {
    throw new ForbiddenError();
  }
}

/** The permission held at ORG scope (org-wide project administration). */
export function holdsOrgWide(principal: Principal, permission: PermissionKey): boolean {
  return canAccessResource(principal, permission, { organizationId: principal.organizationId });
}

export interface ProjectCalendar {
  /** The project's zone, or the organization's. */
  readonly timeZone: string;
  readonly workWeek: readonly number[];
}

/** Time zone and work week that business dates of the project are computed in (ARCHITECTURE §16). */
export async function projectCalendar(
  db: TenantDb,
  organizationId: string,
  project: { readonly row: { readonly timeZone: string | null } },
): Promise<ProjectCalendar> {
  const organization = await db.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: { timeZone: true, workWeek: true },
  });
  return { timeZone: project.row.timeZone ?? organization.timeZone, workWeek: organization.workWeek };
}

/** Archived projects are read-only history. */
export function assertNotArchived(project: { readonly row: { readonly status: ProjectStatus } }): void {
  if (project.row.status === 'ARCHIVED') {
    throw new InvalidTransitionError('The project is archived; restore it before making changes.');
  }
}

/**
 * The list scope of a project permission as a `where` fragment (AND-ed with the organization
 * binding by the caller). `null` = no restriction; `'none'` = no row can match.
 */
export function projectScopeWhere(scope: ListScope): Prisma.ProjectWhereInput | null | 'none' {
  if (scope.all) {
    return null;
  }
  const or: Prisma.ProjectWhereInput[] = [];
  if (scope.projectIds.length > 0) {
    or.push({ id: { in: [...scope.projectIds] } });
  }
  if (scope.memberIds.length > 0) {
    const memberIds = [...scope.memberIds];
    or.push(
      { members: { some: { profile: { memberId: { in: memberIds } } } } },
      { projectManager: { memberId: { in: memberIds } } },
      { technicalManager: { memberId: { in: memberIds } } },
    );
  }
  if (scope.departmentIds.length > 0) {
    const departmentIds = [...scope.departmentIds];
    or.push(
      { members: { some: { profile: { departmentId: { in: departmentIds } } } } },
      { projectManager: { departmentId: { in: departmentIds } } },
      { technicalManager: { departmentId: { in: departmentIds } } },
    );
  }
  return or.length === 0 ? 'none' : { OR: or };
}
