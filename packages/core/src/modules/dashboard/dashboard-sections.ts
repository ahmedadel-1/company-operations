import type { ProjectHealth, ProjectStatus, Prisma } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import type { AttendanceService } from '../attendance/attendance.service.js';
import type { DayBucket } from '../attendance/engine/derive.js';
import { hasPermission, scopesFor } from '../authorization/effective-permissions.js';
import { canAccessResource, isEmptyListScope, listScope } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { DEFAULT_STALE_AFTER_MS, repositoryStale } from '../github/github-views.js';
import { localToday } from '../projects/business-date.js';
import { projectAccessSelect, projectFacts, projectScopeWhere } from '../projects/project-access.js';
import { projectListWhere } from '../projects/project.service.js';
import { approvalInboxWhere } from '../requests/approval.service.js';
import { ticketListWhere } from '../support/ticket.service.js';
import { MISSING_REPORT_PROJECT_CAP, missingReportsToday } from './daily-reports-today.js';
import { localDayWindow } from './engine/ranges.js';
import {
  approvalsLink,
  attendanceBucketLink,
  attendanceReviewsLink,
  metric,
  projectLink,
  projectsLink,
  supportLink,
} from './links.js';
import type { DashboardLink, DashboardMetric, SupportMetricFilter } from './links.js';

/** Project statuses that count as "active" on dashboards (everything but completed and archived). */
export const ACTIVE_PROJECT_STATUSES: readonly ProjectStatus[] = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE'];
const HEALTHS: readonly ProjectHealth[] = ['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL'];
const WATCHLIST_SIZE = 10;
/** Most mapped projects one development section aggregates (bounded work per request). */
const DEVELOPMENT_PROJECT_CAP = 500;

/** Holds `support.view` beyond SELF: works tickets (support queues), not only reports them. */
export function worksTickets(principal: Principal): boolean {
  return scopesFor(principal.permissions, 'support.view').some((scope) => scope !== 'SELF');
}

async function countTickets(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  filter: SupportMetricFilter,
): Promise<DashboardMetric> {
  const and = ticketListWhere(principal, organizationId, filter);
  const value = and === 'none' ? 0 : await db.supportTicket.count({ where: { organizationId, AND: and } });
  return metric(value, supportLink(filter));
}

// ---- Support ----

export interface SupportSection {
  readonly open: DashboardMetric;
  readonly new: DashboardMetric;
  readonly assignedToMe: DashboardMetric | null;
  readonly critical: DashboardMetric;
  readonly slaAtRisk: DashboardMetric;
  readonly slaBreached: DashboardMetric;
  readonly escalated: DashboardMetric;
  readonly waitingForDevelopment: DashboardMetric;
  readonly waitingForCustomer: DashboardMetric;
  readonly resolvedToday: DashboardMetric;
}

/**
 * Support queue numbers in the caller's `support.view` scope. Each number is the length of the ticket
 * list its link opens (the same `ticketListWhere` filter). SLA numbers count open tickets where either
 * the first-response or the resolution clock is in that state.
 */
export async function supportSection(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
  timeZone: string,
): Promise<SupportSection> {
  const window = localDayWindow(localToday(now, timeZone), timeZone);
  const count = (filter: SupportMetricFilter) => countTickets(db, principal, organizationId, filter);
  // Sequential: the tenant client is one transaction connection.
  const open = await count({ view: 'open' });
  const fresh = await count({ status: ['NEW'] });
  const assignedToMe = worksTickets(principal)
    ? await count({ view: 'open', assigneeMemberId: principal.memberId })
    : null;
  const critical = await count({ view: 'critical' });
  const slaAtRisk = await count({ view: 'open', slaState: ['AT_RISK'] });
  const slaBreached = await count({ view: 'open', slaState: ['BREACHED'] });
  const escalated = await count({ status: ['ESCALATED'] });
  const waitingForDevelopment = await count({ status: ['WAITING_FOR_DEVELOPMENT'] });
  const waitingForCustomer = await count({ status: ['WAITING_FOR_CUSTOMER'] });
  const resolvedToday = await count({
    resolvedFrom: window.start.toISOString(),
    resolvedTo: window.end.toISOString(),
  });
  return {
    open,
    new: fresh,
    assignedToMe,
    critical,
    slaAtRisk,
    slaBreached,
    escalated,
    waitingForDevelopment,
    waitingForCustomer,
    resolvedToday,
  };
}

// ---- Projects ----

export interface ProjectWatchItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly health: ProjectHealth;
  readonly healthChangedAt: string | null;
  readonly openTickets: number;
  readonly criticalTickets: number;
  readonly slaRiskTickets: number;
  readonly missingReportsToday: number | null;
  readonly link: DashboardLink;
}

export interface ProjectsSection {
  readonly active: DashboardMetric;
  readonly healthy: DashboardMetric;
  readonly needsAttention: DashboardMetric;
  readonly atRisk: DashboardMetric;
  readonly critical: DashboardMetric;
  readonly missingReportsToday: number;
  readonly watchlist: readonly ProjectWatchItem[];
}

async function ticketCountsByProject(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  projectIds: readonly string[],
  filter: SupportMetricFilter,
): Promise<Map<string, number>> {
  const and = ticketListWhere(principal, organizationId, filter);
  if (and === 'none' || projectIds.length === 0) {
    return new Map();
  }
  const rows = await db.supportTicket.groupBy({
    by: ['projectId'],
    where: { organizationId, AND: [...and, { projectId: { in: [...projectIds] } }] },
    _count: { _all: true },
  });
  return new Map(rows.flatMap((row) => (row.projectId === null ? [] : [[row.projectId, row._count._all]])));
}

/**
 * Project health numbers in the caller's `project.view` scope (the project list's filter), today's
 * missing daily reports for projects whose reports the caller may view, and a watchlist of the least
 * healthy active projects with their open support load (tickets visible to the caller).
 */
export async function projectsSection(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
): Promise<ProjectsSection> {
  const status = ACTIVE_PROJECT_STATUSES;
  const and = projectListWhere(principal, { status });
  const byHealth = new Map<ProjectHealth, number>();
  if (and !== 'none') {
    const rows = await db.project.groupBy({
      by: ['health'],
      where: { organizationId, AND: and },
      _count: { _all: true },
    });
    for (const row of rows) byHealth.set(row.health, row._count._all);
  }
  const healthMetric = (health: ProjectHealth) =>
    metric(byHealth.get(health) ?? 0, projectsLink({ status, health: [health] }));
  const active = metric(
    HEALTHS.reduce((sum, health) => sum + (byHealth.get(health) ?? 0), 0),
    projectsLink({ status }),
  );

  const reporting =
    and === 'none'
      ? []
      : await db.project.findMany({
          where: { organizationId, AND: [...and, { status: { in: ['ACTIVE', 'MAINTENANCE'] } }] },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: MISSING_REPORT_PROJECT_CAP,
          select: projectAccessSelect,
        });
  const reportable = reporting.filter((row) =>
    canAccessResource(principal, 'daily_report.view', projectFacts(organizationId, row)),
  );
  const missing = await missingReportsToday(db, organizationId, reportable, now);
  let missingTotal = 0;
  for (const result of missing.values()) missingTotal += result.missing.length;

  const watchRows =
    and === 'none'
      ? []
      : await db.project.findMany({
          where: { organizationId, AND: and },
          orderBy: [{ health: 'desc' }, { name: 'asc' }, { id: 'asc' }],
          take: WATCHLIST_SIZE,
          select: { id: true, code: true, name: true, status: true, health: true, healthChangedAt: true },
        });
  const watchIds = watchRows.map((row) => row.id);
  const openBy = await ticketCountsByProject(db, principal, organizationId, watchIds, { view: 'open' });
  const criticalBy = await ticketCountsByProject(db, principal, organizationId, watchIds, { view: 'critical' });
  const riskBy = await ticketCountsByProject(db, principal, organizationId, watchIds, { view: 'sla_risk' });
  const reportableIds = new Set(reportable.map((row) => row.id));
  return {
    active,
    healthy: healthMetric('HEALTHY'),
    needsAttention: healthMetric('NEEDS_ATTENTION'),
    atRisk: healthMetric('AT_RISK'),
    critical: healthMetric('CRITICAL'),
    missingReportsToday: missingTotal,
    watchlist: watchRows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      health: row.health,
      healthChangedAt: row.healthChangedAt?.toISOString() ?? null,
      openTickets: openBy.get(row.id) ?? 0,
      criticalTickets: criticalBy.get(row.id) ?? 0,
      slaRiskTickets: riskBy.get(row.id) ?? 0,
      missingReportsToday: reportableIds.has(row.id) ? (missing.get(row.id)?.missing.length ?? 0) : null,
      link: projectLink(row.id, 'overview'),
    })),
  };
}

// ---- Development (Jira / GitHub, from the local caches) ----

export type IntegrationStatus = 'NOT_CONNECTED' | 'ACTIVE' | 'NEEDS_ATTENTION';

export interface IntegrationFreshness {
  readonly status: IntegrationStatus;
  readonly lastSyncAt: string | null;
  readonly stale: boolean;
}

interface ProjectRef {
  readonly projectId: string;
  readonly code: string;
  readonly name: string;
}

export interface JiraProjectSignals extends ProjectRef {
  readonly open: number;
  readonly blocked: number;
  readonly overdue: number;
  readonly link: DashboardLink;
}

export interface JiraSignals {
  readonly freshness: IntegrationFreshness;
  readonly open: number;
  readonly blocked: number;
  readonly overdue: number;
  readonly projects: readonly JiraProjectSignals[];
}

export interface GithubProjectSignals extends ProjectRef {
  readonly open: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly failingChecks: number;
  readonly link: DashboardLink;
}

export interface GithubSignals {
  readonly freshness: IntegrationFreshness;
  readonly open: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly failingChecks: number;
  readonly projects: readonly GithubProjectSignals[];
}

export interface DevelopmentSection {
  readonly jira: JiraSignals | null;
  readonly github: GithubSignals | null;
}

function projectScopeFor(principal: Principal, permission: 'jira.view' | 'github.view') {
  const scope = listScope(principal, permission);
  return isEmptyListScope(scope) ? 'none' : projectScopeWhere(scope);
}

const sumBy = <T>(rows: readonly T[], value: (row: T) => number): number =>
  rows.reduce((sum, row) => sum + value(row), 0);

/**
 * Jira delivery signals per project in the caller's `jira.view` scope, from the issue cache with the
 * project Jira tab's definitions: open = not DONE, blocked = blocked and not DONE, overdue = due date
 * before today (UTC, as on the tab) and not DONE. Freshness is the connection's last successful sync.
 */
export async function jiraSignals(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<JiraSignals | null> {
  if (!hasPermission(principal.permissions, 'jira.view')) {
    return null;
  }
  const scopeWhere = projectScopeFor(principal, 'jira.view');
  const connection = await db.jiraConnection.findFirst({
    where: { organizationId, status: { not: 'DISCONNECTED' } },
    select: { status: true, lastSuccessAt: true },
  });
  const freshness: IntegrationFreshness =
    connection === null
      ? { status: 'NOT_CONNECTED', lastSyncAt: null, stale: false }
      : {
          status: connection.status === 'ACTIVE' ? 'ACTIVE' : 'NEEDS_ATTENTION',
          lastSyncAt: connection.lastSuccessAt?.toISOString() ?? null,
          stale: connection.lastSuccessAt === null || now.getTime() - connection.lastSuccessAt.getTime() > staleAfterMs,
        };
  const empty = { freshness, open: 0, blocked: 0, overdue: 0, projects: [] };
  if (connection === null || scopeWhere === 'none') {
    return empty;
  }
  const mappings = await db.jiraProjectMapping.findMany({
    where: {
      organizationId,
      removedAt: null,
      connection: { status: { not: 'DISCONNECTED' } },
      ...(scopeWhere === null ? {} : { project: scopeWhere }),
    },
    orderBy: [{ projectId: 'asc' }, { id: 'asc' }],
    take: DEVELOPMENT_PROJECT_CAP,
    select: { id: true, project: { select: { id: true, code: true, name: true } } },
  });
  if (mappings.length === 0) {
    return empty;
  }
  const live: Prisma.JiraIssueWhereInput = {
    organizationId,
    mappingId: { in: mappings.map((mapping) => mapping.id) },
    deletedInJiraAt: null,
    statusCategory: { not: 'DONE' },
  };
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const group = async (where: Prisma.JiraIssueWhereInput) => {
    const rows = await db.jiraIssue.groupBy({ by: ['mappingId'], where, _count: { _all: true } });
    return new Map(rows.map((row) => [row.mappingId ?? '', row._count._all]));
  };
  const open = await group(live);
  const blocked = await group({ ...live, isBlocked: true });
  const overdue = await group({ ...live, dueDate: { lt: today } });
  const perProject = new Map<string, JiraProjectSignals>();
  for (const mapping of mappings) {
    const current = perProject.get(mapping.project.id);
    perProject.set(mapping.project.id, {
      projectId: mapping.project.id,
      code: mapping.project.code,
      name: mapping.project.name,
      open: (current?.open ?? 0) + (open.get(mapping.id) ?? 0),
      blocked: (current?.blocked ?? 0) + (blocked.get(mapping.id) ?? 0),
      overdue: (current?.overdue ?? 0) + (overdue.get(mapping.id) ?? 0),
      link: projectLink(mapping.project.id, 'jira'),
    });
  }
  const projects = [...perProject.values()]
    .filter((row) => row.open > 0)
    .sort((a, b) => b.blocked - a.blocked || b.overdue - a.overdue || b.open - a.open || a.code.localeCompare(b.code));
  return {
    freshness,
    open: sumBy(projects, (row) => row.open),
    blocked: sumBy(projects, (row) => row.blocked),
    overdue: sumBy(projects, (row) => row.overdue),
    projects,
  };
}

/**
 * GitHub pull-request signals per project in the caller's `github.view` scope, from the PR cache with
 * the project GitHub tab's definitions. Totals count each pull request once even when its repository
 * is mapped to several projects. Freshness: the latest repository sync; stale when any mapped
 * repository is stale or unavailable.
 */
export async function githubSignals(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<GithubSignals | null> {
  if (!hasPermission(principal.permissions, 'github.view')) {
    return null;
  }
  const scopeWhere = projectScopeFor(principal, 'github.view');
  const installation = await db.githubInstallation.findFirst({
    where: { organizationId, status: { not: 'DISCONNECTED' } },
    orderBy: [{ boundAt: 'desc' }, { id: 'desc' }],
    select: { status: true },
  });
  const zero = { open: 0, awaitingReview: 0, changesRequested: 0, failingChecks: 0, projects: [] };
  if (installation === null) {
    return { freshness: { status: 'NOT_CONNECTED', lastSyncAt: null, stale: false }, ...zero };
  }
  const status: IntegrationStatus = installation.status === 'ACTIVE' ? 'ACTIVE' : 'NEEDS_ATTENTION';
  const mappings =
    scopeWhere === 'none'
      ? []
      : await db.githubRepositoryMapping.findMany({
          where: {
            organizationId,
            removedAt: null,
            repository: { installation: { status: { not: 'DISCONNECTED' } } },
            ...(scopeWhere === null ? {} : { project: scopeWhere }),
          },
          orderBy: [{ projectId: 'asc' }, { id: 'asc' }],
          take: DEVELOPMENT_PROJECT_CAP,
          select: {
            repository: { select: { id: true, status: true, lastFullSyncAt: true, lastReconciledAt: true } },
            project: { select: { id: true, code: true, name: true } },
          },
        });
  const repositories = new Map(mappings.map((mapping) => [mapping.repository.id, mapping.repository]));
  const marks = [...repositories.values()].flatMap((repo) =>
    [repo.lastFullSyncAt, repo.lastReconciledAt].filter((mark): mark is Date => mark !== null),
  );
  const lastSync = marks.length === 0 ? null : new Date(Math.max(...marks.map((mark) => mark.getTime())));
  const freshness: IntegrationFreshness = {
    status,
    lastSyncAt: lastSync?.toISOString() ?? null,
    stale: [...repositories.values()].some((repo) => repositoryStale(repo, now, staleAfterMs)),
  };
  if (repositories.size === 0) {
    return { freshness, ...zero };
  }
  const open: Prisma.GithubPullRequestWhereInput = {
    organizationId,
    repositoryId: { in: [...repositories.keys()] },
    state: 'OPEN',
  };
  const group = async (where: Prisma.GithubPullRequestWhereInput) => {
    const rows = await db.githubPullRequest.groupBy({ by: ['repositoryId'], where, _count: { _all: true } });
    return new Map(rows.map((row) => [row.repositoryId, row._count._all]));
  };
  const filters = {
    open,
    awaitingReview: { ...open, draft: false, reviewState: { in: ['REVIEW_REQUIRED', 'NONE'] } },
    changesRequested: { ...open, reviewState: 'CHANGES_REQUESTED' },
    failingChecks: { ...open, checksState: 'FAILURE' },
  } satisfies Record<string, Prisma.GithubPullRequestWhereInput>;
  const openBy = await group(filters.open);
  const reviewBy = await group(filters.awaitingReview);
  const changesBy = await group(filters.changesRequested);
  const failingBy = await group(filters.failingChecks);
  const total = (by: Map<string, number>) => sumBy([...by.values()], (value) => value);
  const perProject = new Map<string, GithubProjectSignals>();
  for (const mapping of mappings) {
    const repoId = mapping.repository.id;
    const current = perProject.get(mapping.project.id);
    perProject.set(mapping.project.id, {
      projectId: mapping.project.id,
      code: mapping.project.code,
      name: mapping.project.name,
      open: (current?.open ?? 0) + (openBy.get(repoId) ?? 0),
      awaitingReview: (current?.awaitingReview ?? 0) + (reviewBy.get(repoId) ?? 0),
      changesRequested: (current?.changesRequested ?? 0) + (changesBy.get(repoId) ?? 0),
      failingChecks: (current?.failingChecks ?? 0) + (failingBy.get(repoId) ?? 0),
      link: projectLink(mapping.project.id, 'github'),
    });
  }
  const projects = [...perProject.values()]
    .filter((row) => row.open > 0)
    .sort(
      (a, b) =>
        b.failingChecks - a.failingChecks ||
        b.changesRequested - a.changesRequested ||
        b.open - a.open ||
        a.code.localeCompare(b.code),
    );
  return {
    freshness,
    open: total(openBy),
    awaitingReview: total(reviewBy),
    changesRequested: total(changesBy),
    failingChecks: total(failingBy),
    projects,
  };
}

export async function developmentSection(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
): Promise<DevelopmentSection> {
  const jira = await jiraSignals(db, principal, organizationId, now);
  const github = await githubSignals(db, principal, organizationId, now);
  return { jira, github };
}

// ---- Attendance today ----

export interface AttendanceTodaySection {
  readonly date: string;
  readonly timeZone: string;
  readonly employees: DashboardMetric;
  readonly present: DashboardMetric;
  readonly remote: DashboardMetric;
  readonly onLeave: DashboardMetric;
  readonly onMission: DashboardMetric;
  readonly late: DashboardMetric;
  readonly notCheckedIn: DashboardMetric;
  readonly missingCheckout: DashboardMetric;
  readonly pendingReviews: DashboardMetric | null;
  readonly truncated: boolean;
}

/**
 * Today's attendance in the caller's `attendance.team` scope: the team-day list's buckets (same
 * derivation, `dayBuckets`), so each number equals the length of the filtered team-day list it links to.
 */
export async function attendanceTodaySection(
  attendance: AttendanceService,
  action: ActionContext,
): Promise<AttendanceTodaySection | null> {
  if (!hasPermission(action.principal.permissions, 'attendance.team')) {
    return null;
  }
  const summary = await attendance.teamDaySummary(action);
  const reviews = await attendance.pendingReviewSummary(action);
  const bucket = (key: DayBucket) => metric(summary.counts[key], attendanceBucketLink(summary.date, key));
  return {
    date: summary.date,
    timeZone: summary.timeZone,
    employees: metric(summary.employees, attendanceBucketLink(summary.date, null)),
    present: bucket('PRESENT'),
    remote: bucket('REMOTE'),
    onLeave: bucket('ON_LEAVE'),
    onMission: bucket('ON_MISSION'),
    late: bucket('LATE'),
    notCheckedIn: bucket('NOT_CHECKED_IN'),
    missingCheckout: bucket('MISSING_CHECKOUT'),
    pendingReviews: reviews === null ? null : metric(reviews.count, attendanceReviewsLink()),
    truncated: summary.truncated,
  };
}

// ---- Approvals ----

export interface ApprovalsSection {
  readonly waiting: DashboardMetric;
  readonly overdue: DashboardMetric;
}

/** The caller's approval inbox (own and delegated assignments), with the inbox's own filter. */
export async function approvalsSection(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
): Promise<ApprovalsSection | null> {
  if (!hasPermission(principal.permissions, 'request.approve')) {
    return null;
  }
  const waitingWhere = await approvalInboxWhere(db, organizationId, principal.memberId, now, {});
  const overdueWhere = await approvalInboxWhere(db, organizationId, principal.memberId, now, { overdue: true });
  const waiting = await db.requestApproval.count({ where: { organizationId, AND: [waitingWhere] } });
  const overdue = await db.requestApproval.count({ where: { organizationId, AND: [overdueWhere] } });
  return { waiting: metric(waiting, approvalsLink(false)), overdue: metric(overdue, approvalsLink(true)) };
}
