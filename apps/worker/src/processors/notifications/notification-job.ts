import { UnrecoverableError } from 'bullmq';

import {
  permissionChannel,
  publishQuietly,
  requestRealtimeAudience,
  ticketRealtimeAudience,
  userChannel,
} from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  DeliveryOutcome,
  NotificationDeliveryService,
  NotificationWriteResult,
  NotificationWriter,
  RealtimePublisher,
  TenantScopedClient,
} from '@company-ops/core';
import {
  dashboardChangedPayloadSchema,
  notificationEmailPayloadSchema,
  notificationRequestedPayloadSchema,
  outboxJobDataSchema,
  requestChangedPayloadSchema,
  ticketChangedPayloadSchema,
} from '@company-ops/validation';

export const NOTIFICATION_CREATE_JOB = 'notification.create';
export const NOTIFICATION_EMAIL_JOB = 'notification.email.send';
export const TICKET_REALTIME_JOB = 'realtime.ticket.publish';
export const REQUEST_REALTIME_JOB = 'realtime.request.publish';
export const DASHBOARD_INVALIDATE_JOB = 'dashboard.invalidate';

export interface NotificationJobDeps {
  readonly tenant: AsyncLocalTenantContext;
  readonly db: TenantScopedClient;
  readonly writer: NotificationWriter;
  readonly delivery: NotificationDeliveryService;
  readonly realtime: RealtimePublisher;
  readonly onRealtimeError: (error: unknown) => void;
  /** Retires cached dashboards of changed domains (absent: dashboards rely on their TTL). */
  readonly invalidate?: DashboardInvalidator;
}

export type NotificationJobResult =
  | { readonly kind: 'notification'; readonly result: NotificationWriteResult }
  | { readonly kind: 'email'; readonly outcome: DeliveryOutcome }
  | { readonly kind: 'realtime'; readonly recipients: number }
  | { readonly kind: 'dashboard'; readonly domains: number };

/** Validates outbox job data: the tenant always comes from the event's own organization, never the payload. */
function parseJob(data: unknown, eventType: string): { organizationId: string; payload: unknown } {
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== eventType) {
    throw new UnrecoverableError('Invalid notification job data.');
  }
  return { organizationId: job.data.organizationId, payload: job.data.payload };
}

const systemContext = (organizationId: string) => ({ organizationId, memberId: null, userId: null });

/**
 * Handles the `notifications` queue in a system tenant context of the event's organization (no
 * acting member). Malformed data, an unexpected event type or a recipient outside that organization
 * are permanent failures (no retry). Every job is safe to re-deliver:
 * - `notification.create`: idempotent by `(organization, recipient, dedupeKey)`; a new notification
 *   is hinted to the recipient's live views.
 * - `notification.email.send`: the delivery row is claimed before SMTP and SENT/SKIPPED rows are
 *   never resent; SMTP failures throw so BullMQ retries with backoff and the row records the error.
 * - `realtime.ticket.publish` / `realtime.request.publish`: retire cached support / request dashboards,
 *   then identifier-only hints to the re-checked audience; a Redis failure is logged, never retried.
 * - `dashboard.invalidate`: retires cached dashboards of the event's domains (ADR-0023).
 */
export async function handleNotificationJob(
  jobName: string,
  data: unknown,
  deps: NotificationJobDeps,
): Promise<NotificationJobResult> {
  if (jobName === NOTIFICATION_CREATE_JOB) {
    const job = parseJob(data, 'notification.requested');
    const payload = notificationRequestedPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new UnrecoverableError('Invalid notification payload.');
    }
    const { email, ...request } = payload.data;
    const result = await deps.tenant.run(systemContext(job.organizationId), () =>
      deps.writer.create(email === true ? { ...request, email } : request),
    );
    if (result.kind === 'recipient_not_found') {
      throw new UnrecoverableError('The recipient is not a member of the event organization.');
    }
    if (result.kind === 'created' && result.recipientUserId !== null) {
      await publishQuietly(
        deps.realtime,
        [userChannel(job.organizationId, result.recipientUserId)],
        { type: 'notification.created', entityType: 'notification', entityId: result.notificationId },
        deps.onRealtimeError,
      );
    }
    return { kind: 'notification', result };
  }
  if (jobName === NOTIFICATION_EMAIL_JOB) {
    const job = parseJob(data, 'notification.email.requested');
    const payload = notificationEmailPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new UnrecoverableError('Invalid email delivery payload.');
    }
    const outcome = await deps.tenant.run(systemContext(job.organizationId), () =>
      deps.delivery.send(payload.data.deliveryId),
    );
    return { kind: 'email', outcome };
  }
  if (jobName === TICKET_REALTIME_JOB) {
    const job = parseJob(data, 'support.ticket.changed');
    const payload = ticketChangedPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new UnrecoverableError('Invalid ticket change payload.');
    }
    const { ticketId, broadcast } = payload.data;
    // Before the hint, so a view refetching on it never reads a retired dashboard entry.
    await deps.invalidate?.(job.organizationId, ['support']);
    const userIds = await deps.tenant.run(systemContext(job.organizationId), () =>
      ticketRealtimeAudience(deps.db, job.organizationId, ticketId),
    );
    const channels = userIds.map((userId) => userChannel(job.organizationId, userId));
    if (broadcast) {
      channels.push(permissionChannel(job.organizationId, 'support.view'));
    }
    await publishQuietly(
      deps.realtime,
      channels,
      { type: 'support.ticket.changed', entityType: 'support_ticket', entityId: ticketId },
      deps.onRealtimeError,
    );
    return { kind: 'realtime', recipients: channels.length };
  }
  if (jobName === REQUEST_REALTIME_JOB) {
    const job = parseJob(data, 'request.changed');
    const payload = requestChangedPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new UnrecoverableError('Invalid request change payload.');
    }
    const { requestId, fulfillment } = payload.data;
    await deps.invalidate?.(job.organizationId, ['requests']);
    const userIds = await deps.tenant.run(systemContext(job.organizationId), () =>
      requestRealtimeAudience(deps.db, job.organizationId, requestId),
    );
    const channels = userIds.map((userId) => userChannel(job.organizationId, userId));
    if (fulfillment) {
      channels.push(permissionChannel(job.organizationId, 'request.fulfill'));
    }
    await publishQuietly(
      deps.realtime,
      channels,
      { type: 'request.changed', entityType: 'request', entityId: requestId },
      deps.onRealtimeError,
    );
    return { kind: 'realtime', recipients: channels.length };
  }
  if (jobName === DASHBOARD_INVALIDATE_JOB) {
    const job = parseJob(data, 'dashboard.changed');
    const payload = dashboardChangedPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new UnrecoverableError('Invalid dashboard change payload.');
    }
    await deps.invalidate?.(job.organizationId, payload.data.domains);
    return { kind: 'dashboard', domains: payload.data.domains.length };
  }
  throw new UnrecoverableError(`Unknown job "${jobName}" on the notifications queue.`);
}
