import type { PermissionKey } from '@company-ops/shared';

import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { organizationZone } from '../attendance/attendance-store.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { assertPermission } from '../authorization/policy.js';
import {
  COMMERCIAL_DASHBOARD_PERMISSIONS,
  commercialSection,
  holdsCommercialView,
} from '../commercial/commercial-dashboard.js';
import type { CommercialSection } from '../commercial/commercial-dashboard.js';
import { projectListWhere } from '../projects/project.service.js';
import { ticketListWhere } from '../support/ticket.service.js';
import type { DashboardCache } from './dashboard-cache.js';
import {
  ACTIVE_PROJECT_STATUSES,
  approvalsSection,
  attendanceTodaySection,
  developmentSection,
  projectsSection,
  supportSection,
  worksTickets,
} from './dashboard-sections.js';
import type {
  ApprovalsSection,
  AttendanceTodaySection,
  DevelopmentSection,
  ProjectsSection,
  SupportSection,
} from './dashboard-sections.js';
import { ownReportsDue } from './daily-reports-today.js';
import { bucketInstants, rangeWindow } from './engine/ranges.js';
import type { TrendRange } from './engine/ranges.js';
import { metric, myRequestsLink, projectLink, supportLink } from './links.js';
import type { DashboardLink, DashboardMetric, SupportMetricFilter } from './links.js';

export interface MyProjectItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly health: string;
  readonly link: DashboardLink;
}

export interface DailyReportDueItem {
  readonly projectId: string;
  readonly code: string;
  readonly name: string;
  readonly date: string;
  readonly overdue: boolean;
  readonly link: DashboardLink;
}

export interface MeDashboard {
  readonly generatedAt: string;
  readonly approvals: ApprovalsSection | null;
  readonly myPendingRequests: DashboardMetric;
  readonly myOpenTickets: DashboardMetric;
  readonly assignedTickets: DashboardMetric | null;
  readonly projects: readonly MyProjectItem[];
  readonly dailyReportsDue: readonly DailyReportDueItem[];
  readonly unreadNotifications: number;
}

export interface TeamDashboard {
  readonly generatedAt: string;
  readonly attendance: AttendanceTodaySection;
}

export interface SupportDashboard {
  readonly generatedAt: string;
  readonly support: SupportSection;
}

export interface ProjectsDashboard {
  readonly generatedAt: string;
  readonly projects: ProjectsSection;
  readonly development: DevelopmentSection;
}

export interface ExecutiveDashboard {
  readonly generatedAt: string;
  readonly today: AttendanceTodaySection | null;
  readonly projects: ProjectsSection | null;
  readonly support: SupportSection | null;
  readonly development: DevelopmentSection;
  readonly commercial: CommercialSection | null;
}

export interface CommercialDashboard {
  readonly generatedAt: string;
  readonly commercial: CommercialSection;
}

export type TrendMetric = 'support_flow' | 'attendance_presence';

export interface Trend {
  readonly metric: TrendMetric;
  readonly range: TrendRange;
  readonly timeZone: string;
  readonly dates: readonly string[];
  readonly series: readonly { readonly key: string; readonly values: readonly number[] }[];
  readonly truncated: boolean;
  readonly generatedAt: string;
}

const MY_PROJECTS = 5;
/** Rows read per trend series; beyond it the series is marked truncated. */
export const TREND_ROW_CAP = 20_000;

const ATTENDANCE_PERMISSIONS: readonly PermissionKey[] = ['attendance.team', 'attendance.admin'];
const SUPPORT_PERMISSIONS: readonly PermissionKey[] = ['support.view'];
const PROJECT_PERMISSIONS: readonly PermissionKey[] = [
  'project.view',
  'daily_report.view',
  'support.view',
  'jira.view',
  'github.view',
];

/**
 * Role dashboards (ROADMAP Phase 8, ADR-0023). Read-only: every number comes from the source tables
 * through the same filter builders as the lists it links to, in the caller's server-resolved scope.
 * The permission check always runs before the cache is consulted.
 */
export class DashboardService {
  private readonly attendance: AttendanceService;

  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly cache: DashboardCache,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.attendance = new AttendanceService(db, tenant, clock);
  }

  /** The caller's own work: personal and cheap (indexed, member-bound), so never cached. */
  async me(action: ActionContext): Promise<MeDashboard> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const principal = action.principal;
    const memberId = principal.memberId;
    const now = this.clock();
    const approvals = await approvalsSection(this.db, principal, organizationId, now);
    const pending = await this.db.requestInstance.count({
      where: { organizationId, requesterMemberId: memberId, status: 'PENDING_APPROVAL' },
    });
    const ticketMetric = async (filter: SupportMetricFilter): Promise<DashboardMetric> => {
      const and = ticketListWhere(principal, organizationId, filter);
      const value = and === 'none' ? 0 : await this.db.supportTicket.count({ where: { organizationId, AND: and } });
      return metric(value, supportLink(filter));
    };
    const myOpenTickets = await ticketMetric({ view: 'open', reporterMemberId: memberId });
    const assignedTickets = worksTickets(principal)
      ? await ticketMetric({ view: 'open', assigneeMemberId: memberId })
      : null;
    const mine = projectListWhere(principal, { scope: 'mine', status: ACTIVE_PROJECT_STATUSES });
    const projects =
      mine === 'none'
        ? []
        : await this.db.project.findMany({
            where: { organizationId, AND: mine },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: MY_PROJECTS,
            select: { id: true, code: true, name: true, status: true, health: true },
          });
    const dailyReportsDue = (await ownReportsDue(this.db, principal, organizationId, now)).map(
      (item): DailyReportDueItem => ({
        projectId: item.projectId,
        code: item.code,
        name: item.name,
        date: item.date,
        overdue: item.overdue,
        link: item.link,
      }),
    );
    const unreadNotifications = await this.db.notification.count({
      where: { organizationId, recipientMemberId: memberId, readAt: null },
    });
    return {
      generatedAt: now.toISOString(),
      approvals,
      myPendingRequests: metric(pending, myRequestsLink(['PENDING_APPROVAL'])),
      myOpenTickets,
      assignedTickets,
      projects: projects.map((row) => ({ ...row, link: projectLink(row.id, 'overview') })),
      dailyReportsDue,
      unreadNotifications,
    };
  }

  async team(action: ActionContext): Promise<TeamDashboard> {
    assertPermission(action.principal, 'attendance.team');
    return this.cache.getOrCompute(
      {
        dashboard: 'team',
        principal: action.principal,
        permissions: ATTENDANCE_PERMISSIONS,
        // The review count excludes the caller's own events.
        personal: true,
        domains: ['attendance', 'requests'],
      },
      async () => {
        const attendance = await attendanceTodaySection(this.attendance, action);
        if (attendance === null) throw new ForbiddenError();
        return { generatedAt: this.clock().toISOString(), attendance };
      },
    );
  }

  async support(action: ActionContext): Promise<SupportDashboard> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!worksTickets(action.principal)) throw new ForbiddenError();
    return this.cache.getOrCompute(
      {
        dashboard: 'support',
        principal: action.principal,
        permissions: SUPPORT_PERMISSIONS,
        // "Assigned to me".
        personal: true,
        domains: ['support'],
      },
      async () => {
        const now = this.clock();
        const timeZone = await organizationZone(this.db, organizationId);
        return {
          generatedAt: now.toISOString(),
          support: await supportSection(this.db, action.principal, organizationId, now, timeZone),
        };
      },
    );
  }

  async projects(action: ActionContext): Promise<ProjectsDashboard> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'dashboard.project');
    return this.cache.getOrCompute(
      {
        dashboard: 'projects',
        principal: action.principal,
        permissions: PROJECT_PERMISSIONS,
        personal: false,
        domains: ['projects', 'support', 'jira', 'github'],
      },
      async () => {
        const now = this.clock();
        return {
          generatedAt: now.toISOString(),
          projects: await projectsSection(this.db, action.principal, organizationId, now),
          development: await developmentSection(this.db, action.principal, organizationId, now),
        };
      },
    );
  }

  /** Organization overview: the same section builders, each present only with its own permission. */
  async executive(action: ActionContext): Promise<ExecutiveDashboard> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const principal = action.principal;
    assertPermission(principal, 'dashboard.executive');
    return this.cache.getOrCompute(
      {
        dashboard: 'executive',
        principal,
        permissions: [
          ...ATTENDANCE_PERMISSIONS,
          ...PROJECT_PERMISSIONS,
          'dashboard.project',
          ...COMMERCIAL_DASHBOARD_PERMISSIONS,
        ],
        personal: true,
        domains: ['attendance', 'requests', 'projects', 'support', 'jira', 'github', 'commercial'],
      },
      async () => {
        const now = this.clock();
        const timeZone = await organizationZone(this.db, organizationId);
        const today = await attendanceTodaySection(this.attendance, action);
        const projects = hasPermission(principal.permissions, 'dashboard.project')
          ? await projectsSection(this.db, principal, organizationId, now)
          : null;
        const support = worksTickets(principal)
          ? await supportSection(this.db, principal, organizationId, now, timeZone)
          : null;
        const development = await developmentSection(this.db, principal, organizationId, now);
        const commercial = await commercialSection(this.db, principal, organizationId, now);
        return { generatedAt: now.toISOString(), today, projects, support, development, commercial };
      },
    );
  }

  /**
   * Tender, contract and document numbers (Phase 10). Any of `tender.view`, `contract.view` or
   * `corporate_document.view`; each group is present only with its own permission. Personal, because
   * INVOLVED members also see the records they work on.
   */
  async commercial(action: ActionContext): Promise<CommercialDashboard> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const principal = action.principal;
    if (!holdsCommercialView(principal)) throw new ForbiddenError();
    return this.cache.getOrCompute(
      {
        dashboard: 'commercial',
        principal,
        permissions: COMMERCIAL_DASHBOARD_PERMISSIONS,
        personal: true,
        domains: ['commercial'],
      },
      async () => {
        const now = this.clock();
        const commercial = await commercialSection(this.db, principal, organizationId, now);
        if (commercial === null) throw new ForbiddenError();
        return { generatedAt: now.toISOString(), commercial };
      },
    );
  }

  /**
   * Daily trend series from stored history only (ADR-0023): support tickets created vs resolved
   * (current `resolved_at`), and employees who checked in (by their work date). Local-date buckets in
   * the organization zone, zero-filled, bounded rows.
   */
  async trend(action: ActionContext, trendMetric: TrendMetric, range: TrendRange): Promise<Trend> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const principal = action.principal;
    if (trendMetric === 'support_flow' && !worksTickets(principal)) throw new ForbiddenError();
    if (trendMetric === 'attendance_presence') assertPermission(principal, 'attendance.team');
    const support = trendMetric === 'support_flow';
    return this.cache.getOrCompute(
      {
        dashboard: 'trend',
        variant: `${trendMetric}.${range}`,
        principal,
        permissions: support ? SUPPORT_PERMISSIONS : ATTENDANCE_PERMISSIONS,
        personal: false,
        domains: support ? ['support'] : ['attendance'],
      },
      async () => {
        const now = this.clock();
        const timeZone = await organizationZone(this.db, organizationId);
        const window = rangeWindow(range, now, timeZone);
        const generatedAt = now.toISOString();
        if (!support) {
          const from = window.dates[0] ?? '';
          const to = window.dates.at(-1) ?? from;
          const byDate = await this.attendance.presenceByDate(action, from, to);
          return {
            metric: trendMetric,
            range,
            timeZone,
            dates: window.dates,
            series: [{ key: 'present', values: window.dates.map((date) => byDate.get(date) ?? 0) }],
            truncated: false,
            generatedAt,
          };
        }
        const from = window.start.toISOString();
        const to = window.end.toISOString();
        const created = ticketListWhere(principal, organizationId, { createdFrom: from, createdTo: to });
        const resolved = ticketListWhere(principal, organizationId, { resolvedFrom: from, resolvedTo: to });
        const createdRows =
          created === 'none'
            ? []
            : await this.db.supportTicket.findMany({
                where: { organizationId, AND: created },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: TREND_ROW_CAP,
                select: { createdAt: true },
              });
        const resolvedRows =
          resolved === 'none'
            ? []
            : await this.db.supportTicket.findMany({
                where: { organizationId, AND: resolved },
                orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
                take: TREND_ROW_CAP,
                select: { resolvedAt: true },
              });
        return {
          metric: trendMetric,
          range,
          timeZone,
          dates: window.dates,
          series: [
            {
              key: 'created',
              values: bucketInstants(
                createdRows.map((row) => row.createdAt),
                window.dates,
                timeZone,
              ),
            },
            {
              key: 'resolved',
              values: bucketInstants(
                resolvedRows.flatMap((row) => (row.resolvedAt === null ? [] : [row.resolvedAt])),
                window.dates,
                timeZone,
              ),
            },
          ],
          truncated: createdRows.length >= TREND_ROW_CAP || resolvedRows.length >= TREND_ROW_CAP,
          generatedAt,
        };
      },
    );
  }
}
