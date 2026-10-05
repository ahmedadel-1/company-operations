import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { NormalizedData } from './engine/conditions.js';
import type { ApproverDirectory, EngineStep } from './engine/workflow.js';
import { eligibleApprovers } from './request-access.js';

const MAX_DEPARTMENT_DEPTH = 32;
const MAX_ROLE_HOLDERS = 1000;

/**
 * Loads the organization facts the engine needs to resolve approvers of `steps` for one requester,
 * all bound to the active organization. Only what the steps reference is read.
 */
export async function loadApproverDirectory(
  db: TenantDb,
  organizationId: string,
  requesterMemberId: string,
  steps: readonly EngineStep[],
  data: NormalizedData,
): Promise<ApproverDirectory> {
  const types = new Set(steps.map((step) => step.approverType));
  const profile = await db.employeeProfile.findFirst({
    where: { organizationId, memberId: requesterMemberId },
    select: { id: true, departmentId: true, manager: { select: { memberId: true } } },
  });

  const departmentManagerChain: (string | null)[] = [];
  if (types.has('DEPARTMENT_MANAGER') && profile?.departmentId != null) {
    let departmentId: string | null = profile.departmentId;
    const seen = new Set<string>();
    while (departmentId !== null && !seen.has(departmentId) && seen.size < MAX_DEPARTMENT_DEPTH) {
      seen.add(departmentId);
      const department: {
        parentDepartmentId: string | null;
        archivedAt: Date | null;
        manager: { memberId: string } | null;
      } | null = await db.department.findFirst({
        where: { organizationId, id: departmentId },
        select: { parentDepartmentId: true, archivedAt: true, manager: { select: { memberId: true } } },
      });
      if (department === null) break;
      departmentManagerChain.push(department.archivedAt === null ? (department.manager?.memberId ?? null) : null);
      departmentId = department.parentDepartmentId;
    }
  }

  let teamLeadMemberIds: string[] = [];
  if (types.has('TEAM_LEAD') && profile !== null) {
    const rows = await db.teamMember.findMany({
      where: { organizationId, profileId: profile.id, team: { archivedAt: null } },
      select: { team: { select: { lead: { select: { memberId: true } } } } },
      take: 100,
    });
    teamLeadMemberIds = rows.flatMap((row) => (row.team.lead === null ? [] : [row.team.lead.memberId]));
  }

  const projectIds = [
    ...new Set(
      steps
        .filter(
          (step) =>
            (step.approverType === 'PROJECT_MANAGER' || step.approverType === 'TECHNICAL_MANAGER') &&
            step.projectField !== null,
        )
        .map((step) => (step.projectField === null ? undefined : data[step.projectField]))
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
  const projects = new Map<string, { managerMemberId: string | null; technicalManagerMemberId: string | null }>();
  if (projectIds.length > 0) {
    const rows = await db.project.findMany({
      where: { organizationId, id: { in: projectIds }, archivedAt: null },
      select: {
        id: true,
        projectManager: { select: { memberId: true } },
        technicalManager: { select: { memberId: true } },
      },
    });
    for (const row of rows) {
      projects.set(row.id, {
        managerMemberId: row.projectManager?.memberId ?? null,
        technicalManagerMemberId: row.technicalManager?.memberId ?? null,
      });
    }
  }

  const roleIds = [
    ...new Set(
      steps.flatMap((step) =>
        step.approverType === 'ROLE' && step.approverRoleId !== null ? [step.approverRoleId] : [],
      ),
    ),
  ];
  const roleHolders = new Map<string, string[]>();
  if (roleIds.length > 0) {
    const rows = await db.memberRole.findMany({
      where: { organizationId, roleId: { in: roleIds } },
      select: { roleId: true, memberId: true },
      orderBy: { memberId: 'asc' },
      take: MAX_ROLE_HOLDERS,
    });
    for (const row of rows) {
      roleHolders.set(row.roleId, [...(roleHolders.get(row.roleId) ?? []), row.memberId]);
    }
  }

  const candidates = [
    profile?.manager?.memberId ?? null,
    ...departmentManagerChain,
    ...teamLeadMemberIds,
    ...[...projects.values()].flatMap((project) => [project.managerMemberId, project.technicalManagerMemberId]),
    ...[...roleHolders.values()].flat(),
    ...steps.map((step) => step.approverMemberId),
  ].filter((id): id is string => id !== null);

  return {
    requesterMemberId,
    directManagerMemberId: profile?.manager?.memberId ?? null,
    departmentManagerChain,
    teamLeadMemberIds,
    projects,
    roleHolders,
    eligibleMemberIds: await eligibleApprovers(db, organizationId, candidates),
  };
}
