import type { GithubPullRequestState, Prisma } from '@company-ops/db';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import type { GithubInstallationClient } from './github-client.js';
import { deriveChecks, deriveReviewState, requestedReviewerList } from './github-derive.js';
import { inferJiraKeys } from './github-jira-keys.js';
import type { InferredKey } from './github-jira-keys.js';
import type { PullRequestWire } from './github-wire.js';

export type PullApplyOutcome = 'created' | 'updated' | 'unchanged' | 'stale';

/** The cached repository a pull request belongs to. */
export interface RepoPlacement {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly fullName: string;
}

const pullSelect = {
  id: true,
  headSha: true,
  state: true,
  ghUpdatedAt: true,
  detailsSha: true,
  detailsFetchedAt: true,
  requestedReviewers: true,
  number: true,
  title: true,
} as const satisfies Prisma.GithubPullRequestSelect;

export type StoredPull = Prisma.GithubPullRequestGetPayload<{ select: typeof pullSelect }>;

export function pullState(wire: Pick<PullRequestWire, 'state' | 'merged_at'>): GithubPullRequestState {
  if (wire.merged_at !== null && wire.merged_at !== undefined) {
    return 'MERGED';
  }
  return wire.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullData(wire: PullRequestWire, now: Date) {
  const state = pullState(wire);
  const closedRaw = wire.closed_at ?? wire.merged_at ?? wire.updated_at;
  return {
    githubPrId: BigInt(wire.id),
    nodeId: wire.node_id,
    number: wire.number,
    title: wire.title,
    state,
    draft: wire.draft,
    authorLogin: wire.user?.login ?? null,
    headRef: wire.head.ref,
    baseRef: wire.base.ref,
    headSha: wire.head.sha,
    requestedReviewers: requestedReviewerList(wire),
    htmlUrl: wire.html_url,
    ghCreatedAt: new Date(wire.created_at),
    ghUpdatedAt: new Date(wire.updated_at),
    mergedAt:
      state === 'MERGED' && wire.merged_at !== null && wire.merged_at !== undefined ? new Date(wire.merged_at) : null,
    closedAt: state === 'OPEN' ? null : new Date(closedRaw),
    lastSyncedAt: now,
  };
}

/**
 * Applies a pull request snapshot fetched from GitHub. The out-of-order guard is GitHub's
 * `updated_at`: an older snapshot never overwrites a newer one (the update is conditional on the
 * stored value, so concurrent writers cannot interleave either). Only metadata is written; the
 * description is scanned for Jira keys by the caller and never stored.
 */
export async function upsertPull(
  db: TenantDb,
  placement: RepoPlacement,
  wire: PullRequestWire,
  now: Date,
): Promise<{ outcome: PullApplyOutcome; pull: StoredPull }> {
  const { organizationId, repositoryId } = placement;
  const data = pullData(wire, now);
  const existing = await db.githubPullRequest.findFirst({
    where: { organizationId, repositoryId, githubPrId: data.githubPrId },
    select: pullSelect,
  });
  if (existing === null) {
    try {
      const created = await db.githubPullRequest.create({
        data: { organizationId, repositoryId, ...data },
        select: pullSelect,
      });
      if (created.state === 'MERGED') {
        await recordMerged(db, placement, created, wire);
      }
      return { outcome: 'created', pull: created };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return upsertPull(db, placement, wire, now);
    }
  }
  if (existing.ghUpdatedAt.getTime() > data.ghUpdatedAt.getTime()) {
    return { outcome: 'stale', pull: existing };
  }
  const changed =
    existing.ghUpdatedAt.getTime() !== data.ghUpdatedAt.getTime() ||
    existing.headSha !== data.headSha ||
    existing.state !== data.state ||
    existing.title !== data.title ||
    existing.requestedReviewers.join(',') !== data.requestedReviewers.join(',');
  const updated = await db.githubPullRequest.updateMany({
    where: { organizationId, id: existing.id, ghUpdatedAt: { lte: data.ghUpdatedAt } },
    data: changed ? data : { lastSyncedAt: now },
  });
  if (updated.count === 0) {
    return { outcome: 'stale', pull: existing };
  }
  const pull = { ...existing, ...(changed ? data : {}) };
  if (changed && existing.state !== 'MERGED' && data.state === 'MERGED') {
    await recordMerged(db, placement, pull, wire);
  }
  return { outcome: changed ? 'updated' : 'unchanged', pull };
}

/** Timeline entry on every project the repository is mapped to, only on the transition to merged. */
async function recordMerged(
  db: TenantDb,
  placement: RepoPlacement,
  pull: { id: string; number: number; title: string },
  wire: PullRequestWire,
): Promise<void> {
  const mappings = await db.githubRepositoryMapping.findMany({
    where: { organizationId: placement.organizationId, repositoryId: placement.repositoryId, removedAt: null },
    select: { projectId: true },
  });
  for (const mapping of mappings) {
    await recordProjectActivity(db, placement.organizationId, mapping.projectId, null, {
      source: 'GITHUB',
      type: 'github.pr_merged',
      entityType: 'github_pull_request',
      entityId: pull.id,
      summaryParams: {
        repository: placement.fullName,
        number: pull.number,
        title: pull.title.slice(0, 200),
        author: wire.user?.login ?? null,
      },
    });
  }
}

/**
 * Review and check summary for the PR's current head commit. `fetchStartedAt` is taken before the
 * GitHub calls; the write only lands when it is newer than the last applied fetch and the head
 * commit has not moved meanwhile, so a slow, older fetch never overwrites a newer summary.
 */
export async function refreshPullDetails(
  db: TenantDb,
  client: GithubInstallationClient,
  placement: RepoPlacement,
  pull: Pick<StoredPull, 'id' | 'number' | 'headSha' | 'requestedReviewers'>,
  now: () => Date,
): Promise<'applied' | 'stale'> {
  const fetchStartedAt = now();
  const [reviews, runs, status] = await Promise.all([
    client.listReviews(placement.fullName, pull.number),
    client.listCheckRuns(placement.fullName, pull.headSha),
    client.combinedStatus(placement.fullName, pull.headSha),
  ]);
  const checks = deriveChecks(runs, status);
  const updated = await db.githubPullRequest.updateMany({
    where: {
      organizationId: placement.organizationId,
      id: pull.id,
      headSha: pull.headSha,
      OR: [{ detailsFetchedAt: null }, { detailsFetchedAt: { lt: fetchStartedAt } }],
    },
    data: {
      reviewState: deriveReviewState(reviews, pull.requestedReviewers),
      checksState: checks.state,
      checksTotal: checks.total,
      checksFailed: checks.failed,
      checksPending: checks.pending,
      detailsSha: pull.headSha,
      detailsFetchedAt: fetchStartedAt,
    },
  });
  return updated.count > 0 ? 'applied' : 'stale';
}

/**
 * Clock allowance between the API process (delivery `receivedAt`) and the worker (`detailsFetchedAt`).
 * Reconciliation corrects anything a larger skew would make the coalescing below skip.
 */
export const DETAILS_COALESCE_MARGIN_MS = 5_000;

/**
 * Whether the stored review/check summary was fetched after a delivery arrived, so it already
 * reflects that delivery. Bursts of check and review events then cost one refresh, not one each.
 */
export function detailsCoverDelivery(
  pull: Pick<StoredPull, 'headSha' | 'detailsSha'> & { readonly detailsFetchedAt: Date | null },
  receivedAt: Date,
): boolean {
  return (
    pull.detailsSha === pull.headSha &&
    pull.detailsFetchedAt !== null &&
    pull.detailsFetchedAt.getTime() >= receivedAt.getTime() + DETAILS_COALESCE_MARGIN_MS
  );
}

/** Details need refetching when the head moved or they were never fetched for this head. */
export function detailsOutdated(pull: Pick<StoredPull, 'headSha' | 'detailsSha' | 'state'>): boolean {
  return pull.state === 'OPEN' && pull.detailsSha !== pull.headSha;
}

/**
 * Jira association from inferred keys. Keys whose prefix is not a mapped Jira project key of the
 * organization are dropped (noise such as `UTF-8`). A key becomes a link only when the issue is in
 * the Jira cache: CONFIRMED automatically when the issue's Jira project is mapped to a project the
 * repository is also mapped to, SUGGESTED otherwise. Keys without a cached issue stay on the pull
 * request as unverified suggestions. A DISMISSED link is never recreated or upgraded, and nothing
 * here ever invents an issue.
 */
export async function refreshJiraAssociation(
  db: TenantDb,
  placement: RepoPlacement,
  pullId: string,
  input: { branch: string; title: string; body: string | null },
  now: Date,
): Promise<{ keys: string[]; confirmed: number; suggested: number }> {
  const { organizationId } = placement;
  const prefixes = new Set(
    (
      await db.jiraProjectMapping.findMany({
        where: { organizationId, removedAt: null },
        select: { jiraProjectKey: true },
      })
    ).map((row) => row.jiraProjectKey.toUpperCase()),
  );
  const keys = inferJiraKeys(input).filter((item) => prefixes.has(item.key.slice(0, item.key.lastIndexOf('-'))));
  await db.githubPullRequest.updateMany({
    where: { organizationId, id: pullId },
    data: { jiraKeys: keys.map((item) => item.key) },
  });
  if (keys.length === 0) {
    return { keys: [], confirmed: 0, suggested: 0 };
  }
  return applyInferredLinks(db, placement, pullId, keys, now);
}

async function applyInferredLinks(
  db: TenantDb,
  placement: RepoPlacement,
  pullId: string,
  keys: readonly InferredKey[],
  now: Date,
): Promise<{ keys: string[]; confirmed: number; suggested: number }> {
  const { organizationId, repositoryId } = placement;
  const sourceByKey = new Map(keys.map((item) => [item.key, item.source]));
  const issues = await db.jiraIssue.findMany({
    where: { organizationId, issueKey: { in: [...sourceByKey.keys()] }, deletedInJiraAt: null },
    select: { id: true, issueKey: true, mapping: { select: { projectId: true, removedAt: true } } },
    orderBy: { lastSyncedAt: 'desc' },
  });
  const repoProjects = new Set(
    (
      await db.githubRepositoryMapping.findMany({
        where: { organizationId, repositoryId, removedAt: null },
        select: { projectId: true },
      })
    ).map((row) => row.projectId),
  );
  const existing = new Map(
    (
      await db.githubPrJiraLink.findMany({
        where: { organizationId, pullRequestId: pullId },
        select: { id: true, issueId: true, state: true },
      })
    ).map((row) => [row.issueId, row]),
  );
  const seenKeys = new Set<string>();
  let confirmed = 0;
  let suggested = 0;
  for (const issue of issues) {
    if (seenKeys.has(issue.issueKey)) {
      continue;
    }
    seenKeys.add(issue.issueKey);
    const source = sourceByKey.get(issue.issueKey) ?? 'BODY';
    const verified =
      issue.mapping !== null && issue.mapping.removedAt === null && repoProjects.has(issue.mapping.projectId);
    const current = existing.get(issue.id);
    if (current === undefined) {
      try {
        await db.githubPrJiraLink.create({
          data: {
            organizationId,
            pullRequestId: pullId,
            issueId: issue.id,
            source,
            state: verified ? 'CONFIRMED' : 'SUGGESTED',
            decidedAt: verified ? now : null,
          },
          select: { id: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    } else if (current.state === 'SUGGESTED' && verified) {
      await db.githubPrJiraLink.updateMany({
        where: { organizationId, id: current.id, state: 'SUGGESTED' },
        data: { state: 'CONFIRMED', decidedAt: now, decidedByMemberId: null },
      });
    }
    if (verified || current?.state === 'CONFIRMED') {
      confirmed += 1;
    } else if (current?.state !== 'DISMISSED') {
      suggested += 1;
    }
  }
  return { keys: keys.map((item) => item.key), confirmed, suggested };
}

/** Re-runs inference from stored keys only (no GitHub call): picks up Jira issues cached later. */
export async function relinkFromStoredKeys(
  db: TenantDb,
  placement: RepoPlacement,
  pull: { id: string; jiraKeys: readonly string[]; headRef: string; title: string },
  now: Date,
): Promise<void> {
  if (pull.jiraKeys.length === 0) {
    return;
  }
  const visible = new Map(
    inferJiraKeys({ branch: pull.headRef, title: pull.title, body: null }).map((k) => [k.key, k]),
  );
  const keys: InferredKey[] = pull.jiraKeys.map((key) => visible.get(key) ?? { key, source: 'BODY' });
  await applyInferredLinks(db, placement, pull.id, keys, now);
}
