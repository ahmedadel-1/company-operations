import type { GithubSyncRunStatus, GithubSyncRunType, Prisma } from '@company-ops/db';

import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import type { GithubInstallationClient } from './github-client.js';
import { repoSyncLockKey } from './github-coordination.js';
import { GithubApiError } from './github-errors.js';
import { githubBackoffDelay } from './github-http.js';
import {
  detailsOutdated,
  refreshJiraAssociation,
  refreshPullDetails,
  relinkFromStoredKeys,
  upsertPull,
} from './github-pr-store.js';
import type { RepoPlacement } from './github-pr-store.js';
import { enqueueInstallationSync } from './github-runs.js';
import type { GithubRuntime } from './github-runtime.js';
import type { PullRequestWire } from './github-wire.js';

export type GithubSliceOutcome =
  | { readonly kind: 'finished'; readonly status: GithubSyncRunStatus }
  | { readonly kind: 'continue' }
  | { readonly kind: 'retry_later'; readonly delayMs: number }
  | { readonly kind: 'skipped' };

export interface GithubSyncEngineOptions {
  readonly maxPagesPerSlice?: number;
  readonly sliceBudgetMs?: number;
  readonly maxConsecutiveErrors?: number;
  /** Closed pull requests older than this are not imported. */
  readonly historyDays?: number;
}

/** Re-read window of reconciliation (clock skew between GitHub's `updated_at` and our clock). */
export const GITHUB_RECONCILE_OVERLAP_MS = 10 * 60 * 1000;
/** Hard stop for a single listing (100 per page): protects against unbounded paging. */
export const MAX_LIST_PAGES = 500;
const RELINK_BATCH = 100;
const MAX_SUMMARY = 500;

const ACTIVE: readonly GithubSyncRunStatus[] = ['QUEUED', 'RUNNING'];
const FULL_TYPES: readonly GithubSyncRunType[] = ['INITIAL_SYNC', 'MANUAL_RESYNC'];

type Phase = 'open' | 'closed' | 'updated' | 'relink';

/** Durable checkpoint: the listing phase, the next page to read and, for relinking, the last row. */
interface Cursor {
  readonly phase: Phase;
  readonly page: number;
  readonly afterId?: string;
}

function parseCursor(value: Prisma.JsonValue): Cursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const phase = value.phase;
  const page = value.page;
  if (
    (phase !== 'open' && phase !== 'closed' && phase !== 'updated' && phase !== 'relink') ||
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > MAX_LIST_PAGES + 1
  ) {
    return null;
  }
  const afterId = value.afterId;
  return typeof afterId === 'string' && afterId.length <= 64 ? { phase, page, afterId } : { phase, page };
}

interface Tally {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

const emptyTally = (): Tally => ({ processed: 0, created: 0, updated: 0, unchanged: 0, failed: 0 });

const runSelect = {
  id: true,
  type: true,
  status: true,
  cancelRequested: true,
  startedAt: true,
  recordsFailed: true,
  consecutiveErrors: true,
  lastCursor: true,
  installationId: true,
  repositoryId: true,
  installation: { select: { id: true, githubInstallationId: true, status: true } },
  repository: {
    select: {
      id: true,
      fullName: true,
      status: true,
      lastFullSyncAt: true,
      lastReconciledAt: true,
      lastActivityAt: true,
    },
  },
} as const satisfies Prisma.GithubSyncRunSelect;

type RunRow = Prisma.GithubSyncRunGetPayload<{ select: typeof runSelect }>;

/** Publishes "run changed" hints (identifiers only) to integration administrators. */
export type GithubSyncProgressPublisher = (organizationId: string, runId: string) => Promise<void>;

/**
 * Pull request synchronization runs for one repository, executed in bounded slices (worker, system
 * tenant context of the run's organization), mirroring the Jira engine:
 *
 * - Initial sync / manual resync: every open pull request, then closed ones by `updated_at` (newest
 *   first) until they are older than the history window (default 90 days).
 * - Reconciliation: everything updated since the last pass (minus an overlap), newest first, then a
 *   local re-link pass that turns stored Jira keys into links for issues cached since.
 *
 * Every page persists its checkpoint and counters, so a crash resumes from the last page; writes
 * are idempotent and guarded by GitHub's `updated_at`, so re-reading is harmless. Review and check
 * details are fetched only for open pull requests whose head commit changed. Rate limits pause the
 * whole installation and the slice is retried after the reset. One slice at a time per repository.
 */
export class GithubSyncEngine {
  private readonly maxPages: number;
  private readonly budgetMs: number;
  private readonly maxErrors: number;
  private readonly historyMs: number;

  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: GithubRuntime,
    private readonly publish: GithubSyncProgressPublisher,
    options: GithubSyncEngineOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxPages = options.maxPagesPerSlice ?? 5;
    this.budgetMs = options.sliceBudgetMs ?? 20_000;
    this.maxErrors = options.maxConsecutiveErrors ?? 5;
    this.historyMs = (options.historyDays ?? 90) * 24 * 60 * 60 * 1000;
  }

  async runSlice(runId: string): Promise<GithubSliceOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const run = await this.load(organizationId, runId);
    if (run === null || !ACTIVE.includes(run.status)) {
      return { kind: 'skipped' };
    }
    const blocked = await this.blocker(organizationId, run);
    if (blocked !== null) {
      return this.finish(organizationId, run, 'CANCELLED', blocked);
    }
    const lock = await this.runtime.coordination.tryLock(repoSyncLockKey(run.repositoryId), this.budgetMs + 60_000);
    if (lock === null) {
      return { kind: 'retry_later', delayMs: 5_000 };
    }
    try {
      const paused = await this.runtime.coordination.pausedUntil(run.installationId);
      if (paused !== null) {
        return { kind: 'retry_later', delayMs: Math.max(1_000, paused - this.now().getTime()) };
      }
      await this.markRunning(organizationId, run);
      const client = this.runtime.clients.forInstallation({
        installationRowId: run.installation.id,
        githubInstallationId: run.installation.githubInstallationId.toString(),
      });
      return await this.slice(organizationId, run, client);
    } catch (error) {
      if (error instanceof GithubApiError) {
        return await this.onGithubError(organizationId, runId, error);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  private load(organizationId: string, runId: string): Promise<RunRow | null> {
    return this.db.githubSyncRun.findFirst({ where: { organizationId, id: runId }, select: runSelect });
  }

  private async blocker(organizationId: string, run: RunRow): Promise<{ code: string; summary: string } | null> {
    if (run.cancelRequested) {
      return { code: 'cancelled', summary: 'The run was cancelled.' };
    }
    if (run.installation.status !== 'ACTIVE') {
      return { code: 'installation_inactive', summary: 'The GitHub installation is not active.' };
    }
    if (run.repository.status !== 'AVAILABLE') {
      return { code: 'repository_unavailable', summary: 'The repository is no longer accessible to the App.' };
    }
    const mapped = await this.db.githubRepositoryMapping.findFirst({
      where: { organizationId, repositoryId: run.repositoryId, removedAt: null },
      select: { id: true },
    });
    return mapped === null ? { code: 'unmapped', summary: 'The repository is no longer mapped to a project.' } : null;
  }

  private async markRunning(organizationId: string, run: RunRow): Promise<void> {
    if (run.status !== 'QUEUED') {
      return;
    }
    await this.db.$transaction(async (tx) => {
      await tx.githubSyncRun.updateMany({
        where: { organizationId, id: run.id, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt: run.startedAt ?? this.now() },
      });
      if (FULL_TYPES.includes(run.type)) {
        await tx.githubRepository.updateMany({
          where: { organizationId, id: run.repositoryId },
          data: { syncState: 'RUNNING' },
        });
      }
    });
    await this.publish(organizationId, run.id);
  }

  /** Reconciliation without a completed full sync behaves like an initial sync. */
  private reconcileSince(run: RunRow): Date | null {
    if (FULL_TYPES.includes(run.type) || run.repository.lastFullSyncAt === null) {
      return null;
    }
    const mark = run.repository.lastReconciledAt ?? run.repository.lastFullSyncAt;
    return new Date(mark.getTime() - GITHUB_RECONCILE_OVERLAP_MS);
  }

  private async slice(
    organizationId: string,
    initial: RunRow,
    client: GithubInstallationClient,
  ): Promise<GithubSliceOutcome> {
    const deadline = this.now().getTime() + this.budgetMs;
    const placement: RepoPlacement = {
      organizationId,
      repositoryId: initial.repositoryId,
      fullName: initial.repository.fullName,
    };
    const since = this.reconcileSince(initial);
    let run = initial;
    for (let step = 0; step < this.maxPages && this.now().getTime() < deadline; step += 1) {
      if (step > 0) {
        const fresh = await this.load(organizationId, run.id);
        if (fresh === null || !ACTIVE.includes(fresh.status)) {
          return { kind: 'skipped' };
        }
        if (fresh.cancelRequested) {
          return this.finish(organizationId, fresh, 'CANCELLED', null);
        }
        run = fresh;
      }
      const cursor = parseCursor(run.lastCursor) ?? { phase: since === null ? 'open' : 'updated', page: 1 };
      let next: Cursor | null;
      let tally: Tally;
      if (cursor.phase === 'relink') {
        ({ next, tally } = await this.relinkBatch(placement, cursor));
      } else {
        ({ next, tally } = await this.listingPage(organizationId, run, placement, client, cursor, since));
      }
      await this.recordPage(organizationId, run.id, tally, next ?? cursor);
      await this.publish(organizationId, run.id);
      if (next === null) {
        const done = await this.load(organizationId, run.id);
        return done === null ? { kind: 'skipped' } : this.finish(organizationId, done, null, null);
      }
      run = { ...run, lastCursor: { ...next } };
    }
    return { kind: 'continue' };
  }

  /** One listing page; returns the next checkpoint (null = the run is complete). */
  private async listingPage(
    organizationId: string,
    run: RunRow,
    placement: RepoPlacement,
    client: GithubInstallationClient,
    cursor: Cursor,
    since: Date | null,
  ): Promise<{ next: Cursor | null; tally: Tally }> {
    const cutoff =
      cursor.phase === 'closed'
        ? new Date(this.now().getTime() - this.historyMs)
        : cursor.phase === 'updated'
          ? since
          : null;
    const listing = await client.listPulls(placement.fullName, {
      state: cursor.phase === 'open' ? 'open' : cursor.phase === 'closed' ? 'closed' : 'all',
      sort: cursor.phase === 'open' ? 'created' : 'updated',
      page: cursor.page,
    });
    const inWindow =
      cutoff === null ? listing.pulls : listing.pulls.filter((pull) => new Date(pull.updated_at) >= cutoff);
    const reachedCutoff = inWindow.length < listing.pulls.length;
    const tally = await this.applyPage(organizationId, run.id, placement, client, inWindow);
    const pageExhausted = !listing.hasNext || reachedCutoff || cursor.page >= MAX_LIST_PAGES;
    if (!pageExhausted) {
      return { next: { phase: cursor.phase, page: cursor.page + 1 }, tally };
    }
    if (cursor.phase === 'open') {
      return { next: { phase: 'closed', page: 1 }, tally };
    }
    if (cursor.phase === 'updated') {
      return { next: { phase: 'relink', page: 1 }, tally };
    }
    return { next: null, tally };
  }

  private async relinkBatch(placement: RepoPlacement, cursor: Cursor): Promise<{ next: Cursor | null; tally: Tally }> {
    const batch = await this.db.githubPullRequest.findMany({
      where: {
        organizationId: placement.organizationId,
        repositoryId: placement.repositoryId,
        NOT: { jiraKeys: { isEmpty: true } },
        ...(cursor.afterId === undefined ? {} : { id: { gt: cursor.afterId } }),
      },
      orderBy: { id: 'asc' },
      take: RELINK_BATCH,
      select: { id: true, jiraKeys: true, headRef: true, title: true },
    });
    for (const pull of batch) {
      await relinkFromStoredKeys(this.db, placement, pull, this.now());
    }
    const last = batch.at(-1);
    return {
      next: last === undefined || batch.length < RELINK_BATCH ? null : { phase: 'relink', page: 1, afterId: last.id },
      tally: emptyTally(),
    };
  }

  private async applyPage(
    organizationId: string,
    runId: string,
    placement: RepoPlacement,
    client: GithubInstallationClient,
    pulls: readonly PullRequestWire[],
  ): Promise<Tally> {
    const tally = emptyTally();
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const wire of pulls) {
      tally.processed += 1;
      latestMs = Math.max(latestMs, Date.parse(wire.updated_at));
      try {
        const { outcome, pull } = await upsertPull(this.db, placement, wire, this.now());
        if (outcome !== 'stale') {
          await refreshJiraAssociation(
            this.db,
            placement,
            pull.id,
            { branch: wire.head.ref, title: wire.title, body: wire.body ?? null },
            this.now(),
          );
        }
        if (detailsOutdated(pull)) {
          await refreshPullDetails(this.db, client, placement, pull, this.now);
        }
        if (outcome === 'created') {
          tally.created += 1;
        } else if (outcome === 'updated') {
          tally.updated += 1;
        } else {
          tally.unchanged += 1;
        }
      } catch (error) {
        if (error instanceof GithubApiError && (error.kind === 'rate_limited' || error.kind === 'unauthorized')) {
          throw error;
        }
        tally.failed += 1;
        const known = error instanceof GithubApiError;
        await this.db.githubSyncFailure.create({
          data: {
            organizationId,
            runId,
            prNumber: wire.number,
            errorCode: known ? error.code : 'store_failed',
            classification: known && !error.retryable ? 'PERMANENT' : 'RETRYABLE',
            message: (known ? error.message : error instanceof Error ? error.name : 'Error').slice(0, MAX_SUMMARY),
          },
          select: { id: true },
        });
      }
    }
    if (Number.isFinite(latestMs)) {
      const latest = new Date(latestMs);
      await this.db.githubRepository.updateMany({
        where: {
          organizationId,
          id: placement.repositoryId,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: latest } }],
        },
        data: { lastActivityAt: latest },
      });
    }
    return tally;
  }

  private async recordPage(organizationId: string, runId: string, tally: Tally, cursor: Cursor): Promise<void> {
    await this.db.githubSyncRun.updateMany({
      where: { organizationId, id: runId },
      data: {
        recordsProcessed: { increment: tally.processed },
        recordsCreated: { increment: tally.created },
        recordsUpdated: { increment: tally.updated },
        recordsUnchanged: { increment: tally.unchanged },
        recordsFailed: { increment: tally.failed },
        pages: { increment: 1 },
        consecutiveErrors: 0,
        lastCursor: { ...cursor },
      },
    });
  }

  private async onGithubError(
    organizationId: string,
    runId: string,
    error: GithubApiError,
  ): Promise<GithubSliceOutcome> {
    const run = await this.load(organizationId, runId);
    if (run === null || !ACTIVE.includes(run.status)) {
      return { kind: 'skipped' };
    }
    if (error.kind === 'rate_limited') {
      return { kind: 'retry_later', delayMs: Math.max(1_000, error.retryAfterMs ?? 60_000) };
    }
    if (error.retryable || error.kind === 'malformed') {
      const attempts = run.consecutiveErrors + 1;
      if (attempts >= this.maxErrors) {
        return this.finish(organizationId, run, 'FAILED', { code: error.code, summary: error.message });
      }
      await this.db.githubSyncRun.updateMany({
        where: { organizationId, id: run.id },
        data: { consecutiveErrors: attempts, errorCode: error.code, errorSummary: error.message.slice(0, MAX_SUMMARY) },
      });
      await this.publish(organizationId, run.id);
      return { kind: 'retry_later', delayMs: githubBackoffDelay(attempts) };
    }
    return this.finish(
      organizationId,
      run,
      'FAILED',
      { code: error.code, summary: error.message },
      error.kind === 'not_found' || error.kind === 'forbidden',
    );
  }

  /**
   * Ends a run. `status` null = SUCCEEDED or PARTIALLY_FAILED from the counters. A successful pass
   * moves the repository's reconciliation mark to this run's start, so changes made during the run
   * are picked up by the next one. Access errors re-check the installation's repositories.
   */
  private async finish(
    organizationId: string,
    run: RunRow,
    status: GithubSyncRunStatus | null,
    error: { code: string; summary: string } | null,
    recheckInstallation = false,
  ): Promise<GithubSliceOutcome> {
    const now = this.now();
    const final: GithubSyncRunStatus = status ?? (run.recordsFailed > 0 ? 'PARTIALLY_FAILED' : 'SUCCEEDED');
    const succeeded = final === 'SUCCEEDED' || final === 'PARTIALLY_FAILED';
    await this.db.$transaction(async (tx) => {
      const ended = await tx.githubSyncRun.updateMany({
        where: { organizationId, id: run.id, status: { in: [...ACTIVE] } },
        data: {
          status: final,
          finishedAt: now,
          ...(error === null ? {} : { errorCode: error.code, errorSummary: error.summary.slice(0, MAX_SUMMARY) }),
        },
      });
      if (ended.count === 0) {
        return;
      }
      await this.advanceMarks(tx, organizationId, run, final, succeeded, now);
      if (recheckInstallation) {
        await enqueueInstallationSync(tx, organizationId, run.installationId);
      }
    });
    await this.publish(organizationId, run.id);
    return { kind: 'finished', status: final };
  }

  private async advanceMarks(
    tx: TenantDb,
    organizationId: string,
    run: RunRow,
    final: GithubSyncRunStatus,
    succeeded: boolean,
    now: Date,
  ): Promise<void> {
    const startedAt = run.startedAt ?? now;
    const fullPass = FULL_TYPES.includes(run.type) || run.repository.lastFullSyncAt === null;
    if (succeeded && fullPass) {
      await tx.githubRepository.updateMany({
        where: { organizationId, id: run.repositoryId },
        data: { syncState: 'COMPLETED', lastFullSyncAt: now, lastReconciledAt: startedAt },
      });
    } else if (succeeded) {
      await tx.githubRepository.updateMany({
        where: { organizationId, id: run.repositoryId },
        data: { lastReconciledAt: startedAt },
      });
    } else if (fullPass) {
      const completedBefore = run.repository.lastFullSyncAt !== null;
      await tx.githubRepository.updateMany({
        where: { organizationId, id: run.repositoryId },
        data: {
          syncState: completedBefore ? 'COMPLETED' : final === 'CANCELLED' ? 'NOT_STARTED' : 'FAILED',
        },
      });
    }
  }
}
