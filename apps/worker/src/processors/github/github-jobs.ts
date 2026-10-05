import { UnrecoverableError } from 'bullmq';

import { permissionChannel, publishQuietly } from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  GithubDeliveryOutcome,
  GithubInstallationSync,
  GithubScheduler,
  GithubSliceOutcome,
  GithubSyncEngine,
  GithubWebhookProcessor,
  InstallationSyncOutcome,
  RealtimePublisher,
} from '@company-ops/core';
import {
  githubInstallationSyncPayloadSchema,
  githubSyncRequestedPayloadSchema,
  githubWebhookReceivedPayloadSchema,
  outboxJobDataSchema,
} from '@company-ops/validation';

export const GITHUB_INSTALLATION_SYNC_JOB = 'github.installation.sync';
export const GITHUB_WEBHOOK_PROCESS_JOB = 'github.webhook.process';
export const GITHUB_RECONCILE_REPO_JOB = 'github.reconcile.repo';
/** Scheduled, organization-less: queue due reconciliations and re-enqueue stalled runs. */
export const GITHUB_SCHEDULE_JOB = 'github.schedule';
/** Scheduled, organization-less: refresh installations and repository access (missed events). */
export const GITHUB_INSTALLATION_REFRESH_JOB = 'github.installations.refresh';

/** A run that has not been touched for this long is considered lost and re-enqueued. */
export const GITHUB_STALE_RUN_MS = 10 * 60 * 1000;
/** Upper bound of one "retry later" delay (keeps it below the stale-run threshold). */
export const GITHUB_MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

const EVENT_FOR_JOB: Readonly<Record<string, string>> = {
  [GITHUB_INSTALLATION_SYNC_JOB]: 'github.installation.sync',
  [GITHUB_WEBHOOK_PROCESS_JOB]: 'github.webhook.received',
  [GITHUB_RECONCILE_REPO_JOB]: 'github.sync.requested',
};

export interface GithubJobDeps {
  readonly tenant: AsyncLocalTenantContext;
  readonly engine: GithubSyncEngine;
  readonly webhooks: GithubWebhookProcessor;
  readonly installations: GithubInstallationSync;
  readonly invalidate?: DashboardInvalidator;
}

export type GithubJobResult =
  | { readonly kind: 'slice'; readonly outcome: GithubSliceOutcome }
  | { readonly kind: 'delivery'; readonly outcome: GithubDeliveryOutcome }
  | { readonly kind: 'installation'; readonly outcome: InstallationSyncOutcome };

/** Validates outbox job data: the tenant comes from the event's own organization, never the payload. */
function parseJob(jobName: string, data: unknown): { organizationId: string; payload: unknown } {
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== EVENT_FOR_JOB[jobName]) {
    throw new UnrecoverableError('Invalid GitHub job data.');
  }
  return { organizationId: job.data.organizationId, payload: job.data.payload };
}

function payloadOf<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UnrecoverableError('Invalid GitHub job payload.');
  }
  return parsed.data;
}

/**
 * Handles outbox-relayed `github-sync` jobs in a system tenant context of the event's organization.
 * Every handler re-reads persisted state (run, delivery, installation) inside that organization and
 * then GitHub itself, so a job can never act on another tenant's rows and is safe to re-deliver.
 */
export async function handleGithubJob(jobName: string, data: unknown, deps: GithubJobDeps): Promise<GithubJobResult> {
  const { organizationId } = parseJob(jobName, data);
  const result = await runGithubJob(jobName, data, deps);
  // The pull-request cache, repositories or installation state may have changed.
  await deps.invalidate?.(organizationId, ['github']);
  return result;
}

async function runGithubJob(jobName: string, data: unknown, deps: GithubJobDeps): Promise<GithubJobResult> {
  const { organizationId, payload } = parseJob(jobName, data);
  const context = { organizationId, memberId: null, userId: null };
  switch (jobName) {
    case GITHUB_RECONCILE_REPO_JOB: {
      const { runId } = payloadOf(githubSyncRequestedPayloadSchema, payload);
      return { kind: 'slice', outcome: await deps.tenant.run(context, () => deps.engine.runSlice(runId)) };
    }
    case GITHUB_WEBHOOK_PROCESS_JOB: {
      const { deliveryId } = payloadOf(githubWebhookReceivedPayloadSchema, payload);
      return { kind: 'delivery', outcome: await deps.tenant.run(context, () => deps.webhooks.process(deliveryId)) };
    }
    case GITHUB_INSTALLATION_SYNC_JOB: {
      const { installationId } = payloadOf(githubInstallationSyncPayloadSchema, payload);
      return {
        kind: 'installation',
        outcome: await deps.tenant.run(context, () => deps.installations.sync(installationId)),
      };
    }
    default:
      throw new UnrecoverableError(`Unknown github-sync job "${jobName}".`);
  }
}

/** When to run the same sync job again, or null when it is done. */
export function nextGithubSliceDelay(outcome: GithubSliceOutcome): number | null {
  switch (outcome.kind) {
    case 'continue':
      return 0;
    case 'retry_later':
      return Math.min(GITHUB_MAX_RETRY_DELAY_MS, Math.max(1_000, outcome.delayMs));
    case 'finished':
    case 'skipped':
      return null;
  }
}

export interface GithubScheduleTotals {
  readonly reconciliationsQueued: number;
  readonly staleRunsRequeued: number;
  readonly failedOrganizations: number;
}

export async function runGithubSchedule(
  scheduler: GithubScheduler,
  reconcileMs: number,
  now: Date,
): Promise<GithubScheduleTotals> {
  const reconcile = await scheduler.queueReconciliation(reconcileMs, now);
  const stale = await scheduler.requeueStale(new Date(now.getTime() - GITHUB_STALE_RUN_MS));
  return {
    reconciliationsQueued: reconcile.queued,
    staleRunsRequeued: stale,
    failedOrganizations: reconcile.failedOrganizations,
  };
}

/** Sync progress hint for integration administrators (identifiers only; the UI re-fetches the run). */
export function githubProgressPublisher(realtime: RealtimePublisher, onError: (error: unknown) => void) {
  return (organizationId: string, runId: string): Promise<void> =>
    publishQuietly(
      realtime,
      [permissionChannel(organizationId, 'integration.manage')],
      { type: 'github.sync.progress', entityType: 'github_sync_run', entityId: runId },
      onError,
    );
}
