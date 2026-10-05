import { UnrecoverableError } from 'bullmq';

import { permissionChannel, publishQuietly } from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  DeliveryProcessOutcome,
  JiraScheduler,
  JiraSyncEngine,
  JiraWebhookProcessor,
  JiraWebhookRegistrar,
  RealtimePublisher,
  SliceOutcome,
  WebhookSyncOutcome,
} from '@company-ops/core';
import {
  jiraConnectionJobPayloadSchema,
  jiraSyncRequestedPayloadSchema,
  jiraWebhookReceivedPayloadSchema,
  outboxJobDataSchema,
} from '@company-ops/validation';

export const JIRA_SYNC_RUN_JOB = 'jira.sync.run';
export const JIRA_WEBHOOK_PROCESS_JOB = 'jira.webhook.process';
export const JIRA_WEBHOOKS_SYNC_JOB = 'jira.webhooks.sync';
export const JIRA_CONNECTION_CLEANUP_JOB = 'jira.connection.cleanup';
/** Scheduled, organization-less: queue due reconciliations and re-enqueue stalled runs. */
export const JIRA_SCHEDULE_JOB = 'jira.schedule';
/** Scheduled, organization-less: refresh webhook registrations before their 30-day expiry. */
export const JIRA_WEBHOOK_REFRESH_JOB = 'jira.webhooks.refresh';

/** A run that has not been touched for this long is considered lost and re-enqueued. */
export const STALE_RUN_MS = 10 * 60 * 1000;
/** Upper bound of one "retry later" delay (keeps it below the stale-run threshold). */
export const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

const EVENT_FOR_JOB: Readonly<Record<string, string>> = {
  [JIRA_SYNC_RUN_JOB]: 'jira.sync.requested',
  [JIRA_WEBHOOK_PROCESS_JOB]: 'jira.webhook.received',
  [JIRA_WEBHOOKS_SYNC_JOB]: 'jira.webhooks.sync',
  [JIRA_CONNECTION_CLEANUP_JOB]: 'jira.connection.cleanup',
};

export interface JiraJobDeps {
  readonly tenant: AsyncLocalTenantContext;
  readonly engine: JiraSyncEngine;
  readonly webhooks: JiraWebhookProcessor;
  readonly registrar: JiraWebhookRegistrar;
  readonly invalidate?: DashboardInvalidator;
}

export type JiraJobResult =
  | { readonly kind: 'slice'; readonly outcome: SliceOutcome }
  | { readonly kind: 'delivery'; readonly outcome: DeliveryProcessOutcome }
  | { readonly kind: 'webhooks'; readonly outcome: WebhookSyncOutcome }
  | { readonly kind: 'cleanup'; readonly outcome: 'cleaned' | 'skipped' };

/** Validates outbox job data: the tenant comes from the event's own organization, never the payload. */
function parseJob(jobName: string, data: unknown): { organizationId: string; payload: unknown } {
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== EVENT_FOR_JOB[jobName]) {
    throw new UnrecoverableError('Invalid Jira job data.');
  }
  return { organizationId: job.data.organizationId, payload: job.data.payload };
}

function payloadOf<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UnrecoverableError('Invalid Jira job payload.');
  }
  return parsed.data;
}

/**
 * Handles outbox-relayed `jira-sync` jobs in a system tenant context of the event's organization.
 * Every handler re-reads persisted state (run, delivery, connection) inside that organization, so
 * a job can never act on another tenant's rows, and every handler is safe to re-deliver.
 */
export async function handleJiraJob(jobName: string, data: unknown, deps: JiraJobDeps): Promise<JiraJobResult> {
  const { organizationId } = parseJob(jobName, data);
  const result = await runJiraJob(jobName, data, deps);
  // The issue cache, mappings or connection state may have changed.
  await deps.invalidate?.(organizationId, ['jira']);
  return result;
}

async function runJiraJob(jobName: string, data: unknown, deps: JiraJobDeps): Promise<JiraJobResult> {
  const { organizationId, payload } = parseJob(jobName, data);
  const context = { organizationId, memberId: null, userId: null };
  switch (jobName) {
    case JIRA_SYNC_RUN_JOB: {
      const { runId } = payloadOf(jiraSyncRequestedPayloadSchema, payload);
      return { kind: 'slice', outcome: await deps.tenant.run(context, () => deps.engine.runSlice(runId)) };
    }
    case JIRA_WEBHOOK_PROCESS_JOB: {
      const { deliveryId } = payloadOf(jiraWebhookReceivedPayloadSchema, payload);
      return { kind: 'delivery', outcome: await deps.tenant.run(context, () => deps.webhooks.process(deliveryId)) };
    }
    case JIRA_WEBHOOKS_SYNC_JOB: {
      const { connectionId } = payloadOf(jiraConnectionJobPayloadSchema, payload);
      return { kind: 'webhooks', outcome: await deps.tenant.run(context, () => deps.registrar.sync(connectionId)) };
    }
    case JIRA_CONNECTION_CLEANUP_JOB: {
      const { connectionId } = payloadOf(jiraConnectionJobPayloadSchema, payload);
      return { kind: 'cleanup', outcome: await deps.tenant.run(context, () => deps.registrar.cleanup(connectionId)) };
    }
    default:
      throw new UnrecoverableError(`Unknown jira-sync job "${jobName}".`);
  }
}

/** When to run the same sync job again, or null when it is done. */
export function nextSliceDelay(outcome: SliceOutcome): number | null {
  switch (outcome.kind) {
    case 'continue':
      return 0;
    case 'retry_later':
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(1_000, outcome.delayMs));
    case 'finished':
    case 'skipped':
      return null;
  }
}

export interface JiraScheduleIntervals {
  readonly reconcileMs: number;
  readonly deepReconcileMs: number;
}

export interface JiraScheduleTotals {
  readonly reconciliationsQueued: number;
  readonly deepChecksQueued: number;
  readonly staleRunsRequeued: number;
  readonly failedOrganizations: number;
}

export async function runJiraSchedule(
  scheduler: JiraScheduler,
  intervals: JiraScheduleIntervals,
  now: Date,
): Promise<JiraScheduleTotals> {
  const reconcile = await scheduler.queueDue('RECONCILIATION', intervals.reconcileMs, now);
  const deep = await scheduler.queueDue('DEEP_RECONCILIATION', intervals.deepReconcileMs, now);
  const stale = await scheduler.requeueStale(new Date(now.getTime() - STALE_RUN_MS));
  return {
    reconciliationsQueued: reconcile.queued,
    deepChecksQueued: deep.queued,
    staleRunsRequeued: stale,
    failedOrganizations: reconcile.failedOrganizations + deep.failedOrganizations,
  };
}

/** Sync progress hint for integration administrators (identifiers only; the UI re-fetches the run). */
export function syncProgressPublisher(realtime: RealtimePublisher, onError: (error: unknown) => void) {
  return (organizationId: string, runId: string): Promise<void> =>
    publishQuietly(
      realtime,
      [permissionChannel(organizationId, 'integration.manage')],
      { type: 'jira.sync.progress', entityType: 'jira_sync_run', entityId: runId },
      onError,
    );
}
