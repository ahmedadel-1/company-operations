import type { Prisma } from '@company-ops/db';

import type { QueueName } from '../queues/queue-names.js';

/**
 * Transactional outbox (ARCHITECTURE §3). Producers call {@link enqueueOutboxEvent} with the same
 * transaction client as their business change, so the event exists if and only if the change
 * committed. The worker relay moves due events to BullMQ with the deterministic job id
 * {@link outboxJobId}. Payloads carry identifiers and i18n parameters only, never secrets.
 */

/** Asks the notifications consumer to create one in-app notification (idempotent by `dedupeKey`). */
export interface NotificationRequestedPayload {
  readonly recipientMemberId: string;
  readonly type: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly dedupeKey: string;
  /** Also deliver by email (one deduplicated delivery per notification, sent by the worker). */
  readonly email?: boolean;
}

/** Asks the notifications consumer to send one email delivery (idempotent by delivery status). */
export interface NotificationEmailRequestedPayload {
  readonly deliveryId: string;
}

/**
 * Asks the notifications consumer to announce a ticket change to the people involved (reporter,
 * assignee, watchers) and, when `broadcast`, to organization-wide support viewers. Identifiers only.
 */
export interface TicketChangedPayload {
  readonly ticketId: string;
  readonly broadcast: boolean;
}

export type ActivitySource = 'SUPPORT' | 'JIRA' | 'GITHUB' | 'DAILY_REPORT' | 'PROJECT' | 'REQUEST';

/**
 * Asks the project-activity consumer to append one timeline entry (DATA_MODEL §4 `project_activity`).
 * The consumer is idempotent by the outbox event id, so the timeline can be rebuilt by replaying.
 */
export interface ProjectActivityRecordedPayload {
  readonly projectId: string;
  /** ISO-8601 UTC instant of the business change. */
  readonly occurredAt: string;
  readonly source: ActivitySource;
  /** Dotted type, e.g. `project.status_changed`. */
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** i18n parameters only. */
  readonly summaryParams: Readonly<Record<string, string | number | boolean | null>>;
  readonly actorMemberId: string | null;
}

/**
 * Asks the maintenance consumer to remove the stored object of an attachment that was deleted in
 * the same transaction. Retried until storage confirms, so a storage outage never leaves an
 * orphaned object behind a successful delete.
 */
export interface AttachmentObjectDeletePayload {
  readonly attachmentId: string;
}

/** Asks the Jira worker to start or continue a sync run (Phase 4). */
export interface JiraSyncRequestedPayload {
  readonly runId: string;
}

/** Asks the Jira worker to process a verified, recorded webhook delivery (Phase 4). */
export interface JiraWebhookReceivedPayload {
  readonly deliveryId: string;
}

/**
 * Connection-level Jira work (Phase 4): `jira.webhooks.sync` reconciles the dynamic webhook
 * registration with the current mappings; `jira.connection.cleanup` removes webhooks and wipes the
 * stored tokens of a disconnected connection.
 */
export interface JiraConnectionJobPayload {
  readonly connectionId: string;
}

/** Asks the GitHub worker to refresh an installation and its repository access (Phase 5). */
export interface GithubInstallationSyncPayload {
  readonly installationId: string;
}

/** Asks the GitHub worker to process a verified, recorded webhook delivery (Phase 5). */
export interface GithubWebhookReceivedPayload {
  readonly deliveryId: string;
}

/** Asks the GitHub worker to start or continue a repository sync run (Phase 5). */
export interface GithubSyncRequestedPayload {
  readonly runId: string;
}

/** Asks the notifications consumer to hint a request change to the people involved over SSE (Phase 6). */
export interface RequestChangedPayload {
  readonly requestId: string;
  /** Also announce on the organization-wide fulfillment channel (approved requests awaiting fulfillment). */
  readonly fulfillment: boolean;
}

/**
 * A trusted request effect was recorded or revoked (Phase 6, ADR-0021). Identifiers only: consumers
 * re-read the effect row, which is tenant-bound and immutable apart from its revocation. Phase 7
 * attendance materializes approved leave, remote work and missions from these events.
 */
export interface RequestEffectPayload {
  readonly requestId: string;
  readonly effectId: string;
}

/**
 * Dashboard data of these domains changed without another event that retires cached dashboards
 * (attendance check-in/out, corrections). Phase 8, ADR-0023.
 */
export interface DashboardChangedPayload {
  readonly domains: readonly ('support' | 'projects' | 'requests' | 'attendance' | 'jira' | 'github' | 'commercial')[];
}

export interface OutboxEventPayloads {
  'notification.requested': NotificationRequestedPayload;
  'project.activity.recorded': ProjectActivityRecordedPayload;
  'attachment.object.delete': AttachmentObjectDeletePayload;
  'notification.email.requested': NotificationEmailRequestedPayload;
  'support.ticket.changed': TicketChangedPayload;
  'jira.sync.requested': JiraSyncRequestedPayload;
  'jira.webhook.received': JiraWebhookReceivedPayload;
  'jira.webhooks.sync': JiraConnectionJobPayload;
  'jira.connection.cleanup': JiraConnectionJobPayload;
  'github.installation.sync': GithubInstallationSyncPayload;
  'github.webhook.received': GithubWebhookReceivedPayload;
  'github.sync.requested': GithubSyncRequestedPayload;
  'request.changed': RequestChangedPayload;
  'request.approved': RequestEffectPayload;
  'request.effect.revoked': RequestEffectPayload;
  'dashboard.changed': DashboardChangedPayload;
}

export type OutboxEventType = keyof OutboxEventPayloads;

/** Every payload field is a JSON value; spreading into an index-signature object keeps that typed. */
function toJsonObject<T extends OutboxEventType>(
  eventType: T,
  payload: OutboxEventPayloads[T],
): Prisma.InputJsonObject {
  if (eventType === 'notification.requested') {
    const notification = payload as NotificationRequestedPayload;
    const json: Record<string, Prisma.InputJsonValue | null> = { ...notification, params: { ...notification.params } };
    return json;
  }
  if (eventType === 'project.activity.recorded') {
    const activity = payload as ProjectActivityRecordedPayload;
    const json: Record<string, Prisma.InputJsonValue | null> = {
      ...activity,
      summaryParams: { ...activity.summaryParams },
    };
    return json;
  }
  if (eventType === 'notification.email.requested') {
    return { deliveryId: (payload as NotificationEmailRequestedPayload).deliveryId };
  }
  if (eventType === 'support.ticket.changed') {
    const changed = payload as TicketChangedPayload;
    return { ticketId: changed.ticketId, broadcast: changed.broadcast };
  }
  if (eventType === 'jira.sync.requested') {
    return { runId: (payload as JiraSyncRequestedPayload).runId };
  }
  if (eventType === 'jira.webhook.received') {
    return { deliveryId: (payload as JiraWebhookReceivedPayload).deliveryId };
  }
  if (eventType === 'jira.webhooks.sync' || eventType === 'jira.connection.cleanup') {
    return { connectionId: (payload as JiraConnectionJobPayload).connectionId };
  }
  if (eventType === 'github.installation.sync') {
    return { installationId: (payload as GithubInstallationSyncPayload).installationId };
  }
  if (eventType === 'github.webhook.received') {
    return { deliveryId: (payload as GithubWebhookReceivedPayload).deliveryId };
  }
  if (eventType === 'github.sync.requested') {
    return { runId: (payload as GithubSyncRequestedPayload).runId };
  }
  if (eventType === 'request.changed') {
    const changed = payload as RequestChangedPayload;
    return { requestId: changed.requestId, fulfillment: changed.fulfillment };
  }
  if (eventType === 'request.approved' || eventType === 'request.effect.revoked') {
    const effect = payload as RequestEffectPayload;
    return { requestId: effect.requestId, effectId: effect.effectId };
  }
  if (eventType === 'dashboard.changed') {
    return { domains: [...(payload as DashboardChangedPayload).domains] };
  }
  const deletion = payload as AttachmentObjectDeletePayload;
  return { attachmentId: deletion.attachmentId };
}

/** Where each event type is delivered. Every outbox event type must have a route. */
export const OUTBOX_ROUTES: Readonly<Record<OutboxEventType, { queue: QueueName; jobName: string }>> = {
  'notification.requested': { queue: 'notifications', jobName: 'notification.create' },
  'project.activity.recorded': { queue: 'projects', jobName: 'project-activity.record' },
  'attachment.object.delete': { queue: 'maintenance', jobName: 'attachment-object.delete' },
  'notification.email.requested': { queue: 'notifications', jobName: 'notification.email.send' },
  'support.ticket.changed': { queue: 'notifications', jobName: 'realtime.ticket.publish' },
  'jira.sync.requested': { queue: 'jira-sync', jobName: 'jira.sync.run' },
  'jira.webhook.received': { queue: 'jira-sync', jobName: 'jira.webhook.process' },
  'jira.webhooks.sync': { queue: 'jira-sync', jobName: 'jira.webhooks.sync' },
  'jira.connection.cleanup': { queue: 'jira-sync', jobName: 'jira.connection.cleanup' },
  'github.installation.sync': { queue: 'github-sync', jobName: 'github.installation.sync' },
  'github.webhook.received': { queue: 'github-sync', jobName: 'github.webhook.process' },
  'github.sync.requested': { queue: 'github-sync', jobName: 'github.reconcile.repo' },
  'request.changed': { queue: 'notifications', jobName: 'realtime.request.publish' },
  'request.approved': { queue: 'requests', jobName: 'request.effect.recorded' },
  'request.effect.revoked': { queue: 'requests', jobName: 'request.effect.revoked' },
  'dashboard.changed': { queue: 'notifications', jobName: 'dashboard.invalidate' },
};

export function isOutboxEventType(value: string): value is OutboxEventType {
  return Object.hasOwn(OUTBOX_ROUTES, value);
}

/**
 * BullMQ job id for an outbox event: re-relaying the same event never creates a second job.
 * BullMQ rejects custom ids containing `:` (its key separator).
 */
export function outboxJobId(eventId: string): string {
  return `outbox-${eventId}`;
}

/** Job data handed to consumers: the event's own organization plus its payload. */
export interface OutboxJobData {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface OutboxStore {
  outboxEvent: {
    create(args: { data: Prisma.OutboxEventUncheckedCreateInput; select: { id: true } }): PromiseLike<{ id: string }>;
  };
}

export async function enqueueOutboxEvent<T extends OutboxEventType>(
  store: OutboxStore,
  organizationId: string,
  event: {
    readonly eventType: T;
    readonly aggregateType: string;
    readonly aggregateId: string | null;
    readonly payload: OutboxEventPayloads[T];
  },
): Promise<string> {
  const row = await store.outboxEvent.create({
    data: {
      organizationId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: toJsonObject(event.eventType, event.payload),
    },
    select: { id: true },
  });
  return row.id;
}
