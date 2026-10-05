import type { PermissionKey, Scope } from '@company-ops/shared';

import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { organizationZone } from '../attendance/attendance-store.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { hasPermission, scopesFor } from '../authorization/effective-permissions.js';
import { listScope } from '../authorization/policy.js';
import { COMMERCIAL_ATTENTION_PERMISSIONS, commercialAttention } from '../commercial/commercial-attention.js';
import type { Principal } from '../authorization/policy.js';
import { addDays, fromDateOnly, localToday } from '../projects/business-date.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { projectListWhere } from '../projects/project.service.js';
import { approvalInboxWhere } from '../requests/approval.service.js';
import { requestScopeWhere } from '../requests/request-access.js';
import { ticketListWhere } from '../support/ticket.service.js';
import { ticketKey } from '../support/ticket-access.js';
import type { DashboardCache } from './dashboard-cache.js';
import { ACTIVE_PROJECT_STATUSES, worksTickets } from './dashboard-sections.js';
import { ownReportsDue } from './daily-reports-today.js';
import { ATTENTION_CAP, prioritizeAttention } from './engine/attention.js';
import type { AttentionItem, AttentionScope, AttentionSeverity } from './engine/attention.js';
import { allRequestsLink, attendanceReviewsLink, dashboardLink, projectLink } from './links.js';

export interface NeedsAttention {
  readonly generatedAt: string;
  readonly items: readonly AttentionItem[];
  readonly total: number;
  readonly truncated: boolean;
}

/** Rows one rule reads at most; reaching it marks the feed truncated. */
const RULE_LIMIT = ATTENTION_CAP;
const MISSING_CHECKOUT_DAYS = 14;
const SCOPE_ORDER: readonly Scope[] = ['ORG', 'DEPARTMENT', 'PROJECT', 'TEAM', 'SELF'];

/** The widest scope of the permission that governs the item. */
function scopeOf(principal: Principal, permission: PermissionKey): AttentionScope {
  const held = new Set(scopesFor(principal.permissions, permission));
  return SCOPE_ORDER.find((scope) => held.has(scope)) ?? 'SELF';
}

const requestKey = (number: number): string => `REQ-${String(number)}`;

const ATTENTION_PERMISSIONS: readonly PermissionKey[] = [
  'support.view',
  'project.view',
  'dashboard.project',
  'request.approve',
  'request.view',
  'request.fulfill',
  'attendance.team',
  'attendance.admin',
  'daily_report.submit',
  'integration.manage',
];

/**
 * The "Needs attention" feed (ADR-0023): deterministic rules over current state in the caller's scope,
 * one item per source entity (highest severity wins), ordered by severity, then waiting time, then key.
 */
export class NeedsAttentionService {
  private readonly attendance: AttendanceService;

  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly cache: DashboardCache,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.attendance = new AttendanceService(db, tenant, clock);
  }

  async list(action: ActionContext): Promise<NeedsAttention> {
    boundOrganizationId(this.tenant, action);
    return this.cache.getOrCompute(
      {
        dashboard: 'attention',
        principal: action.principal,
        permissions: [...ATTENTION_PERMISSIONS, ...COMMERCIAL_ATTENTION_PERMISSIONS],
        personal: true,
        domains: ['support', 'projects', 'requests', 'attendance', 'jira', 'github', 'commercial'],
      },
      () => this.compute(action),
    );
  }

  private async compute(action: ActionContext): Promise<NeedsAttention> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const principal = action.principal;
    const now = this.clock();
    const items: AttentionItem[] = [];
    let limited = false;
    const take = <T>(rows: readonly T[]): readonly T[] => {
      if (rows.length >= RULE_LIMIT) limited = true;
      return rows;
    };

    // Support tickets (people who work tickets).
    if (worksTickets(principal)) {
      const scope = scopeOf(principal, 'support.view');
      const select = {
        id: true,
        number: true,
        severity: true,
        createdAt: true,
        firstResponseDueAt: true,
        resolutionDueAt: true,
        firstResponseSlaState: true,
        resolutionSlaState: true,
      } as const;
      const tickets = async (filter: Parameters<typeof ticketListWhere>[2]) => {
        const and = ticketListWhere(principal, organizationId, filter);
        if (and === 'none') return [];
        return take(
          await this.db.supportTicket.findMany({
            where: { organizationId, AND: and },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: RULE_LIMIT,
            select,
          }),
        );
      };
      type TicketRow = Awaited<ReturnType<typeof tickets>>[number];
      const dueIn = (row: TicketRow, state: 'AT_RISK' | 'BREACHED'): Date => {
        const dues = [
          row.firstResponseSlaState === state ? row.firstResponseDueAt : null,
          row.resolutionSlaState === state ? row.resolutionDueAt : null,
        ].filter((due): due is Date => due !== null);
        return dues.length === 0 ? row.createdAt : new Date(Math.min(...dues.map((due) => due.getTime())));
      };
      const ticketItem = (
        row: TicketRow,
        type: AttentionItem['type'],
        severity: AttentionSeverity,
        occurredAt: Date,
      ): AttentionItem => ({
        key: `${type}:${row.id}`,
        type,
        severity,
        params: { key: ticketKey(row.number), severity: row.severity },
        entity: { type: 'support_ticket', id: row.id },
        occurredAt: occurredAt.toISOString(),
        link: dashboardLink(`/support/tickets/${row.id}`),
        scope,
      });
      for (const row of await tickets({ view: 'open', slaState: ['BREACHED'] })) {
        const severity = row.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
        items.push(ticketItem(row, 'TICKET_SLA_BREACHED', severity, dueIn(row, 'BREACHED')));
      }
      for (const row of await tickets({ view: 'unassigned' })) {
        if (row.severity === 'CRITICAL') {
          items.push(ticketItem(row, 'TICKET_CRITICAL_UNASSIGNED', 'CRITICAL', row.createdAt));
        }
      }
      for (const row of await tickets({ view: 'open', slaState: ['AT_RISK'] })) {
        items.push(ticketItem(row, 'TICKET_SLA_AT_RISK', 'HIGH', dueIn(row, 'AT_RISK')));
      }
    }

    // Project health (project dashboards' audience).
    if (hasPermission(principal.permissions, 'dashboard.project')) {
      const and = projectListWhere(principal, { status: ACTIVE_PROJECT_STATUSES, health: ['CRITICAL', 'AT_RISK'] });
      const rows =
        and === 'none'
          ? []
          : take(
              await this.db.project.findMany({
                where: { organizationId, AND: and },
                orderBy: [{ health: 'desc' }, { healthChangedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
                take: RULE_LIMIT,
                select: { id: true, code: true, health: true, healthChangedAt: true, updatedAt: true },
              }),
            );
      const scope = scopeOf(principal, 'project.view');
      for (const row of rows) {
        const critical = row.health === 'CRITICAL';
        const type = critical ? 'PROJECT_CRITICAL' : 'PROJECT_AT_RISK';
        items.push({
          key: `${type}:${row.id}`,
          type,
          severity: critical ? 'CRITICAL' : 'HIGH',
          params: { code: row.code },
          entity: { type: 'project', id: row.id },
          occurredAt: (row.healthChangedAt ?? row.updatedAt).toISOString(),
          link: projectLink(row.id, 'overview'),
          scope,
        });
      }
    }

    // Approvals assigned to the caller (own or delegated).
    if (hasPermission(principal.permissions, 'request.approve')) {
      const where = await approvalInboxWhere(this.db, organizationId, principal.memberId, now, {});
      const rows = take(
        await this.db.requestApproval.findMany({
          where: { organizationId, AND: [where] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: RULE_LIMIT,
          select: { id: true, dueAt: true, createdAt: true, request: { select: { id: true, number: true } } },
        }),
      );
      for (const row of rows) {
        const overdue = row.dueAt !== null && row.dueAt < now;
        const type = overdue ? 'APPROVAL_OVERDUE' : 'APPROVAL_WAITING';
        items.push({
          key: `${type}:${row.id}`,
          type,
          severity: overdue ? 'HIGH' : 'MEDIUM',
          params: { key: requestKey(row.request.number) },
          entity: { type: 'request_approval', id: row.id },
          occurredAt: (overdue && row.dueAt !== null ? row.dueAt : row.createdAt).toISOString(),
          link: dashboardLink(`/requests/${row.request.id}`),
          scope: 'SELF',
        });
      }
    }

    // Own missing check-outs (recent days).
    if (hasPermission(principal.permissions, 'attendance.self')) {
      const today = localToday(now, await organizationZone(this.db, organizationId));
      const rows = await this.db.attendanceRecord.findMany({
        where: {
          organizationId,
          memberId: principal.memberId,
          status: 'MISSING_CHECKOUT',
          workDate: { gte: fromDateOnly(addDays(today, -MISSING_CHECKOUT_DAYS)) },
        },
        orderBy: [{ workDate: 'asc' }, { id: 'asc' }],
        take: 10,
        select: { id: true, workDate: true, checkInAt: true, scheduledEndAt: true, updatedAt: true },
      });
      for (const row of rows) {
        items.push({
          key: `ATTENDANCE_MISSING_CHECKOUT:${row.id}`,
          type: 'ATTENDANCE_MISSING_CHECKOUT',
          severity: 'MEDIUM',
          params: { date: row.workDate.toISOString().slice(0, 10) },
          entity: { type: 'attendance_record', id: row.id },
          occurredAt: (row.scheduledEndAt ?? row.checkInAt ?? row.updatedAt).toISOString(),
          link: dashboardLink(`/attendance/records/${row.id}`),
          scope: 'SELF',
        });
      }
    }

    // Attendance reviews the caller may decide.
    const reviews = await this.attendance.pendingReviewSummary(action);
    if (reviews !== null && reviews.count > 0) {
      items.push({
        key: `ATTENDANCE_REVIEWS_WAITING:${principal.memberId}`,
        type: 'ATTENDANCE_REVIEWS_WAITING',
        severity: 'MEDIUM',
        params: { count: reviews.count },
        entity: { type: 'attendance_review_queue', id: principal.memberId },
        occurredAt: (reviews.oldestAt ?? now).toISOString(),
        link: attendanceReviewsLink(),
        scope: holdsOrgWide(principal, 'attendance.admin') ? 'ORG' : scopeOf(principal, 'attendance.team'),
      });
    }

    // Own daily reports past due today.
    for (const due of await ownReportsDue(this.db, principal, organizationId, now)) {
      if (!due.overdue) continue;
      items.push({
        key: `DAILY_REPORT_DUE:${due.projectId}`,
        type: 'DAILY_REPORT_DUE',
        severity: 'MEDIUM',
        params: { code: due.code, date: due.date },
        entity: { type: 'daily_report_due', id: due.projectId },
        occurredAt: due.dueAt.toISOString(),
        link: due.link,
        scope: 'SELF',
      });
    }

    // Approved requests awaiting fulfillment (organization-wide fulfillers).
    if (holdsOrgWide(principal, 'request.fulfill') && hasPermission(principal.permissions, 'request.view')) {
      const status = ['APPROVED', 'IN_FULFILLMENT'] as const;
      const where = {
        organizationId,
        AND: [
          requestScopeWhere(listScope(principal, 'request.view'), principal.memberId),
          { status: { in: [...status] } },
        ],
      };
      const count = await this.db.requestInstance.count({ where });
      if (count > 0) {
        const oldest = await this.db.requestInstance.findFirst({
          where,
          orderBy: [{ decidedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          select: { decidedAt: true, updatedAt: true },
        });
        items.push({
          key: `REQUESTS_AWAITING_FULFILLMENT:${organizationId}`,
          type: 'REQUESTS_AWAITING_FULFILLMENT',
          severity: 'MEDIUM',
          params: { count },
          entity: { type: 'request_fulfillment_queue', id: organizationId },
          occurredAt: (oldest?.decidedAt ?? oldest?.updatedAt ?? now).toISOString(),
          link: allRequestsLink(status),
          scope: 'ORG',
        });
      }
    }

    // Integration problems (integration administrators).
    if (holdsOrgWide(principal, 'integration.manage')) {
      const jira = await this.db.jiraConnection.findFirst({
        where: { organizationId, status: { in: ['NEEDS_REAUTH', 'ERROR'] } },
        select: { id: true, status: true, lastErrorAt: true, updatedAt: true },
      });
      if (jira !== null) {
        items.push({
          key: `JIRA_CONNECTION_PROBLEM:${jira.id}`,
          type: 'JIRA_CONNECTION_PROBLEM',
          severity: 'HIGH',
          params: { status: jira.status },
          entity: { type: 'jira_connection', id: jira.id },
          occurredAt: (jira.lastErrorAt ?? jira.updatedAt).toISOString(),
          link: dashboardLink('/admin/integrations/jira'),
          scope: 'ORG',
        });
      }
      const github = await this.db.githubInstallation.findFirst({
        where: { organizationId, status: { in: ['SUSPENDED', 'DELETED'] } },
        orderBy: [{ boundAt: 'desc' }, { id: 'desc' }],
        select: { id: true, status: true, suspendedAt: true, lastErrorAt: true, updatedAt: true },
      });
      if (github !== null) {
        items.push({
          key: `GITHUB_CONNECTION_PROBLEM:${github.id}`,
          type: 'GITHUB_CONNECTION_PROBLEM',
          severity: 'HIGH',
          params: { status: github.status },
          entity: { type: 'github_installation', id: github.id },
          occurredAt: (github.suspendedAt ?? github.lastErrorAt ?? github.updatedAt).toISOString(),
          link: dashboardLink('/admin/integrations/github'),
          scope: 'ORG',
        });
      }
    }

    // Tenders, contracts, guarantees and corporate documents (Phase 10).
    const commercial = await commercialAttention(this.db, principal, organizationId, now, RULE_LIMIT);
    items.push(...commercial.items);
    if (commercial.limited) limited = true;

    const prioritized = prioritizeAttention(items);
    return {
      generatedAt: now.toISOString(),
      items: prioritized.items,
      total: prioritized.total,
      truncated: prioritized.truncated || limited,
    };
  }
}
