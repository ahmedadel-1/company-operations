import type {
  GithubChecksState,
  GithubPrJiraLinkSource,
  GithubPrJiraLinkState,
  GithubPullRequestState,
  GithubReviewState,
  JiraStatusCategory,
  Prisma,
} from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { loadProjectForAccess } from '../projects/project-access.js';

/** Operational pull-request signals (never per-person metrics or rankings). */
export type GithubPullSignal = 'DRAFT' | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'FAILING_CHECKS' | 'STALE_SYNC';

export interface GithubPrJiraLinkView {
  readonly id: string;
  readonly state: GithubPrJiraLinkState;
  readonly source: GithubPrJiraLinkSource;
  readonly decidedAt: string | null;
  readonly issue: {
    readonly id: string;
    readonly key: string;
    readonly summary: string;
    readonly statusName: string;
    readonly statusCategory: JiraStatusCategory;
    readonly url: string;
    readonly projectId: string | null;
  };
}

export interface GithubPullView {
  readonly id: string;
  readonly repository: { readonly id: string; readonly fullName: string };
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: GithubPullRequestState;
  readonly draft: boolean;
  readonly authorLogin: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly reviewState: GithubReviewState;
  readonly requestedReviewerCount: number;
  readonly checksState: GithubChecksState;
  readonly checksTotal: number;
  readonly checksFailed: number;
  readonly checksPending: number;
  readonly ghCreatedAt: string;
  readonly ghUpdatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly lastSyncedAt: string;
  readonly signals: readonly GithubPullSignal[];
  /** Jira issues linked to the pull request that the caller may see. */
  readonly jiraLinks: readonly GithubPrJiraLinkView[];
  /** Keys found in the branch, title or description with no cached issue (never confirmed). */
  readonly unverifiedKeys: readonly string[];
}

export const pullViewSelect = {
  id: true,
  number: true,
  title: true,
  htmlUrl: true,
  state: true,
  draft: true,
  authorLogin: true,
  headRef: true,
  baseRef: true,
  reviewState: true,
  requestedReviewers: true,
  checksState: true,
  checksTotal: true,
  checksFailed: true,
  checksPending: true,
  ghCreatedAt: true,
  ghUpdatedAt: true,
  mergedAt: true,
  closedAt: true,
  lastSyncedAt: true,
  jiraKeys: true,
  repository: {
    select: { id: true, fullName: true, status: true, lastFullSyncAt: true, lastReconciledAt: true },
  },
  jiraLinks: {
    select: {
      id: true,
      state: true,
      source: true,
      decidedAt: true,
      issue: {
        select: {
          id: true,
          issueKey: true,
          summary: true,
          statusName: true,
          statusCategory: true,
          url: true,
          deletedInJiraAt: true,
          mapping: { select: { projectId: true, removedAt: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 50,
  },
} as const satisfies Prisma.GithubPullRequestSelect;

export type PullViewRow = Prisma.GithubPullRequestGetPayload<{ select: typeof pullViewSelect }>;

/** Default age after which a repository's cache is flagged as stale. */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function repositoryStale(
  repo: { status: string; lastFullSyncAt: Date | null; lastReconciledAt: Date | null },
  now: Date,
  staleAfterMs: number,
): boolean {
  if (repo.status !== 'AVAILABLE') {
    return true;
  }
  const marks = [repo.lastFullSyncAt, repo.lastReconciledAt].filter((mark): mark is Date => mark !== null);
  const latest = marks.length === 0 ? null : Math.max(...marks.map((mark) => mark.getTime()));
  return latest === null || now.getTime() - latest > staleAfterMs;
}

export function pullSignals(
  row: Pick<PullViewRow, 'state' | 'draft' | 'reviewState' | 'checksState' | 'repository'>,
  now: Date,
  staleAfterMs: number,
): GithubPullSignal[] {
  const signals: GithubPullSignal[] = [];
  if (row.state === 'OPEN') {
    if (row.draft) {
      signals.push('DRAFT');
    } else if (row.reviewState === 'REVIEW_REQUIRED' || row.reviewState === 'NONE') {
      signals.push('AWAITING_REVIEW');
    }
    if (row.reviewState === 'CHANGES_REQUESTED') {
      signals.push('CHANGES_REQUESTED');
    }
    if (row.checksState === 'FAILURE') {
      signals.push('FAILING_CHECKS');
    }
  }
  if (repositoryStale(row.repository, now, staleAfterMs)) {
    signals.push('STALE_SYNC');
  }
  return signals;
}

/**
 * Projects (by id) on which the caller holds `jira.view`. A Jira issue linked to a pull request is
 * shown only when the caller could see that issue in its own project's Jira tab, so a pull request
 * never reveals issue details from a project the caller cannot see.
 */
export async function jiraVisibleProjects(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  rows: readonly PullViewRow[],
): Promise<Set<string>> {
  const projectIds = new Set<string>();
  for (const row of rows) {
    for (const link of row.jiraLinks) {
      const projectId = link.issue.mapping?.projectId;
      if (projectId !== undefined) {
        projectIds.add(projectId);
      }
    }
  }
  const visible = new Set<string>();
  for (const projectId of projectIds) {
    const project = await loadProjectForAccess(db, organizationId, projectId);
    if (project !== null && canAccessResource(action.principal, 'jira.view', project.facts)) {
      visible.add(projectId);
    }
  }
  return visible;
}

export function toPullView(
  row: PullViewRow,
  jiraProjects: ReadonlySet<string>,
  now: Date,
  staleAfterMs: number,
): GithubPullView {
  const linkedKeys = new Set(row.jiraLinks.map((link) => link.issue.issueKey));
  const jiraLinks: GithubPrJiraLinkView[] = [];
  for (const link of row.jiraLinks) {
    const projectId = link.issue.mapping?.projectId ?? null;
    if (
      link.state === 'DISMISSED' ||
      link.issue.deletedInJiraAt !== null ||
      projectId === null ||
      !jiraProjects.has(projectId)
    ) {
      continue;
    }
    jiraLinks.push({
      id: link.id,
      state: link.state,
      source: link.source,
      decidedAt: link.decidedAt?.toISOString() ?? null,
      issue: {
        id: link.issue.id,
        key: link.issue.issueKey,
        summary: link.issue.summary,
        statusName: link.issue.statusName,
        statusCategory: link.issue.statusCategory,
        url: link.issue.url,
        projectId,
      },
    });
  }
  return {
    id: row.id,
    repository: { id: row.repository.id, fullName: row.repository.fullName },
    number: row.number,
    title: row.title,
    url: row.htmlUrl,
    state: row.state,
    draft: row.draft,
    authorLogin: row.authorLogin,
    headRef: row.headRef,
    baseRef: row.baseRef,
    reviewState: row.reviewState,
    requestedReviewerCount: row.requestedReviewers.length,
    checksState: row.checksState,
    checksTotal: row.checksTotal,
    checksFailed: row.checksFailed,
    checksPending: row.checksPending,
    ghCreatedAt: row.ghCreatedAt.toISOString(),
    ghUpdatedAt: row.ghUpdatedAt.toISOString(),
    mergedAt: row.mergedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    signals: pullSignals(row, now, staleAfterMs),
    jiraLinks,
    unverifiedKeys: row.jiraKeys.filter((key) => !linkedKeys.has(key)),
  };
}
