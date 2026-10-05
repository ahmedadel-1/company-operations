import type {
  EmploymentStatus,
  MemberStatus,
  Prisma,
  ProjectHealth,
  ProjectRole,
  ProjectStatus,
} from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource, isEmptyListScope, listScope } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { employeeFacts } from '../people/employee.service.js';
import { isValidTimeZone } from '../organizations/provision-organization.js';
import { fromDateOnly, toDateOnly } from './business-date.js';
import { parseDailyReportPolicy } from './daily-report-policy.js';
import type { DailyReportPolicy } from './daily-report-policy.js';
import { REPORTING_STATUSES } from './missing-reports.js';
import {
  assertNotArchived,
  assertProjectPermission,
  holdsOrgWide,
  isProjectStaff,
  loadVisibleProject,
  projectScopeWhere,
} from './project-access.js';
import type { LoadedProject } from './project-access.js';
import { recordProjectActivity } from './project-activity.js';
import { ARCHIVABLE_STATUSES, canTransition, RESTORED_STATUS } from './project-lifecycle.js';

export interface PersonRef {
  readonly id: string;
  readonly fullName: string;
  readonly memberStatus: MemberStatus;
  readonly employmentStatus: EmploymentStatus;
}

export interface ProjectSummaryView {
  readonly id: string;
  readonly number: number;
  readonly code: string;
  readonly name: string;
  readonly customer: { readonly id: string; readonly name: string; readonly archived: boolean } | null;
  readonly status: ProjectStatus;
  readonly health: ProjectHealth;
  readonly startDate: string | null;
  readonly targetEndDate: string | null;
  readonly projectManager: PersonRef | null;
  readonly technicalManager: PersonRef | null;
  readonly memberCount: number;
  readonly updatedAt: string;
}

/** What the caller may do on this project (UX hints; every action is re-checked server-side). */
export interface ProjectAccess {
  readonly canManage: boolean;
  readonly canAssignMembers: boolean;
  readonly canAssignManagers: boolean;
  readonly canArchive: boolean;
  readonly canViewReports: boolean;
  readonly canSubmitReports: boolean;
}

export interface ProjectView extends ProjectSummaryView {
  readonly description: string | null;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly healthNote: string | null;
  readonly healthChangedAt: string | null;
  readonly timeZone: string | null;
  /** The project's zone, or the organization's when the project has none. */
  readonly effectiveTimeZone: string;
  readonly dailyReportPolicy: DailyReportPolicy;
  readonly notes: string | null;
  readonly archivedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly access: ProjectAccess;
}

export type ProjectSort = 'updatedAt:desc' | 'createdAt:desc' | 'name:asc' | 'name:desc' | 'code:asc' | 'code:desc';

export interface ProjectListFilter {
  readonly q?: string | undefined;
  readonly status?: readonly ProjectStatus[] | undefined;
  readonly health?: readonly ProjectHealth[] | undefined;
  readonly customerId?: string | undefined;
  /** Employee profile id of the project manager or technical manager. */
  readonly managerId?: string | undefined;
  /** `mine` = projects the caller staffs; `all` (default) = every project the caller may view. */
  readonly scope?: 'all' | 'mine' | undefined;
  /** Archived projects are hidden unless requested or filtered by status. */
  readonly includeArchived?: boolean | undefined;
  readonly sort?: ProjectSort | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ProjectDetailsInput {
  readonly name?: string | undefined;
  readonly code?: string | undefined;
  readonly description?: string | null | undefined;
  readonly customerId?: string | null | undefined;
  readonly startDate?: string | null | undefined;
  readonly targetEndDate?: string | null | undefined;
  readonly projectManagerId?: string | null | undefined;
  readonly technicalManagerId?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly dailyReportPolicy?: DailyReportPolicy | undefined;
}

export interface EmployeeProjectView {
  readonly project: ProjectSummaryView;
  /** The employee's role on the project: their membership role, or PM/TM when they manage it. */
  readonly roles: readonly ProjectRole[];
}

const personSelect = {
  id: true,
  fullName: true,
  employmentStatus: true,
  member: { select: { status: true } },
} satisfies Prisma.EmployeeProfileSelect;

const summarySelect = {
  id: true,
  number: true,
  code: true,
  name: true,
  status: true,
  health: true,
  startDate: true,
  targetEndDate: true,
  updatedAt: true,
  createdAt: true,
  customer: { select: { id: true, name: true, archivedAt: true } },
  projectManager: { select: personSelect },
  technicalManager: { select: personSelect },
  _count: { select: { members: true } },
} satisfies Prisma.ProjectSelect;

const detailSelect = {
  ...summarySelect,
  description: true,
  statusReason: true,
  statusChangedAt: true,
  healthNote: true,
  healthChangedAt: true,
  timeZone: true,
  dailyReportPolicy: true,
  notes: true,
  archivedAt: true,
  version: true,
} satisfies Prisma.ProjectSelect;

type SummaryRow = Prisma.ProjectGetPayload<{ select: typeof summarySelect }>;
type PersonRow = Prisma.EmployeeProfileGetPayload<{ select: typeof personSelect }>;

const toPerson = (row: PersonRow | null): PersonRef | null =>
  row === null
    ? null
    : { id: row.id, fullName: row.fullName, memberStatus: row.member.status, employmentStatus: row.employmentStatus };

function toSummary(row: SummaryRow): ProjectSummaryView {
  return {
    id: row.id,
    number: row.number,
    code: row.code,
    name: row.name,
    customer:
      row.customer === null
        ? null
        : { id: row.customer.id, name: row.customer.name, archived: row.customer.archivedAt !== null },
    status: row.status,
    health: row.health,
    startDate: toDateOnly(row.startDate),
    targetEndDate: toDateOnly(row.targetEndDate),
    projectManager: toPerson(row.projectManager),
    technicalManager: toPerson(row.technicalManager),
    memberCount: row._count.members,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SORTS: Readonly<
  Record<ProjectSort, { field: 'updatedAt' | 'createdAt' | 'name' | 'code'; dir: 'asc' | 'desc'; date: boolean }>
> = {
  'updatedAt:desc': { field: 'updatedAt', dir: 'desc', date: true },
  'createdAt:desc': { field: 'createdAt', dir: 'desc', date: true },
  'name:asc': { field: 'name', dir: 'asc', date: false },
  'name:desc': { field: 'name', dir: 'desc', date: false },
  'code:asc': { field: 'code', dir: 'asc', date: false },
  'code:desc': { field: 'code', dir: 'desc', date: false },
};

const MAX_CODE_ATTEMPTS = 1000;
const MAX_EMPLOYEE_PROJECTS = 200;

/**
 * The project list's filter (scope + filters, no cursor) as `where` fragments AND-ed with the
 * organization binding; `'none'` = nothing visible. Shared with the dashboard counts (ADR-0023).
 */
export function projectListWhere(
  principal: Principal,
  filter: Omit<ProjectListFilter, 'cursor' | 'limit' | 'sort'>,
): Prisma.ProjectWhereInput[] | 'none' {
  const scope = listScope(principal, 'project.view');
  const scopeWhere = isEmptyListScope(scope) ? 'none' : projectScopeWhere(scope);
  if (scopeWhere === 'none') {
    return 'none';
  }
  const and: Prisma.ProjectWhereInput[] = scopeWhere === null ? [] : [scopeWhere];
  if (filter.scope === 'mine') {
    const memberId = principal.memberId;
    and.push({
      OR: [
        { members: { some: { profile: { memberId } } } },
        { projectManager: { memberId } },
        { technicalManager: { memberId } },
      ],
    });
  }
  if (filter.status !== undefined && filter.status.length > 0) {
    and.push({ status: { in: [...filter.status] } });
  } else if (filter.includeArchived !== true) {
    and.push({ status: { not: 'ARCHIVED' } });
  }
  if (filter.health !== undefined && filter.health.length > 0) {
    and.push({ health: { in: [...filter.health] } });
  }
  if (filter.customerId !== undefined) {
    and.push({ customerId: filter.customerId });
  }
  if (filter.managerId !== undefined) {
    and.push({
      OR: [{ projectManagerProfileId: filter.managerId }, { technicalManagerProfileId: filter.managerId }],
    });
  }
  if (filter.q !== undefined && filter.q.trim() !== '') {
    const q = escapeLike(filter.q.trim());
    and.push({
      OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }],
    });
  }
  return and;
}

/**
 * Projects (P2-2). Reads are filtered by the `project.view` scope (out of scope = 404). Details,
 * status and health need `project.manage` on the project; appointing the project or technical
 * manager, and archive/restore, need `project.manage` at ORG scope. Every change is versioned
 * (optimistic concurrency), audited and recorded on the project timeline through the outbox.
 */
export class ProjectService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, filter: ProjectListFilter): Promise<Page<ProjectSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const size = pageSize(filter.limit);
    const and = projectListWhere(action.principal, filter);
    if (and === 'none') {
      return { items: [], nextCursor: null };
    }
    const sort = SORTS[filter.sort ?? 'updatedAt:desc'];
    if (filter.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(filter.cursor, 2);
      const key: Date | string = sort.date ? new Date(value) : value;
      if (key instanceof Date && Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      const beyond = sort.dir === 'desc' ? { lt: key } : { gt: key };
      const idBeyond = sort.dir === 'desc' ? { lt: id } : { gt: id };
      and.push({ OR: [{ [sort.field]: beyond }, { [sort.field]: key, id: idBeyond }] });
    }
    const rows = await this.db.project.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ [sort.field]: sort.dir }, { id: sort.dir }],
      take: size + 1,
      select: summarySelect,
    });
    const page = toPage(rows, size, (row) => [
      sort.date ? row[sort.field as 'updatedAt' | 'createdAt'].toISOString() : row[sort.field as 'name' | 'code'],
      row.id,
    ]);
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, projectId: string): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    return this.view(this.db, action, organizationId, project);
  }

  /** Projects an employee staffs, limited to the projects the caller may view. */
  async listForEmployee(action: ActionContext, employeeId: string): Promise<EmployeeProjectView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const profile = await this.db.employeeProfile.findFirst({
      where: { organizationId, id: employeeId },
      select: { id: true, memberId: true, departmentId: true },
    });
    if (
      profile === null ||
      !canAccessResource(action.principal, 'employee.view', employeeFacts(organizationId, profile))
    ) {
      throw new NotFoundError('Employee');
    }
    const scope = listScope(action.principal, 'project.view');
    const scopeWhere = isEmptyListScope(scope) ? 'none' : projectScopeWhere(scope);
    if (scopeWhere === 'none') {
      return [];
    }
    const rows = await this.db.project.findMany({
      where: {
        organizationId,
        AND: [
          ...(scopeWhere === null ? [] : [scopeWhere]),
          {
            OR: [
              { members: { some: { profileId: profile.id } } },
              { projectManagerProfileId: profile.id },
              { technicalManagerProfileId: profile.id },
            ],
          },
        ],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_EMPLOYEE_PROJECTS,
      select: {
        ...summarySelect,
        projectManagerProfileId: true,
        technicalManagerProfileId: true,
        members: { where: { profileId: profile.id }, select: { projectRole: true } },
      },
    });
    return rows.map((row) => {
      const roles = new Set<ProjectRole>(row.members.map((member) => member.projectRole));
      if (row.projectManagerProfileId === profile.id) roles.add('PROJECT_MANAGER');
      if (row.technicalManagerProfileId === profile.id) roles.add('TECHNICAL_MANAGER');
      return { project: toSummary(row), roles: [...roles] };
    });
  }

  async create(action: ActionContext, input: ProjectDetailsInput & { name: string }): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'project.create')) {
      throw new ForbiddenError();
    }
    assertDateOrder(input.startDate ?? null, input.targetEndDate ?? null);
    assertTimeZone(input.timeZone ?? null);
    return this.write(async (tx) => {
      await this.assertCustomer(tx, organizationId, input.customerId ?? null);
      await this.assertManager(tx, organizationId, 'projectManagerId', input.projectManagerId ?? null);
      await this.assertManager(tx, organizationId, 'technicalManagerId', input.technicalManagerId ?? null);
      const { number, code } = await this.allocateNumber(tx, organizationId, input.code);
      const created = await tx.project.create({
        data: {
          organizationId,
          number,
          code,
          name: input.name,
          description: input.description ?? null,
          customerId: input.customerId ?? null,
          startDate: input.startDate == null ? null : fromDateOnly(input.startDate),
          targetEndDate: input.targetEndDate == null ? null : fromDateOnly(input.targetEndDate),
          projectManagerProfileId: input.projectManagerId ?? null,
          technicalManagerProfileId: input.technicalManagerId ?? null,
          timeZone: input.timeZone ?? null,
          notes: input.notes ?? null,
          ...(input.dailyReportPolicy === undefined ? {} : { dailyReportPolicy: policyJson(input.dailyReportPolicy) }),
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true, version: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'project.created',
        entityType: 'project',
        entityId: created.id,
        actor: userActor(action),
        metadata: {
          code,
          number,
          customerId: input.customerId ?? null,
          projectManagerId: input.projectManagerId ?? null,
          technicalManagerId: input.technicalManagerId ?? null,
        },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, created.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.created',
        entityType: 'project',
        entityId: created.id,
        summaryParams: { code, name: input.name },
      });
      await this.notifyManagers(tx, action, organizationId, created.id, created.version, code, input.name, {
        projectManagerId: input.projectManagerId ?? null,
        technicalManagerId: input.technicalManagerId ?? null,
      });
      return this.reload(tx, action, organizationId, created.id);
    });
  }

  async update(
    action: ActionContext,
    projectId: string,
    expectedVersion: number,
    input: ProjectDetailsInput,
  ): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertTimeZone(input.timeZone ?? null);
    return this.write(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      assertProjectPermission(action, 'project.manage', project);
      assertNotArchived(project);
      const current = await tx.project.findFirstOrThrow({
        where: { organizationId, id: project.id },
        select: { customerId: true, startDate: true, targetEndDate: true },
      });
      const managersChanging =
        (input.projectManagerId !== undefined && input.projectManagerId !== project.row.projectManagerProfileId) ||
        (input.technicalManagerId !== undefined && input.technicalManagerId !== project.row.technicalManagerProfileId);
      if (managersChanging && !holdsOrgWide(action.principal, 'project.manage')) {
        throw new ForbiddenError('Only organization-wide project administrators can appoint project managers.');
      }
      assertDateOrder(
        input.startDate === undefined ? toDateOnly(current.startDate) : input.startDate,
        input.targetEndDate === undefined ? toDateOnly(current.targetEndDate) : input.targetEndDate,
      );
      if (input.customerId !== undefined && input.customerId !== current.customerId) {
        await this.assertCustomer(tx, organizationId, input.customerId);
      }
      const newManager =
        input.projectManagerId !== undefined && input.projectManagerId !== project.row.projectManagerProfileId
          ? input.projectManagerId
          : null;
      const newTechnicalManager =
        input.technicalManagerId !== undefined && input.technicalManagerId !== project.row.technicalManagerProfileId
          ? input.technicalManagerId
          : null;
      await this.assertManager(tx, organizationId, 'projectManagerId', newManager);
      await this.assertManager(tx, organizationId, 'technicalManagerId', newTechnicalManager);

      const data: Prisma.ProjectUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code;
      if (input.description !== undefined) data.description = input.description;
      if (input.customerId !== undefined) data.customerId = input.customerId;
      if (input.startDate !== undefined)
        data.startDate = input.startDate === null ? null : fromDateOnly(input.startDate);
      if (input.targetEndDate !== undefined)
        data.targetEndDate = input.targetEndDate === null ? null : fromDateOnly(input.targetEndDate);
      if (input.projectManagerId !== undefined) data.projectManagerProfileId = input.projectManagerId;
      if (input.technicalManagerId !== undefined) data.technicalManagerProfileId = input.technicalManagerId;
      if (input.timeZone !== undefined) data.timeZone = input.timeZone;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.dailyReportPolicy !== undefined) data.dailyReportPolicy = policyJson(input.dailyReportPolicy);
      const fields = Object.keys(data).sort();
      const version = await this.bumpVersion(tx, organizationId, project.id, expectedVersion, data);
      await recordAudit(tx, organizationId, {
        action: 'project.updated',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: {
          fields,
          ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
          ...(input.projectManagerId === undefined ? {} : { projectManagerId: input.projectManagerId }),
          ...(input.technicalManagerId === undefined ? {} : { technicalManagerId: input.technicalManagerId }),
        },
        context: action.request,
      });
      const name = input.name ?? project.row.name;
      const code = input.code ?? project.row.code;
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: managersChanging ? 'project.managers_changed' : 'project.updated',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { code, name, fields: fields.join(',') },
      });
      await this.notifyManagers(tx, action, organizationId, project.id, version, code, name, {
        projectManagerId: newManager,
        technicalManagerId: newTechnicalManager,
      });
      return this.reload(tx, action, organizationId, project.id);
    });
  }

  async setStatus(
    action: ActionContext,
    projectId: string,
    input: { status: ProjectStatus; reason?: string | null | undefined; version: number },
  ): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      assertProjectPermission(action, 'project.manage', project);
      assertNotArchived(project);
      const from = project.row.status;
      if (!canTransition(from, input.status)) {
        throw new InvalidTransitionError(`A project cannot move from ${from} to ${input.status}.`);
      }
      await this.bumpVersion(tx, organizationId, project.id, input.version, {
        status: input.status,
        statusReason: input.reason ?? null,
        statusChangedAt: new Date(),
      });
      await recordAudit(tx, organizationId, {
        action: 'project.status_changed',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { from, to: input.status, hasReason: (input.reason ?? null) !== null },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.status_changed',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { from, to: input.status, reason: input.reason ?? null },
      });
      return this.reload(tx, action, organizationId, project.id);
    });
  }

  /** Health is set manually with a reason; there is no automatic scoring. */
  async setHealth(
    action: ActionContext,
    projectId: string,
    input: { health: ProjectHealth; note: string; version: number },
  ): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      assertProjectPermission(action, 'project.manage', project);
      assertNotArchived(project);
      const current = await tx.project.findFirstOrThrow({
        where: { organizationId, id: project.id },
        select: { health: true },
      });
      await this.bumpVersion(tx, organizationId, project.id, input.version, {
        health: input.health,
        healthNote: input.note,
        healthChangedAt: new Date(),
      });
      await recordAudit(tx, organizationId, {
        action: 'project.health_changed',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { from: current.health, to: input.health },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.health_changed',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { from: current.health, to: input.health, note: input.note },
      });
      return this.reload(tx, action, organizationId, project.id);
    });
  }

  async archive(
    action: ActionContext,
    projectId: string,
    input: { version: number; reason?: string | null | undefined },
  ): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      if (!holdsOrgWide(action.principal, 'project.manage')) {
        throw new ForbiddenError();
      }
      const from = project.row.status;
      if (!ARCHIVABLE_STATUSES.includes(from)) {
        throw new InvalidTransitionError('Only planned, on-hold or completed projects can be archived.');
      }
      await this.bumpVersion(tx, organizationId, project.id, input.version, {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        statusReason: input.reason ?? null,
        statusChangedAt: new Date(),
      });
      await recordAudit(tx, organizationId, {
        action: 'project.archived',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { from },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.archived',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { from, reason: input.reason ?? null },
      });
      return this.reload(tx, action, organizationId, project.id);
    });
  }

  async restore(action: ActionContext, projectId: string, input: { version: number }): Promise<ProjectView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      if (!holdsOrgWide(action.principal, 'project.manage')) {
        throw new ForbiddenError();
      }
      if (project.row.status !== 'ARCHIVED') {
        throw new InvalidTransitionError('The project is not archived.');
      }
      await this.bumpVersion(tx, organizationId, project.id, input.version, {
        status: RESTORED_STATUS,
        archivedAt: null,
        statusReason: null,
        statusChangedAt: new Date(),
      });
      await recordAudit(tx, organizationId, {
        action: 'project.restored',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { to: RESTORED_STATUS },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.restored',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { to: RESTORED_STATUS },
      });
      return this.reload(tx, action, organizationId, project.id);
    });
  }

  /**
   * Applies `data` only when the stored version still equals `expected`, incrementing it; returns
   * the new version. A stale version is `409 VERSION_CONFLICT` and changes nothing.
   */
  private async bumpVersion(
    db: TenantDb,
    organizationId: string,
    projectId: string,
    expected: number,
    data: Prisma.ProjectUncheckedUpdateManyInput,
  ): Promise<number> {
    const result = await db.project.updateMany({
      where: { organizationId, id: projectId, version: expected },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new VersionConflictError('The project');
    }
    return expected + 1;
  }

  private async reload(db: TenantDb, action: ActionContext, organizationId: string, projectId: string) {
    const project = await loadVisibleProject(db, action, organizationId, projectId);
    return this.view(db, action, organizationId, project);
  }

  private async view(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    project: LoadedProject,
  ): Promise<ProjectView> {
    // Sequential: `db` may be an interactive transaction, which runs one query at a time.
    const row = await db.project.findFirstOrThrow({ where: { organizationId, id: project.id }, select: detailSelect });
    const organization = await db.organization.findFirstOrThrow({
      where: { id: organizationId },
      select: { timeZone: true },
    });
    const caller = await db.employeeProfile.findFirst({
      where: { organizationId, memberId: action.principal.memberId },
      select: { id: true },
    });
    const live = row.status !== 'ARCHIVED';
    const can = (permission: Parameters<typeof canAccessResource>[1]) =>
      canAccessResource(action.principal, permission, project.facts);
    return {
      ...toSummary(row),
      description: row.description,
      statusReason: row.statusReason,
      statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
      healthNote: row.healthNote,
      healthChangedAt: row.healthChangedAt?.toISOString() ?? null,
      timeZone: row.timeZone,
      effectiveTimeZone: row.timeZone ?? organization.timeZone,
      dailyReportPolicy: parseDailyReportPolicy(row.dailyReportPolicy),
      notes: row.notes,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      access: {
        canManage: live && can('project.manage'),
        canAssignMembers: live && can('project.assign_members'),
        canAssignManagers: live && holdsOrgWide(action.principal, 'project.manage'),
        canArchive: holdsOrgWide(action.principal, 'project.manage'),
        canViewReports: can('daily_report.view'),
        canSubmitReports:
          REPORTING_STATUSES.includes(row.status) &&
          can('daily_report.submit') &&
          caller !== null &&
          isProjectStaff(project.row, caller.id),
      },
    };
  }

  private async assertCustomer(db: TenantDb, organizationId: string, customerId: string | null): Promise<void> {
    if (customerId === null) {
      return;
    }
    const customer = await db.customer.findFirst({
      where: { organizationId, id: customerId },
      select: { archivedAt: true },
    });
    if (customer === null) {
      throw new NotFoundError('Customer');
    }
    if (customer.archivedAt !== null) {
      throw new InvalidInputError('customerId', 'Archived customers cannot be assigned to projects.');
    }
  }

  /** PM/TM must be an employee of this organization whose access is not disabled and who is not terminated. */
  private async assertManager(
    db: TenantDb,
    organizationId: string,
    field: 'projectManagerId' | 'technicalManagerId',
    profileId: string | null,
  ): Promise<void> {
    if (profileId === null) {
      return;
    }
    const profile = await db.employeeProfile.findFirst({
      where: { organizationId, id: profileId },
      select: { employmentStatus: true, member: { select: { status: true } } },
    });
    if (profile === null) {
      throw new NotFoundError('Employee');
    }
    if (profile.member.status === 'DISABLED' || profile.employmentStatus === 'TERMINATED') {
      throw new InvalidInputError(field, 'Disabled or terminated employees cannot manage projects.');
    }
  }

  /**
   * Next `PRJ` number; the code defaults to `PRJ-<number>`. Codes entered manually may already use
   * that pattern, so taken defaults are skipped (bounded) instead of failing on the unique key.
   */
  private async allocateNumber(
    db: TenantDb,
    organizationId: string,
    requestedCode: string | undefined,
  ): Promise<{ number: number; code: string }> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const number = Number(await nextCounterValue(db, organizationId, 'PRJ'));
      const code = requestedCode ?? `PRJ-${String(number)}`;
      if (requestedCode !== undefined) {
        return { number, code };
      }
      const taken = await db.project.findFirst({ where: { organizationId, code }, select: { id: true } });
      if (taken === null) {
        return { number, code };
      }
    }
    throw new ConflictError('Could not allocate a project code; enter one manually.');
  }

  private async notifyManagers(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    projectId: string,
    version: number,
    code: string,
    name: string,
    appointed: { projectManagerId: string | null; technicalManagerId: string | null },
  ): Promise<void> {
    const targets: [string | null, string][] = [
      [appointed.projectManagerId, 'PROJECT_MANAGER_ASSIGNED'],
      [appointed.technicalManagerId, 'PROJECT_TECHNICAL_MANAGER_ASSIGNED'],
    ];
    for (const [profileId, type] of targets) {
      if (profileId === null) {
        continue;
      }
      const profile = await db.employeeProfile.findFirst({
        where: { organizationId, id: profileId },
        select: { memberId: true },
      });
      if (profile === null || profile.memberId === action.principal.memberId) {
        continue;
      }
      await enqueueOutboxEvent(db, organizationId, {
        eventType: 'notification.requested',
        aggregateType: 'project',
        aggregateId: projectId,
        payload: {
          recipientMemberId: profile.memberId,
          type,
          severity: 'INFO',
          entityType: 'project',
          entityId: projectId,
          params: { projectCode: code, projectName: name },
          dedupeKey: `${type.toLowerCase()}:${projectId}:${profileId}:${String(version)}`,
        },
      });
    }
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A project with this code already exists.');
      }
      throw error;
    }
  }
}

function policyJson(policy: DailyReportPolicy): Prisma.InputJsonObject {
  return {
    required: policy.required,
    weekdays: [...policy.weekdays],
    dueLocalTime: policy.dueLocalTime,
    reporterRoles: [...policy.reporterRoles],
  };
}

function assertDateOrder(start: string | null, end: string | null): void {
  if (start !== null && end !== null && end < start) {
    throw new InvalidInputError('targetEndDate', 'The target end date cannot be before the start date.');
  }
}

function assertTimeZone(timeZone: string | null): void {
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    throw new InvalidInputError('timeZone', 'Unknown time zone.');
  }
}
