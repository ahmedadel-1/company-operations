import type { JiraSyncRunStatus, JiraSyncRunType, Prisma } from '@company-ops/db';

import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import type { JiraClient, JiraClientFactory } from './jira-client.js';
import type { JiraCoordination } from './jira-coordination.js';
import { syncLockKey } from './jira-coordination.js';
import { JiraApiError } from './jira-errors.js';
import { backoffDelay } from './jira-http.js';
import { applySnapshot, loadPlacement, tombstoneIssue } from './jira-issue-store.js';
import type { ApplyOutcome, IssuePlacement } from './jira-issue-store.js';
import { countJql, importJql, minutesSince, reconcileJql } from './jira-jql.js';
import { parseJiraTimestamp, toSnapshot } from './jira-mapper.js';
import type { JiraIssueWire } from './jira-wire.js';

export type SliceOutcome =
  | { readonly kind: 'finished'; readonly status: JiraSyncRunStatus }
  | { readonly kind: 'continue' }
  | { readonly kind: 'retry_later'; readonly delayMs: number }
  | { readonly kind: 'skipped' };

export interface SyncEngineOptions {
  readonly pageSize?: number;
  readonly maxPagesPerSlice?: number;
  readonly sliceBudgetMs?: number;
  /** Consecutive failed pages before a run fails. */
  readonly maxConsecutiveErrors?: number;
}

/** Re-read window when resuming an import from its `created` checkpoint. */
export const IMPORT_OVERLAP_MINUTES = 2;
/** Re-read window of incremental reconciliation (clock skew, Jira indexing lag). */
export const RECONCILE_OVERLAP_MINUTES = 10;

const ACTIVE_RUN_STATUSES: readonly JiraSyncRunStatus[] = ['QUEUED', 'RUNNING'];
const IMPORT_TYPES: readonly JiraSyncRunType[] = ['INITIAL_IMPORT', 'MANUAL_RESYNC'];
const MAX_SUMMARY = 500;

/**
 * Durable checkpoint of a run. The page token is an optimization valid only with the exact `jql`
 * it came from and only for a while; resuming always works from the timestamp/id checkpoint.
 */
interface Cursor {
  readonly createdAfter?: string;
  readonly updatedAfter?: string;
  readonly lastIssueRowId?: string;
  readonly jql?: string;
  readonly pageToken?: string;
}

function parseCursor(value: Prisma.JsonValue): Cursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const pick = (key: string): string | undefined => {
    const field = value[key];
    return typeof field === 'string' && field.length <= 4000 ? field : undefined;
  };
  const cursor: Record<string, string> = {};
  for (const key of ['createdAfter', 'updatedAfter', 'lastIssueRowId', 'jql', 'pageToken']) {
    const field = pick(key);
    if (field !== undefined) {
      cursor[key] = field;
    }
  }
  return cursor;
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
  recordsEstimated: true,
  recordsFailed: true,
  consecutiveErrors: true,
  lastCursor: true,
  connectionId: true,
  mappingId: true,
  connection: { select: { id: true, cloudId: true, siteUrl: true, status: true } },
  mapping: {
    select: {
      id: true,
      projectId: true,
      jiraProjectId: true,
      syncEnabled: true,
      removedAt: true,
      lastReconciledAt: true,
      lastFullSyncAt: true,
    },
  },
} as const;

type RunRow = Prisma.JiraSyncRunGetPayload<{ select: typeof runSelect }>;

/** Publishes "run changed" hints (identifiers only) to integration administrators. */
export type SyncProgressPublisher = (organizationId: string, runId: string) => Promise<void>;

/**
 * Executes sync runs in bounded slices (worker, system tenant context of the run's organization).
 * A slice processes a few pages, persists the checkpoint and counters after every page, and returns
 * whether to continue, retry later (rate limit, busy connection, transient failure) or stop. Any
 * crash therefore resumes from the last persisted page; upserts are idempotent so re-reading the
 * overlap window is harmless. Cancellation is checked between pages. One slice at a time per
 * connection (Redis lock) keeps API usage gentle and avoids parallel page fetches.
 */
export class JiraSyncEngine {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly budgetMs: number;
  private readonly maxErrors: number;

  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clients: JiraClientFactory,
    private readonly coordination: JiraCoordination,
    private readonly publish: SyncProgressPublisher,
    options: SyncEngineOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPagesPerSlice ?? 10;
    this.budgetMs = options.sliceBudgetMs ?? 20_000;
    this.maxErrors = options.maxConsecutiveErrors ?? 5;
  }

  async runSlice(runId: string): Promise<SliceOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const run = await this.load(organizationId, runId);
    if (run === null || !ACTIVE_RUN_STATUSES.includes(run.status)) {
      return { kind: 'skipped' };
    }
    if (run.cancelRequested) {
      return this.finish(organizationId, run, 'CANCELLED', null);
    }
    if (run.connection.status !== 'ACTIVE' && run.connection.status !== 'ERROR') {
      const code = run.connection.status === 'NEEDS_REAUTH' ? 'jira_reauth_required' : 'jira_disconnected';
      return this.finish(organizationId, run, 'FAILED', { code, summary: 'The Jira connection is not usable.' });
    }
    if (run.mapping.removedAt !== null || !run.mapping.syncEnabled) {
      return this.finish(organizationId, run, 'CANCELLED', {
        code: 'mapping_disabled',
        summary: 'The mapping was disabled or removed.',
      });
    }
    const lock = await this.coordination.tryLock(syncLockKey(run.connectionId), this.budgetMs + 60_000);
    if (lock === null) {
      return { kind: 'retry_later', delayMs: 5_000 };
    }
    try {
      const paused = await this.coordination.pausedUntil(run.connectionId);
      if (paused !== null) {
        return { kind: 'retry_later', delayMs: Math.max(1_000, paused - this.now().getTime()) };
      }
      await this.markRunning(organizationId, run);
      const client = this.clients.forConnection({
        organizationId,
        connectionId: run.connectionId,
        cloudId: run.connection.cloudId,
      });
      return run.type === 'DEEP_RECONCILIATION'
        ? await this.deepSlice(organizationId, run, client)
        : await this.searchSlice(organizationId, run, client);
    } catch (error) {
      if (error instanceof JiraApiError) {
        return await this.onJiraError(organizationId, runId, error);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  private load(organizationId: string, runId: string): Promise<RunRow | null> {
    return this.db.jiraSyncRun.findFirst({ where: { organizationId, id: runId }, select: runSelect });
  }

  private async markRunning(organizationId: string, run: RunRow): Promise<void> {
    if (run.status !== 'QUEUED') {
      return;
    }
    const startedAt = run.startedAt ?? this.now();
    await this.db.$transaction(async (tx) => {
      await tx.jiraSyncRun.updateMany({
        where: { organizationId, id: run.id, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt },
      });
      if (IMPORT_TYPES.includes(run.type)) {
        await tx.jiraProjectMapping.updateMany({
          where: { organizationId, id: run.mappingId },
          data: { importState: 'RUNNING' },
        });
      }
    });
    await this.publish(organizationId, run.id);
  }

  /** Import (created order) and incremental reconciliation (updated order) through `search/jql`. */
  private async searchSlice(organizationId: string, initial: RunRow, client: JiraClient): Promise<SliceOutcome> {
    const deadline = this.now().getTime() + this.budgetMs;
    const isImport = IMPORT_TYPES.includes(initial.type);
    const placement = await loadPlacement(this.db, organizationId, initial.connectionId);
    let run = initial;
    for (let page = 0; page < this.maxPages && this.now().getTime() < deadline; page += 1) {
      if (page > 0) {
        const fresh = await this.load(organizationId, run.id);
        if (fresh === null || !ACTIVE_RUN_STATUSES.includes(fresh.status)) {
          return { kind: 'skipped' };
        }
        if (fresh.cancelRequested) {
          return this.finish(organizationId, fresh, 'CANCELLED', null);
        }
        run = fresh;
      }
      const cursor = parseCursor(run.lastCursor);
      const freshJql = isImport ? this.importQuery(run, cursor) : this.reconcileQuery(run, cursor);
      if (freshJql === null) {
        return this.finish(organizationId, run, 'FAILED', {
          code: 'import_required',
          summary: 'Run the initial import first.',
        });
      }
      if (isImport && run.recordsEstimated === null && cursor.createdAfter === undefined) {
        const estimate = await client.approximateCount(countJql(run.mapping.jiraProjectId));
        await this.db.jiraSyncRun.updateMany({
          where: { organizationId, id: run.id },
          data: { recordsEstimated: estimate },
        });
      }
      const usingToken = cursor.pageToken !== undefined && cursor.jql !== undefined;
      const jql = usingToken ? (cursor.jql ?? freshJql) : freshJql;
      let result;
      try {
        result = await client.searchJql(jql, {
          maxResults: this.pageSize,
          nextPageToken: usingToken ? cursor.pageToken : null,
        });
      } catch (error) {
        if (usingToken && error instanceof JiraApiError && error.kind === 'invalid_request') {
          await this.saveCursor(organizationId, run.id, cursor);
          run = { ...run, lastCursor: withoutToken(cursor) };
          continue;
        }
        throw error;
      }
      const tally = await this.applyPage(organizationId, run.id, placement, run.connection.siteUrl, result.issues);
      const last = result.issues.at(-1);
      const field = isImport ? last?.fields.created : last?.fields.updated;
      const checkpoint = field === undefined ? null : parseJiraTimestamp(field);
      const next: Record<string, string> = {};
      const prior = isImport ? cursor.createdAfter : cursor.updatedAfter;
      const mark = checkpoint?.toISOString() ?? prior;
      if (mark !== undefined) {
        next[isImport ? 'createdAfter' : 'updatedAfter'] = mark;
      }
      if (!result.isLast && result.nextPageToken !== null) {
        next.jql = jql;
        next.pageToken = result.nextPageToken;
      }
      await this.recordPage(organizationId, run.id, tally, next);
      await this.publish(organizationId, run.id);
      if (result.isLast || result.nextPageToken === null) {
        const done = await this.load(organizationId, run.id);
        return done === null ? { kind: 'skipped' } : this.finish(organizationId, done, null, null);
      }
      run = { ...run, lastCursor: next };
    }
    return { kind: 'continue' };
  }

  private importQuery(run: RunRow, cursor: Cursor): string {
    const after = cursor.createdAfter === undefined ? null : new Date(cursor.createdAfter);
    const minutes =
      after === null || Number.isNaN(after.getTime()) ? null : minutesSince(after, this.now(), IMPORT_OVERLAP_MINUTES);
    return importJql(run.mapping.jiraProjectId, minutes);
  }

  private reconcileQuery(run: RunRow, cursor: Cursor): string | null {
    const raw =
      cursor.updatedAfter ?? run.mapping.lastReconciledAt?.toISOString() ?? run.mapping.lastFullSyncAt?.toISOString();
    if (raw === undefined) {
      return null;
    }
    return reconcileJql(run.mapping.jiraProjectId, minutesSince(new Date(raw), this.now(), RECONCILE_OVERLAP_MINUTES));
  }

  /** Deep reconciliation: re-fetch every cached issue by id (moves, deletions), then compare counts. */
  private async deepSlice(organizationId: string, initial: RunRow, client: JiraClient): Promise<SliceOutcome> {
    const deadline = this.now().getTime() + this.budgetMs;
    const placement = await loadPlacement(this.db, organizationId, initial.connectionId);
    let run = initial;
    for (let page = 0; page < this.maxPages && this.now().getTime() < deadline; page += 1) {
      if (page > 0) {
        const fresh = await this.load(organizationId, run.id);
        if (fresh === null || !ACTIVE_RUN_STATUSES.includes(fresh.status)) {
          return { kind: 'skipped' };
        }
        if (fresh.cancelRequested) {
          return this.finish(organizationId, fresh, 'CANCELLED', null);
        }
        run = fresh;
      }
      const cursor = parseCursor(run.lastCursor);
      const batch = await this.db.jiraIssue.findMany({
        where: {
          organizationId,
          connectionId: run.connectionId,
          mappingId: run.mappingId,
          deletedInJiraAt: null,
          ...(cursor.lastIssueRowId === undefined ? {} : { id: { gt: cursor.lastIssueRowId } }),
        },
        orderBy: { id: 'asc' },
        take: this.pageSize,
        select: { id: true, jiraIssueId: true },
      });
      const lastRow = batch.at(-1);
      if (lastRow === undefined) {
        return this.finishDeep(organizationId, run, client);
      }
      const fetched = await client.bulkFetch(batch.map((row) => row.jiraIssueId));
      const tally = await this.applyPage(organizationId, run.id, placement, run.connection.siteUrl, fetched);
      const returned = new Set(fetched.map((issue) => issue.id));
      for (const row of batch) {
        if (
          !returned.has(row.jiraIssueId) &&
          (await tombstoneIssue(this.db, organizationId, run.connectionId, row.jiraIssueId, this.now()))
        ) {
          tally.updated += 1;
          tally.processed += 1;
        }
      }
      const next = { lastIssueRowId: lastRow.id };
      await this.recordPage(organizationId, run.id, tally, next);
      await this.publish(organizationId, run.id);
      run = { ...run, lastCursor: next };
    }
    return { kind: 'continue' };
  }

  private async finishDeep(organizationId: string, run: RunRow, client: JiraClient): Promise<SliceOutcome> {
    const [remote, local] = await Promise.all([
      client.approximateCount(countJql(run.mapping.jiraProjectId)),
      this.db.jiraIssue.count({ where: { organizationId, mappingId: run.mappingId, deletedInJiraAt: null } }),
    ]);
    const tolerance = Math.max(1, Math.ceil(remote * 0.01));
    const drift = Math.abs(remote - local) > tolerance;
    const fresh = await this.load(organizationId, run.id);
    if (fresh === null) {
      return { kind: 'skipped' };
    }
    return this.finish(
      organizationId,
      fresh,
      null,
      drift
        ? {
            code: 'count_drift',
            summary: `Jira reports about ${String(remote)} issues; ${String(local)} are cached. A full resync was queued.`,
          }
        : null,
      drift,
    );
  }

  private async applyPage(
    organizationId: string,
    runId: string,
    placement: IssuePlacement,
    siteUrl: string,
    issues: readonly JiraIssueWire[],
  ): Promise<Tally> {
    const tally = emptyTally();
    for (const issue of issues) {
      tally.processed += 1;
      const snapshot = toSnapshot(issue, siteUrl);
      if (snapshot === null) {
        tally.failed += 1;
        await this.recordFailure(
          organizationId,
          runId,
          issue.id,
          'jira_malformed_issue',
          'PERMANENT',
          'The issue has unreadable timestamps.',
        );
        continue;
      }
      let outcome: ApplyOutcome;
      try {
        outcome = (await applySnapshot(this.db, placement, snapshot, { now: this.now() })).outcome;
      } catch (error) {
        tally.failed += 1;
        await this.recordFailure(
          organizationId,
          runId,
          issue.id,
          'store_failed',
          'RETRYABLE',
          error instanceof Error ? error.name : 'Error',
        );
        continue;
      }
      if (outcome === 'created') {
        tally.created += 1;
      } else if (outcome === 'updated') {
        tally.updated += 1;
      } else {
        tally.unchanged += 1;
      }
    }
    return tally;
  }

  private async recordFailure(
    organizationId: string,
    runId: string,
    jiraIssueId: string | null,
    errorCode: string,
    classification: 'RETRYABLE' | 'PERMANENT',
    message: string,
  ): Promise<void> {
    await this.db.jiraSyncFailure.create({
      data: { organizationId, runId, jiraIssueId, errorCode, classification, message: message.slice(0, MAX_SUMMARY) },
      select: { id: true },
    });
  }

  private async recordPage(
    organizationId: string,
    runId: string,
    tally: Tally,
    cursor: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.db.jiraSyncRun.updateMany({
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

  private async saveCursor(organizationId: string, runId: string, cursor: Cursor): Promise<void> {
    await this.db.jiraSyncRun.updateMany({
      where: { organizationId, id: runId },
      data: { lastCursor: withoutToken(cursor) },
    });
  }

  private async onJiraError(organizationId: string, runId: string, error: JiraApiError): Promise<SliceOutcome> {
    const run = await this.load(organizationId, runId);
    if (run === null || !ACTIVE_RUN_STATUSES.includes(run.status)) {
      return { kind: 'skipped' };
    }
    if (error.kind === 'rate_limited') {
      return { kind: 'retry_later', delayMs: Math.max(1_000, error.retryAfterMs ?? 60_000) };
    }
    if (error.retryable || error.kind === 'malformed') {
      const attempts = run.consecutiveErrors + 1;
      if (attempts >= this.maxErrors) {
        await this.db.jiraConnection.updateMany({
          where: { organizationId, id: run.connectionId, status: 'ACTIVE' },
          data: { status: 'ERROR', lastErrorCode: error.code, lastErrorAt: this.now() },
        });
        return this.finish(organizationId, run, 'FAILED', { code: error.code, summary: error.message });
      }
      await this.db.jiraSyncRun.updateMany({
        where: { organizationId, id: run.id },
        data: { consecutiveErrors: attempts, errorCode: error.code, errorSummary: error.message.slice(0, MAX_SUMMARY) },
      });
      await this.publish(organizationId, run.id);
      return { kind: 'retry_later', delayMs: backoffDelay(attempts) };
    }
    return this.finish(organizationId, run, 'FAILED', { code: error.code, summary: error.message });
  }

  /**
   * Ends a run. `status` null = derive from the counters (SUCCEEDED or PARTIALLY_FAILED) and advance
   * the mapping's sync marks: after an import or reconciliation the next reconciliation starts from
   * this run's start time (minus the overlap), so changes made during the run are not missed.
   */
  private async finish(
    organizationId: string,
    run: RunRow,
    status: JiraSyncRunStatus | null,
    error: { code: string; summary: string } | null,
    queueResync = false,
  ): Promise<SliceOutcome> {
    const now = this.now();
    const final: JiraSyncRunStatus = status ?? (run.recordsFailed > 0 ? 'PARTIALLY_FAILED' : 'SUCCEEDED');
    const succeeded = final === 'SUCCEEDED' || final === 'PARTIALLY_FAILED';
    await this.db.$transaction(async (tx) => {
      const ended = await tx.jiraSyncRun.updateMany({
        where: { organizationId, id: run.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
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
      if (succeeded) {
        await tx.jiraConnection.updateMany({
          where: { organizationId, id: run.connectionId, status: { in: ['ACTIVE', 'ERROR'] } },
          data: { status: 'ACTIVE', lastSuccessAt: now, lastErrorCode: null, lastErrorAt: null },
        });
      }
      if (queueResync) {
        const resync = await tx.jiraSyncRun.create({
          data: { organizationId, connectionId: run.connectionId, mappingId: run.mappingId, type: 'MANUAL_RESYNC' },
          select: { id: true },
        });
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'jira.sync.requested',
          aggregateType: 'jira_sync_run',
          aggregateId: resync.id,
          payload: { runId: resync.id },
        });
      }
    });
    await this.publish(organizationId, run.id);
    return { kind: 'finished', status: final };
  }

  private async advanceMarks(
    tx: TenantDb,
    organizationId: string,
    run: RunRow,
    final: JiraSyncRunStatus,
    succeeded: boolean,
    now: Date,
  ): Promise<void> {
    const startedAt = run.startedAt ?? now;
    if (IMPORT_TYPES.includes(run.type)) {
      await tx.jiraProjectMapping.updateMany({
        where: { organizationId, id: run.mappingId },
        data: succeeded
          ? { importState: 'COMPLETED', lastFullSyncAt: now, lastReconciledAt: startedAt }
          : { importState: unfinishedImportState(final, run.mapping.lastFullSyncAt !== null) },
      });
    } else if (run.type === 'RECONCILIATION' && succeeded) {
      await tx.jiraProjectMapping.updateMany({
        where: { organizationId, id: run.mappingId },
        data: { lastReconciledAt: startedAt },
      });
    } else if (run.type === 'DEEP_RECONCILIATION' && succeeded) {
      await tx.jiraProjectMapping.updateMany({
        where: { organizationId, id: run.mappingId },
        data: { lastDeepReconciledAt: now },
      });
    }
  }
}

/** A cache that was complete once stays usable after a failed or cancelled resync. */
function unfinishedImportState(
  final: JiraSyncRunStatus,
  completedBefore: boolean,
): 'COMPLETED' | 'NOT_STARTED' | 'FAILED' {
  if (completedBefore) {
    return 'COMPLETED';
  }
  return final === 'CANCELLED' ? 'NOT_STARTED' : 'FAILED';
}

function withoutToken(cursor: Cursor): Record<string, string> {
  const next: Record<string, string> = {};
  if (cursor.createdAfter !== undefined) {
    next.createdAfter = cursor.createdAfter;
  }
  if (cursor.updatedAfter !== undefined) {
    next.updatedAfter = cursor.updatedAfter;
  }
  if (cursor.lastIssueRowId !== undefined) {
    next.lastIssueRowId = cursor.lastIssueRowId;
  }
  return next;
}
