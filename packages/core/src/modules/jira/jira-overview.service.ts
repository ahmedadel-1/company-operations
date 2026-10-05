import type { JiraConnectionStatus, JiraStatusCategory } from '@company-ops/db';

import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { holdsOrgWide, loadVisibleProject } from '../projects/project-access.js';
import { mappingSelect, toMappingView } from './jira-admin.service.js';
import type { JiraMappingView } from './jira-admin.service.js';
import { issueViewSelect, toIssueView } from './jira-links.service.js';
import type { JiraIssueView } from './jira-links.service.js';

/**
 * Phase 4 delivery signals for one project (ROADMAP Phase 4): counts derived from the issue cache.
 * Operational indicators only — never per-person productivity metrics.
 */
export interface JiraProjectSignals {
  readonly open: number;
  readonly byCategory: Readonly<Record<JiraStatusCategory, number>>;
  readonly blocked: number;
  readonly overdue: number;
  readonly linkedTickets: number;
}

export interface JiraProjectOverview {
  readonly configured: boolean;
  readonly connectionStatus: Exclude<JiraConnectionStatus, 'DISCONNECTED'> | null;
  readonly siteUrl: string | null;
  readonly canManage: boolean;
  readonly mappings: readonly JiraMappingView[];
  readonly signals: JiraProjectSignals;
  readonly recentIssues: readonly JiraIssueView[];
  /** A sync of one of the mappings failed or the connection needs attention. */
  readonly needsAttention: boolean;
}

const RECENT_LIMIT = 20;

/** The project's Jira tab (`jira.view` on the project); a fixed number of queries regardless of size. */
export class JiraOverviewService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly configured: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async projectOverview(action: ActionContext, projectId: string): Promise<JiraProjectOverview> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    if (!canAccessResource(action.principal, 'jira.view', project.facts)) {
      throw new ForbiddenError();
    }
    const [connection, mappingRows] = await Promise.all([
      this.db.jiraConnection.findFirst({
        where: { organizationId, status: { not: 'DISCONNECTED' } },
        select: { id: true, status: true, siteUrl: true },
      }),
      this.db.jiraProjectMapping.findMany({
        where: {
          organizationId,
          projectId: project.id,
          removedAt: null,
          connection: { status: { not: 'DISCONNECTED' } },
        },
        orderBy: [{ jiraProjectKey: 'asc' }, { id: 'asc' }],
        select: mappingSelect,
      }),
    ]);
    const mappingIds = mappingRows.map((row) => row.id);
    const live = { organizationId, mappingId: { in: mappingIds }, deletedInJiraAt: null };
    const today = new Date(`${this.now().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const [categories, blocked, overdue, linkedTickets, recent] = await Promise.all([
      this.db.jiraIssue.groupBy({ by: ['statusCategory'], where: live, _count: { _all: true } }),
      this.db.jiraIssue.count({ where: { ...live, isBlocked: true, statusCategory: { not: 'DONE' } } }),
      this.db.jiraIssue.count({ where: { ...live, dueDate: { lt: today }, statusCategory: { not: 'DONE' } } }),
      this.db.supportTicketJiraLink.groupBy({
        by: ['ticketId'],
        where: { organizationId, issue: { mappingId: { in: mappingIds }, deletedInJiraAt: null } },
      }),
      this.db.jiraIssue.findMany({
        where: live,
        orderBy: [{ jiraUpdatedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_LIMIT,
        select: issueViewSelect,
      }),
    ]);
    const byCategory: Record<JiraStatusCategory, number> = { TODO: 0, IN_PROGRESS: 0, DONE: 0 };
    for (const row of categories) {
      byCategory[row.statusCategory] = row._count._all;
    }
    const mappings = mappingRows.map(toMappingView);
    const status = connection === null || connection.status === 'DISCONNECTED' ? null : connection.status;
    return {
      configured: this.configured,
      connectionStatus: status,
      siteUrl: connection?.siteUrl ?? null,
      canManage: holdsOrgWide(action.principal, 'integration.manage'),
      mappings,
      signals: {
        open: byCategory.TODO + byCategory.IN_PROGRESS,
        byCategory,
        blocked,
        overdue,
        linkedTickets: linkedTickets.length,
      },
      recentIssues: recent.map(toIssueView),
      needsAttention:
        (status !== null && status !== 'ACTIVE') ||
        mappings.some(
          (mapping) =>
            mapping.lastRun !== null &&
            (mapping.lastRun.status === 'FAILED' || mapping.lastRun.status === 'PARTIALLY_FAILED'),
        ),
    };
  }
}
