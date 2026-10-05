import type { GithubPullRequestState, GithubRepositoryStatus, GithubSyncState, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { holdsOrgWide, loadVisibleProject } from '../projects/project-access.js';
import type { LoadedProject } from '../projects/project-access.js';
import {
  DEFAULT_STALE_AFTER_MS,
  jiraVisibleProjects,
  pullViewSelect,
  repositoryStale,
  toPullView,
} from './github-views.js';
import type { GithubPullView } from './github-views.js';

export interface GithubJiraIssueOption {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly statusName: string;
  readonly url: string;
}

const ISSUE_SEARCH_LIMIT = 20;

export type GithubRepositoryHealth = 'OK' | 'SYNCING' | 'NOT_SYNCED' | 'STALE' | 'FAILED' | 'UNAVAILABLE' | 'SUSPENDED';

export interface GithubProjectRepositoryView {
  readonly id: string;
  readonly mappingId: string;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly status: GithubRepositoryStatus;
  readonly syncState: GithubSyncState;
  readonly lastSyncedAt: string | null;
  readonly openPullCount: number;
  readonly health: GithubRepositoryHealth;
}

export interface GithubProjectSignals {
  readonly open: number;
  readonly draft: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly failingChecks: number;
  readonly staleRepositories: number;
}

export interface GithubProjectOverview {
  readonly configured: boolean;
  readonly canManage: boolean;
  readonly canLink: boolean;
  readonly repositories: readonly GithubProjectRepositoryView[];
  readonly signals: GithubProjectSignals;
  readonly pulls: readonly GithubPullView[];
  readonly needsAttention: boolean;
}

const OVERVIEW_PULLS = 50;

/**
 * The project's GitHub tab (`github.view` on the project) and pull request ↔ Jira association
 * decisions (`github.link` and `jira.view` on the project). Reads only the local cache, with a fixed
 * number of queries per page. A pull request is visible here only through a repository actively
 * mapped to this project; a Jira issue can be associated only when it belongs to a Jira project
 * mapped to this same project, so links can never cross projects or organizations.
 */
export class GithubProjectService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly configured: boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  ) {}

  async overview(action: ActionContext, projectId: string): Promise<GithubProjectOverview> {
    const { organizationId, project } = await this.viewable(action, projectId);
    const now = this.now();
    const mappings = await this.db.githubRepositoryMapping.findMany({
      where: {
        organizationId,
        projectId: project.id,
        removedAt: null,
        repository: { installation: { status: { not: 'DISCONNECTED' } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: {
        id: true,
        repository: {
          select: {
            id: true,
            fullName: true,
            htmlUrl: true,
            private: true,
            archived: true,
            status: true,
            syncState: true,
            lastFullSyncAt: true,
            lastReconciledAt: true,
            installation: { select: { status: true } },
            syncRuns: { select: { status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
            _count: { select: { pullRequests: { where: { state: 'OPEN' } } } },
          },
        },
      },
    });
    const repositoryIds = mappings.map((mapping) => mapping.repository.id);
    const open: Prisma.GithubPullRequestWhereInput = {
      organizationId,
      repositoryId: { in: repositoryIds },
      state: 'OPEN',
    };
    // Sequential: the tenant client is one transaction connection, which cannot run queries concurrently.
    const openCount = await this.db.githubPullRequest.count({ where: open });
    const draft = await this.db.githubPullRequest.count({ where: { ...open, draft: true } });
    const awaitingReview = await this.db.githubPullRequest.count({
      where: { ...open, draft: false, reviewState: { in: ['REVIEW_REQUIRED', 'NONE'] } },
    });
    const changesRequested = await this.db.githubPullRequest.count({
      where: { ...open, reviewState: 'CHANGES_REQUESTED' },
    });
    const failingChecks = await this.db.githubPullRequest.count({ where: { ...open, checksState: 'FAILURE' } });
    const rows = await this.db.githubPullRequest.findMany({
      where: open,
      orderBy: [{ ghUpdatedAt: 'desc' }, { id: 'desc' }],
      take: OVERVIEW_PULLS,
      select: pullViewSelect,
    });
    const repositories = mappings.map((mapping): GithubProjectRepositoryView => {
      const repo = mapping.repository;
      const marks = [repo.lastFullSyncAt, repo.lastReconciledAt].filter((mark): mark is Date => mark !== null);
      const last = marks.length === 0 ? null : new Date(Math.max(...marks.map((mark) => mark.getTime())));
      return {
        id: repo.id,
        mappingId: mapping.id,
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        private: repo.private,
        archived: repo.archived,
        status: repo.status,
        syncState: repo.syncState,
        lastSyncedAt: last?.toISOString() ?? null,
        openPullCount: repo._count.pullRequests,
        health: this.health(repo, now),
      };
    });
    const jiraProjects = await jiraVisibleProjects(this.db, action, organizationId, rows);
    return {
      configured: this.configured,
      canManage: holdsOrgWide(action.principal, 'integration.manage'),
      canLink: this.canLink(action, project),
      repositories,
      signals: {
        open: openCount,
        draft,
        awaitingReview,
        changesRequested,
        failingChecks,
        staleRepositories: repositories.filter((repo) => repo.health !== 'OK' && repo.health !== 'SYNCING').length,
      },
      pulls: rows.map((row) => toPullView(row, jiraProjects, now, this.staleAfterMs)),
      needsAttention: repositories.some((repo) => repo.health !== 'OK' && repo.health !== 'SYNCING'),
    };
  }

  async listPulls(
    action: ActionContext,
    projectId: string,
    options: {
      state?: GithubPullRequestState | undefined;
      repositoryId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<Page<GithubPullView>> {
    const { organizationId, project } = await this.viewable(action, projectId);
    const size = pageSize(options.limit);
    const and: Prisma.GithubPullRequestWhereInput[] = [];
    if (options.cursor !== undefined) {
      const [updatedAt = '', id = ''] = decodeCursor(options.cursor, 2);
      const at = new Date(updatedAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ ghUpdatedAt: { lt: at } }, { ghUpdatedAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.githubPullRequest.findMany({
      where: {
        organizationId,
        repository: { mappings: { some: { projectId: project.id, removedAt: null } } },
        ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }),
        ...(options.state === undefined ? {} : { state: options.state }),
        AND: and,
      },
      orderBy: [{ ghUpdatedAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: pullViewSelect,
    });
    const page = toPage(rows, size, (row) => [row.ghUpdatedAt.toISOString(), row.id]);
    const jiraProjects = await jiraVisibleProjects(this.db, action, organizationId, page.items);
    const now = this.now();
    return {
      items: page.items.map((row) => toPullView(row, jiraProjects, now, this.staleAfterMs)),
      nextCursor: page.nextCursor,
    };
  }

  /** Manually associates a cached Jira issue of this project with a pull request of this project. */
  async linkJiraIssue(
    action: ActionContext,
    projectId: string,
    pullRequestId: string,
    issueId: string,
  ): Promise<GithubPullView> {
    const { organizationId, project } = await this.linkable(action, projectId);
    await this.db.$transaction(async (tx) => {
      const pull = await this.projectPull(tx, organizationId, project.id, pullRequestId);
      const issue = await tx.jiraIssue.findFirst({
        where: {
          organizationId,
          id: issueId,
          deletedInJiraAt: null,
          mapping: { projectId: project.id, removedAt: null },
        },
        select: { id: true, issueKey: true },
      });
      if (issue === null) {
        throw new NotFoundError('Jira issue');
      }
      const existing = await tx.githubPrJiraLink.findFirst({
        where: { organizationId, pullRequestId: pull.id, issueId: issue.id },
        select: { id: true, state: true },
      });
      if (existing?.state === 'CONFIRMED') {
        throw new ConflictError('This Jira issue is already linked to the pull request.');
      }
      const decided = {
        state: 'CONFIRMED' as const,
        decidedByMemberId: action.principal.memberId,
        decidedAt: this.now(),
      };
      try {
        if (existing === null) {
          await tx.githubPrJiraLink.create({
            data: { organizationId, pullRequestId: pull.id, issueId: issue.id, source: 'MANUAL', ...decided },
            select: { id: true },
          });
        } else {
          await tx.githubPrJiraLink.updateMany({ where: { organizationId, id: existing.id }, data: decided });
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('This Jira issue was linked at the same time. Reload and try again.');
        }
        throw error;
      }
      await recordAudit(tx, organizationId, {
        action: 'github.pr_link.linked',
        entityType: 'github_pull_request',
        entityId: pull.id,
        actor: userActor(action),
        metadata: { projectId: project.id, issueId: issue.id, issueKey: issue.issueKey, number: pull.number },
        context: action.request,
      });
    });
    return this.pullView(action, organizationId, pullRequestId);
  }

  /**
   * Cached Jira issues of the Jira projects mapped to this project, for the manual link picker
   * (local cache only; never a live Jira call). Same permissions as linking.
   */
  async searchJiraIssues(action: ActionContext, projectId: string, q: string): Promise<GithubJiraIssueOption[]> {
    const { organizationId, project } = await this.linkable(action, projectId);
    const query = q.trim().slice(0, 100);
    const rows = await this.db.jiraIssue.findMany({
      where: {
        organizationId,
        deletedInJiraAt: null,
        mapping: { projectId: project.id, removedAt: null },
        ...(query === ''
          ? {}
          : {
              OR: [
                { issueKey: { startsWith: query.toUpperCase() } },
                { summary: { contains: query, mode: 'insensitive' } },
              ],
            }),
      },
      orderBy: [{ jiraUpdatedAt: 'desc' }, { id: 'desc' }],
      take: ISSUE_SEARCH_LIMIT,
      select: { id: true, issueKey: true, summary: true, statusName: true, url: true },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.issueKey,
      summary: row.summary,
      statusName: row.statusName,
      url: row.url,
    }));
  }

  /** Confirms a suggested association (the issue must belong to this project's Jira mapping). */
  async confirmLink(action: ActionContext, projectId: string, linkId: string): Promise<GithubPullView> {
    return this.decide(action, projectId, linkId, 'CONFIRMED');
  }

  /** Dismisses an association; inference never recreates or upgrades a dismissed one. */
  async dismissLink(action: ActionContext, projectId: string, linkId: string): Promise<GithubPullView> {
    return this.decide(action, projectId, linkId, 'DISMISSED');
  }

  private async decide(
    action: ActionContext,
    projectId: string,
    linkId: string,
    state: 'CONFIRMED' | 'DISMISSED',
  ): Promise<GithubPullView> {
    const { organizationId, project } = await this.linkable(action, projectId);
    const pullRequestId = await this.db.$transaction(async (tx) => {
      const link = await tx.githubPrJiraLink.findFirst({
        where: {
          organizationId,
          id: linkId,
          pullRequest: { repository: { mappings: { some: { projectId: project.id, removedAt: null } } } },
          issue: { mapping: { projectId: project.id } },
        },
        select: { id: true, state: true, pullRequestId: true, issue: { select: { id: true, issueKey: true } } },
      });
      if (link === null) {
        throw new NotFoundError('Jira association');
      }
      if (link.state !== state) {
        await tx.githubPrJiraLink.updateMany({
          where: { organizationId, id: link.id },
          data: { state, decidedByMemberId: action.principal.memberId, decidedAt: this.now() },
        });
        await recordAudit(tx, organizationId, {
          action: state === 'CONFIRMED' ? 'github.pr_link.confirmed' : 'github.pr_link.dismissed',
          entityType: 'github_pull_request',
          entityId: link.pullRequestId,
          actor: userActor(action),
          metadata: { projectId: project.id, linkId: link.id, issueId: link.issue.id, issueKey: link.issue.issueKey },
          context: action.request,
        });
      }
      return link.pullRequestId;
    });
    return this.pullView(action, organizationId, pullRequestId);
  }

  private async projectPull(
    tx: TenantDb,
    organizationId: string,
    projectId: string,
    pullRequestId: string,
  ): Promise<{ id: string; number: number }> {
    const pull = await tx.githubPullRequest.findFirst({
      where: {
        organizationId,
        id: pullRequestId,
        repository: { mappings: { some: { projectId, removedAt: null } } },
      },
      select: { id: true, number: true },
    });
    if (pull === null) {
      throw new NotFoundError('Pull request');
    }
    return pull;
  }

  private async pullView(
    action: ActionContext,
    organizationId: string,
    pullRequestId: string,
  ): Promise<GithubPullView> {
    const row = await this.db.githubPullRequest.findFirst({
      where: { organizationId, id: pullRequestId },
      select: pullViewSelect,
    });
    if (row === null) {
      throw new NotFoundError('Pull request');
    }
    const jiraProjects = await jiraVisibleProjects(this.db, action, organizationId, [row]);
    return toPullView(row, jiraProjects, this.now(), this.staleAfterMs);
  }

  private health(
    repo: {
      status: GithubRepositoryStatus;
      syncState: GithubSyncState;
      lastFullSyncAt: Date | null;
      lastReconciledAt: Date | null;
      installation: { status: string };
      syncRuns: readonly { status: string }[];
    },
    now: Date,
  ): GithubRepositoryHealth {
    if (repo.installation.status === 'SUSPENDED') {
      return 'SUSPENDED';
    }
    if (repo.status !== 'AVAILABLE' || repo.installation.status !== 'ACTIVE') {
      return 'UNAVAILABLE';
    }
    const lastRun = repo.syncRuns[0]?.status;
    if (lastRun === 'QUEUED' || lastRun === 'RUNNING') {
      return 'SYNCING';
    }
    if (lastRun === 'FAILED') {
      return 'FAILED';
    }
    if (repo.lastFullSyncAt === null) {
      return 'NOT_SYNCED';
    }
    return repositoryStale(repo, now, this.staleAfterMs) ? 'STALE' : 'OK';
  }

  private canLink(action: ActionContext, project: LoadedProject): boolean {
    return (
      canAccessResource(action.principal, 'github.link', project.facts) &&
      canAccessResource(action.principal, 'jira.view', project.facts)
    );
  }

  private async viewable(
    action: ActionContext,
    projectId: string,
  ): Promise<{ organizationId: string; project: LoadedProject }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    if (!canAccessResource(action.principal, 'github.view', project.facts)) {
      throw new ForbiddenError();
    }
    return { organizationId, project };
  }

  private async linkable(
    action: ActionContext,
    projectId: string,
  ): Promise<{ organizationId: string; project: LoadedProject }> {
    const viewable = await this.viewable(action, projectId);
    if (!this.canLink(action, viewable.project)) {
      throw new ForbiddenError();
    }
    return viewable;
  }
}
