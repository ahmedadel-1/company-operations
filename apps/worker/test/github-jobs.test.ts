import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { AsyncLocalTenantContext, OUTBOX_ROUTES } from '@company-ops/core';
import type {
  GithubInstallationSync,
  GithubScheduler,
  GithubSyncEngine,
  GithubWebhookProcessor,
  RealtimePublisher,
} from '@company-ops/core';

import {
  GITHUB_INSTALLATION_SYNC_JOB,
  GITHUB_MAX_RETRY_DELAY_MS,
  GITHUB_RECONCILE_REPO_JOB,
  GITHUB_STALE_RUN_MS,
  GITHUB_WEBHOOK_PROCESS_JOB,
  githubProgressPublisher,
  handleGithubJob,
  nextGithubSliceDelay,
  runGithubSchedule,
} from '../src/processors/github/github-jobs.js';

const ORG = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ID = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
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
  } as unknown as GithubSyncEngine;
  const webhooks = {
    process: (deliveryId: string) => {
      record('delivery', deliveryId);
      return Promise.resolve('processed' as const);
    },
  } as unknown as GithubWebhookProcessor;
  const installations = {
    sync: (installationId: string) => {
      record('installation', installationId);
      return Promise.resolve('synced' as const);
    },
  } as unknown as GithubInstallationSync;
  return { tenant, engine, webhooks, installations, calls };
}

describe('handleGithubJob', () => {
  it('runs each job in a system context of the event organization', async () => {
    const d = deps();
    await expect(
      handleGithubJob(GITHUB_RECONCILE_REPO_JOB, job('github.sync.requested', { runId: ID }), d),
    ).resolves.toEqual({ kind: 'slice', outcome: { kind: 'continue' } });
    await expect(
      handleGithubJob(GITHUB_WEBHOOK_PROCESS_JOB, job('github.webhook.received', { deliveryId: ID }), d),
    ).resolves.toEqual({ kind: 'delivery', outcome: 'processed' });
    await expect(
      handleGithubJob(GITHUB_INSTALLATION_SYNC_JOB, job('github.installation.sync', { installationId: ID }), d),
    ).resolves.toEqual({ kind: 'installation', outcome: 'synced' });
    expect(d.calls).toEqual([
      { what: 'slice', id: ID, context: SYSTEM },
      { what: 'delivery', id: ID, context: SYSTEM },
      { what: 'installation', id: ID, context: SYSTEM },
    ]);
    expect(d.tenant.get()).toBeUndefined();
  });

  it('takes the tenant from the event, ignoring any organization in the payload', async () => {
    const d = deps();
    await expect(
      handleGithubJob(
        GITHUB_WEBHOOK_PROCESS_JOB,
        job('github.webhook.received', { deliveryId: ID, organizationId: EVENT }),
        d,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(d.calls).toEqual([]);
  });

  it('refuses malformed data, mismatched event types and unknown jobs without retrying', async () => {
    const d = deps();
    const refused = [
      handleGithubJob(GITHUB_RECONCILE_REPO_JOB, job('github.webhook.received', { runId: ID }), d),
      handleGithubJob(GITHUB_RECONCILE_REPO_JOB, job('github.sync.requested', { runId: 'not-a-uuid' }), d),
      handleGithubJob(GITHUB_WEBHOOK_PROCESS_JOB, job('github.webhook.received', { runId: ID }), d),
      handleGithubJob(GITHUB_INSTALLATION_SYNC_JOB, { eventType: 'github.installation.sync', payload: {} }, d),
      handleGithubJob('github.unknown', job('github.sync.requested', { runId: ID }), d),
      handleGithubJob(GITHUB_RECONCILE_REPO_JOB, null, d),
    ];
    for (const attempt of refused) {
      await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(d.calls).toEqual([]);
  });
});

describe('outbox routing', () => {
  it('routes every github.* outbox event to a github-sync job this worker handles', async () => {
    const routes = Object.entries(OUTBOX_ROUTES).filter(([eventType]) => eventType.startsWith('github.'));
    expect(routes.map(([eventType]) => eventType).sort()).toEqual([
      'github.installation.sync',
      'github.sync.requested',
      'github.webhook.received',
    ]);
    const payloads: Record<string, unknown> = {
      'github.installation.sync': { installationId: ID },
      'github.sync.requested': { runId: ID },
      'github.webhook.received': { deliveryId: ID },
    };
    for (const [eventType, route] of routes) {
      expect(route.queue).toBe('github-sync');
      await expect(handleGithubJob(route.jobName, job(eventType, payloads[eventType]), deps())).resolves.toBeDefined();
    }
  });
});

describe('nextGithubSliceDelay', () => {
  it('continues at once, clamps retry delays below the stale threshold and stops when done', () => {
    expect(nextGithubSliceDelay({ kind: 'continue' })).toBe(0);
    expect(nextGithubSliceDelay({ kind: 'retry_later', delayMs: 10 })).toBe(1_000);
    expect(nextGithubSliceDelay({ kind: 'retry_later', delayMs: 45_000 })).toBe(45_000);
    expect(nextGithubSliceDelay({ kind: 'retry_later', delayMs: 3_600_000 })).toBe(GITHUB_MAX_RETRY_DELAY_MS);
    expect(nextGithubSliceDelay({ kind: 'finished', status: 'SUCCEEDED' })).toBeNull();
    expect(nextGithubSliceDelay({ kind: 'skipped' })).toBeNull();
    expect(GITHUB_MAX_RETRY_DELAY_MS).toBeLessThan(GITHUB_STALE_RUN_MS);
  });
});

describe('runGithubSchedule', () => {
  it('queues due reconciliations and re-enqueues runs idle for longer than the stale threshold', async () => {
    let reconcileArgs: [number, Date] | null = null;
    let staleBefore: Date | null = null;
    const scheduler = {
      queueReconciliation: (intervalMs: number, now: Date) => {
        reconcileArgs = [intervalMs, now];
        return Promise.resolve({ organizations: 2, queued: 4, failedOrganizations: 1 });
      },
      requeueStale: (before: Date) => {
        staleBefore = before;
        return Promise.resolve(3);
      },
    } as unknown as GithubScheduler;
    const now = new Date('2026-10-03T12:00:00Z');
    await expect(runGithubSchedule(scheduler, 1_800_000, now)).resolves.toEqual({
      reconciliationsQueued: 4,
      staleRunsRequeued: 3,
      failedOrganizations: 1,
    });
    expect(reconcileArgs).toEqual([1_800_000, now]);
    expect(staleBefore).toEqual(new Date(now.getTime() - GITHUB_STALE_RUN_MS));
  });
});

describe('githubProgressPublisher', () => {
  it('sends identifier-only hints to integration administrators and swallows publish failures', async () => {
    const published: { channel: string; event: unknown }[] = [];
    const errors: unknown[] = [];
    const realtime = {
      publish: (channel: string, event: unknown) => {
        published.push({ channel, event });
        return published.length > 1 ? Promise.reject(new Error('redis down')) : Promise.resolve();
      },
    } as unknown as RealtimePublisher;
    const publish = githubProgressPublisher(realtime, (error) => errors.push(error));
    await publish(ORG, ID);
    await publish(ORG, ID);
    expect(published[0]?.channel).toBe(`rt:org:${ORG}:perm:integration.manage`);
    expect(published[0]?.event).toEqual({ type: 'github.sync.progress', entityType: 'github_sync_run', entityId: ID });
    expect(errors).toHaveLength(1);
  });
});
