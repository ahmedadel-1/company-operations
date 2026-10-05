import type { ProjectHealth, ProjectStatus, RequestStatus, SlaState, TicketStatus } from '@company-ops/db';

import type { DayBucket } from '../attendance/engine/derive.js';
import type { TicketQueueView } from '../support/ticket.service.js';

/** A list screen plus the filters that reproduce exactly the rows a number counts (ADR-0023). */
export interface DashboardLink {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly hash: string | null;
}

export interface DashboardMetric {
  readonly value: number;
  readonly link: DashboardLink | null;
}

export function dashboardLink(
  path: string,
  query: Readonly<Record<string, string | readonly string[] | undefined>> = {},
  hash: string | null = null,
): DashboardLink {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : value.join(',');
    if (text !== '') out[key] = text;
  }
  return { path, query: out, hash };
}

export const metric = (value: number, link: DashboardLink | null): DashboardMetric => ({ value, link });

/** Ticket queue filters a support number is defined by; the same object feeds the count and the link. */
export interface SupportMetricFilter {
  readonly view?: TicketQueueView;
  readonly status?: readonly TicketStatus[];
  readonly slaState?: readonly SlaState[];
  readonly assigneeMemberId?: string;
  readonly reporterMemberId?: string;
  readonly projectId?: string;
  readonly resolvedFrom?: string;
  readonly resolvedTo?: string;
}

export function supportLink(filter: SupportMetricFilter): DashboardLink {
  return dashboardLink('/support', {
    // Always explicit: the API's default view is `all`, while the queue screen opens on `open`.
    view: filter.view ?? 'all',
    status: filter.status,
    slaState: filter.slaState,
    assigneeMemberId: filter.assigneeMemberId,
    reporterMemberId: filter.reporterMemberId,
    projectId: filter.projectId,
    resolvedFrom: filter.resolvedFrom,
    resolvedTo: filter.resolvedTo,
  });
}

export interface ProjectMetricFilter {
  readonly status: readonly ProjectStatus[];
  readonly health?: readonly ProjectHealth[];
}

export const projectsLink = (filter: ProjectMetricFilter): DashboardLink =>
  dashboardLink('/projects', { status: filter.status, health: filter.health });

export const projectLink = (projectId: string, tab: string | null = null): DashboardLink =>
  dashboardLink(`/projects/${projectId}`, {}, tab);

export const approvalsLink = (overdue: boolean): DashboardLink =>
  dashboardLink('/approvals', overdue ? { overdue: 'true' } : {});

export const myRequestsLink = (status: readonly RequestStatus[]): DashboardLink =>
  dashboardLink('/requests', { status });

export const allRequestsLink = (status: readonly RequestStatus[]): DashboardLink =>
  dashboardLink('/requests', { view: 'all', status });

export const attendanceBucketLink = (date: string, bucket: DayBucket | null): DashboardLink =>
  dashboardLink('/attendance/team', { date, bucket: bucket ?? undefined }, 'day');

export const attendanceReviewsLink = (): DashboardLink => dashboardLink('/attendance/team', {}, 'reviews');
