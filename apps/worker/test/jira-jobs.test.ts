import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { AsyncLocalTenantContext } from '@company-ops/core';
import type {
  JiraScheduler,
  JiraSyncEngine,
  JiraWebhookProcessor,
  JiraWebhookRegistrar,
  RealtimePublisher,
  ScheduleTotals,
} from '@company-ops/core';

import {
  handleJiraJob,
  JIRA_CONNECTION_CLEANUP_JOB,
  JIRA_SYNC_RUN_JOB,
  JIRA_WEBHOOK_PROCESS_JOB,
  JIRA_WEBHOOKS_SYNC_JOB,
  MAX_RETRY_DELAY_MS,
  nextSliceDelay,
  runJiraSchedule,
  STALE_RUN_MS,
  syncProgressPublisher,
} from '../src/processors/jira/jira-jobs.js';

const ORG = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const RUN = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const EVENT = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
const SYSTEM = { organizationId: ORG, memberId: null, userId: null };

const job = (eventType: string, payload: unknown) => ({ eventId: EVENT, organizationId: ORG, eventType, payload });

function deps() {
  const tenant = new AsyncLocalTenantContext();
  const calls: { what: string; id: string; context: unknown }[] = [];
  const record = (what: string, id: string) => calls.push({ what, id, context: tenant.get() });
  const engine = {
    runSlice: (runId: string) => {
      record('slice', runId);
      return Promise.resolve({ kind: 'continue' as const });
    },
  } as unknown as JiraSyncEngine;
  const webhooks = {
    process: (deliveryId: string) => {
      record('delivery', deliveryId);
      return Promise.resolve('updated' as const);
    },
  } as unknown as JiraWebhookProcessor;
  const registrar = {
    sync: (connectionId: string) => {
      record('webhooks', connectionId);
      return Promise.resolve('registered' as const);
    },
    cleanup: (connectionId: string) => {
      record('cleanup', connectionId);
      return Promise.resolve('cleaned' as const);
    },
  } as unknown as JiraWebhookRegistrar;
  return { tenant, engine, webhooks, registrar, calls };
}

describe('handleJiraJob', () => {
  it('runs each job in a system context of the event organization', async () => {
    const d = deps();
    await expect(handleJiraJob(JIRA_SYNC_RUN_JOB, job('jira.sync.requested', { runId: RUN }), d)).resolves.toEqual({
      kind: 'slice',
      outcome: { kind: 'continue' },
    });
    await handleJiraJob(JIRA_WEBHOOK_PROCESS_JOB, job('jira.webhook.received', { deliveryId: RUN }), d);
    await handleJiraJob(JIRA_WEBHOOKS_SYNC_JOB, job('jira.webhooks.sync', { connectionId: RUN }), d);
    await handleJiraJob(JIRA_CONNECTION_CLEANUP_JOB, job('jira.connection.cleanup', { connectionId: RUN }), d);
    expect(d.calls).toEqual([
      { what: 'slice', id: RUN, context: SYSTEM },
      { what: 'delivery', id: RUN, context: SYSTEM },
      { what: 'webhooks', id: RUN, context: SYSTEM },
      { what: 'cleanup', id: RUN, context: SYSTEM },
    ]);
    expect(d.tenant.get()).toBeUndefined();
  });

  it("retires the event organization's cached Jira dashboards after each job, and not on refused jobs", async () => {
    const invalidated: { organizationId: string; domains: readonly string[] }[] = [];
    const d = {
      ...deps(),
      invalidate: (organizationId: string, domains: readonly string[]) => {
        invalidated.push({ organizationId, domains });
        return Promise.resolve();
      },
    };
    await handleJiraJob(JIRA_SYNC_RUN_JOB, job('jira.sync.requested', { runId: RUN }), d);
    expect(invalidated).toEqual([{ organizationId: ORG, domains: ['jira'] }]);
    await expect(
      handleJiraJob(JIRA_SYNC_RUN_JOB, job('jira.sync.requested', { runId: 'not-a-uuid' }), d),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(invalidated).toHaveLength(1);
  });

  it('refuses malformed data, mismatched event types and unknown jobs without retrying', async () => {
    const d = deps();
    await expect(
      handleJiraJob(JIRA_SYNC_RUN_JOB, job('jira.webhook.received', { runId: RUN }), d),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      handleJiraJob(JIRA_SYNC_RUN_JOB, job('jira.sync.requested', { runId: 'not-a-uuid' }), d),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      handleJiraJob(JIRA_SYNC_RUN_JOB, { eventType: 'jira.sync.requested', payload: { runId: RUN } }, d),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(handleJiraJob('jira.unknown', job('jira.sync.requested', { runId: RUN }), d)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(d.calls).toEqual([]);
  });
});

describe('nextSliceDelay', () => {
  it('continues at once, clamps retry delays and stops when done', () => {
    expect(nextSliceDelay({ kind: 'continue' })).toBe(0);
    expect(nextSliceDelay({ kind: 'retry_later', delayMs: 10 })).toBe(1_000);
    expect(nextSliceDelay({ kind: 'retry_later', delayMs: 30_000 })).toBe(30_000);
    expect(nextSliceDelay({ kind: 'retry_later', delayMs: 24 * 60 * 60 * 1000 })).toBe(MAX_RETRY_DELAY_MS);
    expect(nextSliceDelay({ kind: 'finished', status: 'SUCCEEDED' })).toBeNull();
    expect(nextSliceDelay({ kind: 'skipped' })).toBeNull();
    expect(MAX_RETRY_DELAY_MS).toBeLessThan(STALE_RUN_MS);
  });
});

describe('runJiraSchedule', () => {
  it('queues both reconciliation kinds and re-enqueues runs idle for longer than the stale threshold', async () => {
    const seen: string[] = [];
    let staleBefore: Date | null = null;
    const totals = (queued: number, failed: number): ScheduleTotals => ({
      organizations: 2,
      queued,
      failedOrganizations: failed,
    });
    const scheduler = {
      queueDue: (type: string, intervalMs: number) => {
        seen.push(`${type}:${String(intervalMs)}`);
        return Promise.resolve(type === 'RECONCILIATION' ? totals(3, 1) : totals(1, 0));
      },
      requeueStale: (before: Date) => {
        staleBefore = before;
        return Promise.resolve(2);
      },
    } as unknown as JiraScheduler;
    const now = new Date('2026-10-03T12:00:00Z');
    await expect(
      runJiraSchedule(scheduler, { reconcileMs: 3_600_000, deepReconcileMs: 604_800_000 }, now),
    ).resolves.toEqual({
      reconciliationsQueued: 3,
      deepChecksQueued: 1,
      staleRunsRequeued: 2,
      failedOrganizations: 1,
    });
    expect(seen).toEqual(['RECONCILIATION:3600000', 'DEEP_RECONCILIATION:604800000']);
    expect(staleBefore).toEqual(new Date(now.getTime() - STALE_RUN_MS));
  });
});

describe('syncProgressPublisher', () => {
  it('sends identifier-only hints to integration administrators and swallows publish failures', async () => {
    const published: { channel: string; event: unknown }[] = [];
    const errors: unknown[] = [];
    const realtime = {
      publish: (channel: string, event: unknown) => {
        published.push({ channel, event });
        return published.length > 1 ? Promise.reject(new Error('redis down')) : Promise.resolve();
      },
    } as unknown as RealtimePublisher;
    const publish = syncProgressPublisher(realtime, (error) => errors.push(error));
    await publish(ORG, RUN);
    await publish(ORG, RUN);
    expect(published[0]?.channel).toBe(`rt:org:${ORG}:perm:integration.manage`);
    expect(published[0]?.event).toEqual({ type: 'jira.sync.progress', entityType: 'jira_sync_run', entityId: RUN });
    expect(errors).toHaveLength(1);
  });
});
