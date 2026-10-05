import type { EmploymentStatus, MemberStatus, Prisma, ProjectRole } from '@company-ops/db';
import { isPermissionKey } from '@company-ops/shared';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { fromDateOnly, localToday, toDateOnly } from './business-date.js';
import {
  assertNotArchived,
  assertProjectPermission,
  holdsOrgWide,
  loadVisibleProject,
  projectCalendar,
} from './project-access.js';
import type { LoadedProject } from './project-access.js';
import { recordProjectActivity } from './project-activity.js';

export interface ProjectMemberView {
  readonly employeeId: string;
  readonly fullName: string;
  readonly employeeNumber: string;
  readonly jobTitle: string | null;
  /** History stays visible: disabled or terminated people keep their row with this status. */
  readonly memberStatus: MemberStatus;
  readonly employmentStatus: EmploymentStatus;
  readonly projectRole: ProjectRole;
  readonly allocationPercent: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly addedAt: string;
}

export interface ProjectMemberInput {
  readonly projectRole?: ProjectRole | undefined;
  readonly allocationPercent?: number | null | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | null | undefined;
}

/** Project roles that carry management of the project; appointing them needs ORG scope. */
export const MANAGER_PROJECT_ROLES: readonly ProjectRole[] = ['PROJECT_MANAGER', 'TECHNICAL_MANAGER'];

const MAX_PROJECT_MEMBERS = 500;

const memberSelect = {
  id: true,
  projectRole: true,
  allocationPercent: true,
  startDate: true,
  endDate: true,
  createdAt: true,
  profile: {
    select: {
      id: true,
      memberId: true,
      fullName: true,
      employeeNumber: true,
      employmentStatus: true,
      jobTitle: { select: { name: true } },
      member: { select: { status: true } },
    },
  },
} satisfies Prisma.ProjectMemberSelect;

type MemberRow = Prisma.ProjectMemberGetPayload<{ select: typeof memberSelect }>;

const toView = (row: MemberRow): ProjectMemberView => ({
  employeeId: row.profile.id,
  fullName: row.profile.fullName,
  employeeNumber: row.profile.employeeNumber,
  jobTitle: row.profile.jobTitle?.name ?? null,
  memberStatus: row.profile.member.status,
  employmentStatus: row.profile.employmentStatus,
  projectRole: row.projectRole,
  allocationPercent: row.allocationPercent,
  startDate: toDateOnly(row.startDate) ?? '',
  endDate: toDateOnly(row.endDate),
  addedAt: row.createdAt.toISOString(),
});

/**
 * Project membership (P2-3). Listing needs the project to be visible; changes need
 * `project.assign_members` on the project. Membership grants PROJECT reach, so assigners scoped to
 * the project (rather than the organization) are restricted to prevent privilege escalation:
 * they cannot appoint or change manager roles, cannot add or change themselves, and cannot add an
 * employee whose PROJECT-scoped grants exceed what the assigner holds on this project.
 */
export class ProjectMemberService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, projectId: string): Promise<ProjectMemberView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    const rows = await this.db.projectMember.findMany({
      where: { organizationId, projectId: project.id },
      orderBy: [{ profile: { fullName: 'asc' } }, { id: 'asc' }],
      take: MAX_PROJECT_MEMBERS,
      select: memberSelect,
    });
    return rows.map(toView);
  }

  async add(
    action: ActionContext,
    projectId: string,
    input: ProjectMemberInput & { employeeId: string; projectRole: ProjectRole },
  ): Promise<ProjectMemberView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await this.loadAssignable(tx, action, organizationId, projectId);
      const orgWide = holdsOrgWide(action.principal, 'project.assign_members');
      this.assertRoleAssignable(orgWide, input.projectRole);
      const profile = await tx.employeeProfile.findFirst({
        where: { organizationId, id: input.employeeId },
        select: { id: true, memberId: true, employmentStatus: true, member: { select: { status: true } } },
      });
      if (profile === null) {
        throw new NotFoundError('Employee');
      }
      if (profile.member.status === 'DISABLED' || profile.employmentStatus === 'TERMINATED') {
        throw new InvalidInputError('employeeId', 'Disabled or terminated employees cannot be assigned to projects.');
      }
      if (!orgWide) {
        this.assertNotSelf(action, profile.memberId);
        await this.assertGrantsCovered(tx, action, organizationId, project, profile.memberId);
      }
      const calendar = await projectCalendar(tx, organizationId, project);
      const startDate = input.startDate ?? localToday(new Date(), calendar.timeZone);
      assertDateOrder(startDate, input.endDate ?? null);
      const row = await tx.projectMember.create({
        data: {
          organizationId,
          projectId: project.id,
          profileId: profile.id,
          projectRole: input.projectRole,
          allocationPercent: input.allocationPercent ?? null,
          startDate: fromDateOnly(startDate),
          endDate: input.endDate == null ? null : fromDateOnly(input.endDate),
          addedByMemberId: action.principal.memberId,
        },
        select: memberSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'project.member_added',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { employeeId: profile.id, projectRole: input.projectRole },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.member_added',
        entityType: 'employee',
        entityId: profile.id,
        summaryParams: { employeeName: row.profile.fullName, projectRole: input.projectRole },
      });
      if (profile.memberId !== action.principal.memberId) {
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'notification.requested',
          aggregateType: 'project',
          aggregateId: project.id,
          payload: {
            recipientMemberId: profile.memberId,
            type: 'PROJECT_MEMBER_ADDED',
            severity: 'INFO',
            entityType: 'project',
            entityId: project.id,
            params: { projectCode: project.row.code, projectName: project.row.name, projectRole: input.projectRole },
            dedupeKey: `project-member-added:${project.id}:${row.id}`,
          },
        });
      }
      return toView(row);
    });
  }

  async update(
    action: ActionContext,
    projectId: string,
    employeeId: string,
    input: ProjectMemberInput,
  ): Promise<ProjectMemberView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await this.loadAssignable(tx, action, organizationId, projectId);
      const current = await this.loadMembership(tx, organizationId, project.id, employeeId);
      const orgWide = holdsOrgWide(action.principal, 'project.assign_members');
      this.assertRoleAssignable(orgWide, current.projectRole);
      if (input.projectRole !== undefined) {
        this.assertRoleAssignable(orgWide, input.projectRole);
      }
      if (!orgWide) {
        this.assertNotSelf(action, current.profile.memberId);
      }
      assertDateOrder(
        input.startDate ?? toDateOnly(current.startDate) ?? '',
        input.endDate === undefined ? toDateOnly(current.endDate) : input.endDate,
      );
      const data: Prisma.ProjectMemberUncheckedUpdateInput = {};
      if (input.projectRole !== undefined) data.projectRole = input.projectRole;
      if (input.allocationPercent !== undefined) data.allocationPercent = input.allocationPercent;
      if (input.startDate !== undefined) data.startDate = fromDateOnly(input.startDate);
      if (input.endDate !== undefined) data.endDate = input.endDate === null ? null : fromDateOnly(input.endDate);
      if (Object.keys(data).length === 0) {
        return toView(current);
      }
      const row = await tx.projectMember.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data,
        select: memberSelect,
      });
      const roleChanged = input.projectRole !== undefined && input.projectRole !== current.projectRole;
      await recordAudit(tx, organizationId, {
        action: 'project.member_updated',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: {
          employeeId: current.profile.id,
          fields: Object.keys(data).sort(),
          ...(roleChanged ? { fromRole: current.projectRole, toRole: row.projectRole } : {}),
        },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: roleChanged ? 'project.member_role_changed' : 'project.member_updated',
        entityType: 'employee',
        entityId: current.profile.id,
        summaryParams: {
          employeeName: current.profile.fullName,
          projectRole: row.projectRole,
          ...(roleChanged ? { fromRole: current.projectRole } : {}),
        },
      });
      return toView(row);
    });
  }

  /** Removes the membership row; history stays in the audit log, the timeline and submitted reports. */
  async remove(action: ActionContext, projectId: string, employeeId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.write(async (tx) => {
      const project = await this.loadAssignable(tx, action, organizationId, projectId);
      const current = await this.loadMembership(tx, organizationId, project.id, employeeId);
      const orgWide = holdsOrgWide(action.principal, 'project.assign_members');
      this.assertRoleAssignable(orgWide, current.projectRole);
      if (!orgWide) {
        this.assertNotSelf(action, current.profile.memberId);
      }
      await tx.projectMember.deleteMany({ where: { organizationId, id: current.id } });
      await recordAudit(tx, organizationId, {
        action: 'project.member_removed',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { employeeId: current.profile.id, projectRole: current.projectRole },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.member_removed',
        entityType: 'employee',
        entityId: current.profile.id,
        summaryParams: { employeeName: current.profile.fullName, projectRole: current.projectRole },
      });
    });
  }

  private async loadAssignable(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    projectId: string,
  ): Promise<LoadedProject> {
    const project = await loadVisibleProject(db, action, organizationId, projectId);
    assertProjectPermission(action, 'project.assign_members', project);
    assertNotArchived(project);
    return project;
  }

  private async loadMembership(
    db: TenantDb,
    organizationId: string,
    projectId: string,
    employeeId: string,
  ): Promise<MemberRow> {
    const row = await db.projectMember.findFirst({
      where: { organizationId, projectId, profileId: employeeId },
      select: memberSelect,
    });
    if (row === null) {
      throw new NotFoundError('Project member');
    }
    return row;
  }

  private assertRoleAssignable(orgWide: boolean, role: ProjectRole): void {
    if (!orgWide && MANAGER_PROJECT_ROLES.includes(role)) {
      throw new ForbiddenError('Only organization-wide administrators can manage project manager roles.');
    }
  }

  private assertNotSelf(action: ActionContext, targetMemberId: string): void {
    if (targetMemberId === action.principal.memberId) {
      throw new ForbiddenError('You cannot change your own project membership.');
    }
  }

  /**
   * Joining the project activates the target's PROJECT-scoped grants on it. A project-scoped
   * assigner may only do that when they hold each of those permissions on this project themselves.
   */
  private async assertGrantsCovered(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    project: LoadedProject,
    targetMemberId: string,
  ): Promise<void> {
    const grants = await db.rolePermission.findMany({
      where: { organizationId, scope: 'PROJECT', role: { memberRoles: { some: { memberId: targetMemberId } } } },
      select: { permissionKey: true },
    });
    for (const { permissionKey } of grants) {
      if (isPermissionKey(permissionKey) && !canAccessResource(action.principal, permissionKey, project.facts)) {
        throw new ForbiddenError('This employee would gain project permissions that you do not hold.');
      }
    }
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('The employee is already a member of this project.');
      }
      throw error;
    }
  }
}

function assertDateOrder(start: string, end: string | null): void {
  if (end !== null && end < start) {
    throw new InvalidInputError('endDate', 'The end date cannot be before the start date.');
  }
}
