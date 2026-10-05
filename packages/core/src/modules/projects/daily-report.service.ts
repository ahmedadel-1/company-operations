import type { DailyReportStatus, EmploymentStatus, MemberStatus, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { AttachmentOwnerPolicy, OwnerAccess } from '../attachments/attachment.service.js';
import { canAccessResource, isEmptyListScope, listScope } from '../authorization/policy.js';
import type { ListScope, ResourceFacts } from '../authorization/policy.js';
import type { NotificationWriter } from '../notifications/notification.service.js';
import { addDays, daysBetween, fromDateOnly, localToday, toDateOnly } from './business-date.js';
import { parseDailyReportPolicy } from './daily-report-policy.js';
import type { DailyReportPolicy } from './daily-report-policy.js';
import { computeMissingReports, REPORTING_STATUSES, submittedKey } from './missing-reports.js';
import type { ExpectedReporter, MissingReportResult } from './missing-reports.js';
import { isProjectStaff, loadProjectForAccess, loadVisibleProject, projectCalendar } from './project-access.js';
import type { LoadedProject, ProjectCalendar } from './project-access.js';
import { recordProjectActivity } from './project-activity.js';

/** How far back a report may be submitted for (business days in the project's zone). */
export const DAILY_REPORT_BACKFILL_DAYS = 7;
/** Longest missing-report range one request may compute. */
export const MISSING_REPORT_MAX_RANGE_DAYS = 31;
export const DAILY_REPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface ReporterRef {
  readonly id: string;
  readonly fullName: string;
  readonly memberStatus: MemberStatus;
  readonly employmentStatus: EmploymentStatus;
}

export interface DailyReportSummaryView {
  readonly id: string;
  readonly number: number;
  readonly projectId: string;
  readonly reportDate: string;
  readonly systemStatus: DailyReportStatus;
  readonly followUpRequired: boolean;
  readonly reporter: ReporterRef;
  readonly submittedAt: string;
}

export interface DailyReportView extends DailyReportSummaryView {
  readonly project: { readonly id: string; readonly code: string; readonly name: string };
  readonly workPerformed: string;
  readonly operationalNotes: string | null;
  readonly customerNotes: string | null;
  readonly problems: string | null;
  readonly followUpNotes: string | null;
  readonly processedRequestsCount: number | null;
  readonly failedRequestsCount: number | null;
  readonly access: { readonly canAttach: boolean; readonly canDeleteAttachments: boolean };
}

export interface DailyReportInput {
  readonly reportDate?: string | undefined;
  readonly systemStatus: DailyReportStatus;
  readonly workPerformed: string;
  readonly operationalNotes?: string | null | undefined;
  readonly customerNotes?: string | null | undefined;
  readonly problems?: string | null | undefined;
  readonly followUpRequired?: boolean | undefined;
  readonly followUpNotes?: string | null | undefined;
  readonly processedRequestsCount?: number | null | undefined;
  readonly failedRequestsCount?: number | null | undefined;
}

export interface DailyReportListFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly reporterId?: string | undefined;
  readonly systemStatus?: readonly DailyReportStatus[] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MissingReportsView {
  readonly projectId: string;
  readonly timeZone: string;
  readonly today: string;
  readonly from: string;
  readonly to: string;
  readonly policy: DailyReportPolicy;
  readonly reporting: boolean;
  readonly missing: readonly { readonly date: string; readonly employee: { id: string; fullName: string } }[];
  readonly pendingToday: readonly { readonly date: string; readonly employee: { id: string; fullName: string } }[];
}

const reporterSelect = {
  id: true,
  memberId: true,
  departmentId: true,
  fullName: true,
  employmentStatus: true,
  member: { select: { status: true } },
} satisfies Prisma.EmployeeProfileSelect;

const summarySelect = {
  id: true,
  number: true,
  projectId: true,
  reportDate: true,
  systemStatus: true,
  followUpRequired: true,
  submittedAt: true,
  reporter: { select: reporterSelect },
} satisfies Prisma.DailyReportSelect;

const detailSelect = {
  ...summarySelect,
  workPerformed: true,
  operationalNotes: true,
  customerNotes: true,
  problems: true,
  followUpNotes: true,
  processedRequestsCount: true,
  failedRequestsCount: true,
  project: { select: { id: true, code: true, name: true } },
} satisfies Prisma.DailyReportSelect;

type SummaryRow = Prisma.DailyReportGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.DailyReportGetPayload<{ select: typeof detailSelect }>;

const toSummary = (row: SummaryRow): DailyReportSummaryView => ({
  id: row.id,
  number: row.number,
  projectId: row.projectId,
  reportDate: toDateOnly(row.reportDate) ?? '',
  systemStatus: row.systemStatus,
  followUpRequired: row.followUpRequired,
  reporter: {
    id: row.reporter.id,
    fullName: row.reporter.fullName,
    memberStatus: row.reporter.member.status,
    employmentStatus: row.reporter.employmentStatus,
  },
  submittedAt: row.submittedAt.toISOString(),
});

/**
 * Scope facts of a daily report (SECURITY §2.1): PROJECT matches its project; SELF/TEAM match the
 * reporter; DEPARTMENT matches the reporter's department.
 */
export function dailyReportFacts(
  organizationId: string,
  projectId: string,
  reporter: { readonly memberId: string; readonly departmentId: string | null },
): ResourceFacts {
  return {
    organizationId,
    projectIds: [projectId],
    ownerMemberIds: [reporter.memberId],
    subjectMemberIds: [reporter.memberId],
    departmentIds: reporter.departmentId === null ? [] : [reporter.departmentId],
  };
}

/** The `daily_report.view` list scope as a report `where` fragment (same semantics as {@link dailyReportFacts}). */
export function dailyReportScopeWhere(scope: ListScope): Prisma.DailyReportWhereInput | null | 'none' {
  if (scope.all) {
    return null;
  }
  if (isEmptyListScope(scope)) {
    return 'none';
  }
  const or: Prisma.DailyReportWhereInput[] = [];
  if (scope.projectIds.length > 0) or.push({ projectId: { in: [...scope.projectIds] } });
  if (scope.memberIds.length > 0) or.push({ reporter: { memberId: { in: [...scope.memberIds] } } });
  if (scope.departmentIds.length > 0) or.push({ reporter: { departmentId: { in: [...scope.departmentIds] } } });
  return { OR: or };
}

/**
 * Expected reporters, submitted reports and the derived missing reports of one project over a date
 * range (DATA_MODEL §4: computed, never stored). Shared by the API and the scheduled check.
 */
export async function loadMissingReports(
  db: TenantDb,
  organizationId: string,
  project: LoadedProject,
  calendar: ProjectCalendar,
  range: { readonly from: string; readonly to: string },
  now: Date,
): Promise<MissingReportResult> {
  // Sequential: `db` may be an interactive transaction, which runs one query at a time.
  const members = await db.projectMember.findMany({
    where: { organizationId, projectId: project.id },
    select: {
      profileId: true,
      projectRole: true,
      startDate: true,
      endDate: true,
      profile: {
        select: { memberId: true, fullName: true, employmentStatus: true, member: { select: { status: true } } },
      },
    },
  });
  const submitted = await db.dailyReport.findMany({
    where: {
      organizationId,
      projectId: project.id,
      reportDate: { gte: fromDateOnly(range.from), lte: fromDateOnly(range.to) },
    },
    select: { reporterProfileId: true, reportDate: true },
  });
  const reporters: ExpectedReporter[] = members.map((member) => ({
    profileId: member.profileId,
    memberId: member.profile.memberId,
    fullName: member.profile.fullName,
    projectRole: member.projectRole,
    startDate: toDateOnly(member.startDate) ?? range.from,
    endDate: toDateOnly(member.endDate),
    active: member.profile.member.status === 'ACTIVE' && member.profile.employmentStatus === 'ACTIVE',
  }));
  return computeMissingReports({
    status: project.row.status,
    projectStartDate: toDateOnly(project.row.startDate),
    policy: parseDailyReportPolicy(project.row.dailyReportPolicy),
    workWeek: calendar.workWeek,
    timeZone: calendar.timeZone,
    now,
    reporters,
    submitted: new Set(
      submitted.map((report) => submittedKey(report.reporterProfileId, toDateOnly(report.reportDate) ?? '')),
    ),
    from: range.from,
    to: range.to,
  });
}

/**
 * Daily reports (P2-6). One report per project, reporter and business date (the project's zone).
 * Submitting needs `daily_report.submit` on the project, staffing the project, and a reporting
 * status; reports are not editable after submission. Reading needs the project to be visible and
 * `daily_report.view` on the report (project, reporter or reporter's department).
 */
export class DailyReportService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async submit(action: ActionContext, projectId: string, input: DailyReportInput): Promise<DailyReportView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    try {
      return await this.db.$transaction(async (tx) => {
        const project = await loadVisibleProject(tx, action, organizationId, projectId);
        if (!canAccessResource(action.principal, 'daily_report.submit', project.facts)) {
          throw new ForbiddenError();
        }
        const reporter = await tx.employeeProfile.findFirst({
          where: { organizationId, memberId: action.principal.memberId },
          select: { id: true, fullName: true },
        });
        if (reporter === null || !isProjectStaff(project.row, reporter.id)) {
          throw new ForbiddenError('Only people assigned to the project can submit its daily reports.');
        }
        if (!REPORTING_STATUSES.includes(project.row.status)) {
          throw new InvalidTransitionError('Daily reports can only be submitted for active or maintenance projects.');
        }
        const calendar = await projectCalendar(tx, organizationId, project);
        const today = localToday(new Date(), calendar.timeZone);
        const reportDate = input.reportDate ?? today;
        if (reportDate > today) {
          throw new InvalidInputError('reportDate', 'A report cannot be submitted for a future date.');
        }
        if (daysBetween(reportDate, today) > DAILY_REPORT_BACKFILL_DAYS) {
          throw new InvalidInputError(
            'reportDate',
            `Reports can be submitted for the last ${String(DAILY_REPORT_BACKFILL_DAYS)} days only.`,
          );
        }
        const number = Number(await nextCounterValue(tx, organizationId, 'DR'));
        const created = await tx.dailyReport.create({
          data: {
            organizationId,
            number,
            projectId: project.id,
            reporterProfileId: reporter.id,
            reportDate: fromDateOnly(reportDate),
            systemStatus: input.systemStatus,
            workPerformed: input.workPerformed,
            operationalNotes: input.operationalNotes ?? null,
            customerNotes: input.customerNotes ?? null,
            problems: input.problems ?? null,
            followUpRequired: input.followUpRequired ?? false,
            followUpNotes: input.followUpNotes ?? null,
            processedRequestsCount: input.processedRequestsCount ?? null,
            failedRequestsCount: input.failedRequestsCount ?? null,
            submittedByMemberId: action.principal.memberId,
          },
          select: { id: true },
        });
        await recordAudit(tx, organizationId, {
          action: 'daily_report.submitted',
          entityType: 'daily_report',
          entityId: created.id,
          actor: userActor(action),
          metadata: { projectId: project.id, number, reportDate, systemStatus: input.systemStatus },
          context: action.request,
        });
        await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
          source: 'DAILY_REPORT',
          type: 'daily_report.submitted',
          entityType: 'daily_report',
          entityId: created.id,
          summaryParams: {
            number,
            reportDate,
            systemStatus: input.systemStatus,
            reporterName: reporter.fullName,
          },
        });
        return this.detail(tx, action, organizationId, created.id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A daily report for this date has already been submitted.');
      }
      throw error;
    }
  }

  async listForProject(
    action: ActionContext,
    projectId: string,
    filter: DailyReportListFilter,
  ): Promise<Page<DailyReportSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    const scopeWhere = dailyReportScopeWhere(listScope(action.principal, 'daily_report.view'));
    if (scopeWhere === 'none') {
      return { items: [], nextCursor: null };
    }
    const size = pageSize(filter.limit);
    const and: Prisma.DailyReportWhereInput[] = scopeWhere === null ? [] : [scopeWhere];
    if (filter.from !== undefined) and.push({ reportDate: { gte: fromDateOnly(filter.from) } });
    if (filter.to !== undefined) and.push({ reportDate: { lte: fromDateOnly(filter.to) } });
    if (filter.reporterId !== undefined) and.push({ reporterProfileId: filter.reporterId });
    if (filter.systemStatus !== undefined && filter.systemStatus.length > 0) {
      and.push({ systemStatus: { in: [...filter.systemStatus] } });
    }
    if (filter.cursor !== undefined) {
      const [date = '', id = ''] = decodeCursor(filter.cursor, 2);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      const at = fromDateOnly(date);
      and.push({ OR: [{ reportDate: { lt: at } }, { reportDate: at, id: { lt: id } }] });
    }
    const rows = await this.db.dailyReport.findMany({
      where: { organizationId, projectId: project.id, AND: and },
      orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: summarySelect,
    });
    const page = toPage(rows, size, (row) => [toDateOnly(row.reportDate) ?? '', row.id]);
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, reportId: string): Promise<DailyReportView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.detail(this.db, action, organizationId, reportId);
  }

  async missing(
    action: ActionContext,
    projectId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<MissingReportsView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    if (!canAccessResource(action.principal, 'daily_report.view', project.facts)) {
      throw new ForbiddenError();
    }
    const calendar = await projectCalendar(this.db, organizationId, project);
    const now = new Date();
    const today = localToday(now, calendar.timeZone);
    const to = range.to ?? today;
    const from = range.from ?? addDays(to, -6);
    if (from > to) {
      throw new InvalidInputError('from', 'The start date must not be after the end date.');
    }
    if (daysBetween(from, to) >= MISSING_REPORT_MAX_RANGE_DAYS) {
      throw new InvalidInputError('from', `The range cannot exceed ${String(MISSING_REPORT_MAX_RANGE_DAYS)} days.`);
    }
    const result = await loadMissingReports(this.db, organizationId, project, calendar, { from, to }, now);
    const entry = (item: MissingReportResult['missing'][number]) => ({
      date: item.date,
      employee: { id: item.reporter.profileId, fullName: item.reporter.fullName },
    });
    return {
      projectId: project.id,
      timeZone: calendar.timeZone,
      today: result.today,
      from,
      to,
      policy: parseDailyReportPolicy(project.row.dailyReportPolicy),
      reporting: REPORTING_STATUSES.includes(project.row.status),
      missing: result.missing.map(entry),
      pendingToday: result.pendingToday.map(entry),
    };
  }

  /**
   * Attachment rules for a report: visible reports can be viewed; the reporter may attach files
   * while the project is not completed or archived; the reporter or a project manager may delete.
   */
  async attachmentAccess(action: ActionContext, reportId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const loaded = await this.loadVisible(this.db, action, organizationId, reportId);
    if (loaded === null) {
      return { canView: false, canUpload: false, canDelete: false };
    }
    return { canView: true, ...this.attachmentRights(action, loaded.project, loaded.reporterMemberId) };
  }

  private attachmentRights(
    action: ActionContext,
    project: LoadedProject,
    reporterMemberId: string,
  ): { canUpload: boolean; canDelete: boolean } {
    const open = project.row.status !== 'ARCHIVED' && project.row.status !== 'COMPLETED';
    const isReporter = reporterMemberId === action.principal.memberId;
    return {
      canUpload: open && isReporter,
      canDelete:
        project.row.status !== 'ARCHIVED' &&
        (isReporter || canAccessResource(action.principal, 'project.manage', project.facts)),
    };
  }

  private async loadVisible(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    reportId: string,
  ): Promise<{ project: LoadedProject; reporterMemberId: string } | null> {
    const report = await db.dailyReport.findFirst({
      where: { organizationId, id: reportId },
      select: { projectId: true, reporter: { select: { memberId: true, departmentId: true } } },
    });
    if (report === null) {
      return null;
    }
    const project = await loadProjectForAccess(db, organizationId, report.projectId);
    if (
      project === null ||
      !canAccessResource(action.principal, 'project.view', project.facts) ||
      !canAccessResource(
        action.principal,
        'daily_report.view',
        dailyReportFacts(organizationId, report.projectId, report.reporter),
      )
    ) {
      return null;
    }
    return { project, reporterMemberId: report.reporter.memberId };
  }

  private async detail(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    reportId: string,
  ): Promise<DailyReportView> {
    const loaded = await this.loadVisible(db, action, organizationId, reportId);
    if (loaded === null) {
      throw new NotFoundError('Daily report');
    }
    const row: DetailRow = await db.dailyReport.findFirstOrThrow({
      where: { organizationId, id: reportId },
      select: detailSelect,
    });
    const rights = this.attachmentRights(action, loaded.project, loaded.reporterMemberId);
    return {
      ...toSummary(row),
      project: row.project,
      workPerformed: row.workPerformed,
      operationalNotes: row.operationalNotes,
      customerNotes: row.customerNotes,
      problems: row.problems,
      followUpNotes: row.followUpNotes,
      processedRequestsCount: row.processedRequestsCount,
      failedRequestsCount: row.failedRequestsCount,
      access: { canAttach: rights.canUpload, canDeleteAttachments: rights.canDelete },
    };
  }
}

/** Second attachment consumer (P2-6): files attached to a daily report. */
export class DailyReportAttachmentPolicy implements AttachmentOwnerPolicy {
  readonly ownerType = 'DAILY_REPORT' as const;
  readonly allowedContentTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
  readonly maxSizeBytes = DAILY_REPORT_ATTACHMENT_MAX_BYTES;
  readonly listable = true;

  constructor(private readonly reports: DailyReportService) {}

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.reports.attachmentAccess(action, ownerId);
  }
}

export interface MissingCheckResult {
  readonly projects: number;
  readonly notifications: number;
}

/**
 * Scheduled `daily-report.missing.check` (ARCHITECTURE §4, `reports` queue) for the organization of
 * the active system tenant context. For every project that requires reports it derives yesterday's
 * and today's (past due) missing reports and notifies each reporter, plus one summary per date to the
 * project manager. Idempotent: notifications are deduplicated per project and date.
 */
export class DailyReportMissingCheck {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly notifications: NotificationWriter,
  ) {}

  async run(now: Date): Promise<MissingCheckResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const projects = await this.db.project.findMany({
      where: {
        organizationId,
        status: { in: [...REPORTING_STATUSES] },
        dailyReportPolicy: { path: ['required'], equals: true },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    let notifications = 0;
    for (const { id } of projects) {
      const project = await loadProjectForAccess(this.db, organizationId, id);
      if (project === null) {
        continue;
      }
      const calendar = await projectCalendar(this.db, organizationId, project);
      const today = localToday(now, calendar.timeZone);
      const result = await loadMissingReports(
        this.db,
        organizationId,
        project,
        calendar,
        { from: addDays(today, -1), to: today },
        now,
      );
      const params = { projectCode: project.row.code, projectName: project.row.name };
      const byDate = new Map<string, number>();
      for (const item of result.missing) {
        byDate.set(item.date, (byDate.get(item.date) ?? 0) + 1);
        const written = await this.notifications.create({
          recipientMemberId: item.reporter.memberId,
          type: 'DAILY_REPORT_MISSING',
          severity: 'WARNING',
          entityType: 'project',
          entityId: project.id,
          params: { ...params, date: item.date },
          dedupeKey: `daily-report-missing:${project.id}:${item.date}`,
        });
        if (written.kind === 'created') notifications += 1;
      }
      const managerMemberId = project.row.projectManager?.memberId;
      if (managerMemberId !== undefined) {
        for (const [date, count] of byDate) {
          const written = await this.notifications.create({
            recipientMemberId: managerMemberId,
            type: 'DAILY_REPORTS_MISSING_SUMMARY',
            severity: 'WARNING',
            entityType: 'project',
            entityId: project.id,
            params: { ...params, date, count },
            dedupeKey: `daily-report-missing-summary:${project.id}:${date}`,
          });
          if (written.kind === 'created') notifications += 1;
        }
      }
    }
    return { projects: projects.length, notifications };
  }
}
