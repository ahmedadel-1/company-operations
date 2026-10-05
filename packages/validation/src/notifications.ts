import { z } from 'zod';

import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

const severitySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);

export const notificationSchema = z.strictObject({
  id: z.uuid(),
  /** Stable type key; the web app renders the localized text from `type` + `params`. */
  type: z.string(),
  severity: severitySchema,
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const notificationResponseSchema = dataResponseSchema(notificationSchema);
export const notificationPageResponseSchema = pageResponseSchema(notificationSchema);
export const notificationListQuerySchema = z.strictObject({
  unreadOnly: booleanQuerySchema.optional(),
  ...pageQueryShape,
});
export const unreadCountResponseSchema = dataResponseSchema(z.strictObject({ unread: z.number().int() }));
export const markAllReadResponseSchema = dataResponseSchema(z.strictObject({ updated: z.number().int() }));

/**
 * Payload of the `notification.requested` outbox event / `notification.create` job. Validated by
 * the worker before use; a payload that fails validation is a permanent job failure.
 */
export const notificationRequestedPayloadSchema = z.strictObject({
  recipientMemberId: z.uuid(),
  type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  severity: severitySchema,
  entityType: z.string().max(64).nullable(),
  entityId: z.string().max(64).nullable(),
  params: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()])),
  dedupeKey: z.string().min(1).max(200),
  /** Also deliver by email (one deduplicated delivery per notification). */
  email: z.boolean().optional(),
});

/** Payload of the `attachment.object.delete` outbox event / `attachment-object.delete` job. */
export const attachmentObjectDeletePayloadSchema = z.strictObject({ attachmentId: z.uuid() });

/** Payload of the `notification.email.requested` outbox event / `notification.email.send` job. */
export const notificationEmailPayloadSchema = z.strictObject({ deliveryId: z.uuid() });

/** Payload of the `support.ticket.changed` outbox event / `realtime.ticket.publish` job. */
export const ticketChangedPayloadSchema = z.strictObject({
  ticketId: z.uuid(),
  /** Also announce on the organization-wide support channel (critical tickets, new assignments). */
  broadcast: z.boolean(),
});

/** Payload of the `request.changed` outbox event / `realtime.request.publish` job (Phase 6). */
export const requestChangedPayloadSchema = z.strictObject({
  requestId: z.uuid(),
  /** Also announce on the organization-wide fulfillment channel. */
  fulfillment: z.boolean(),
});

/** Payload of the `dashboard.changed` outbox event / `dashboard.invalidate` job (Phase 8, ADR-0023). */
export const dashboardChangedPayloadSchema = z.strictObject({
  domains: z
    .array(z.enum(['support', 'projects', 'requests', 'attendance', 'jira', 'github', 'commercial']))
    .min(1)
    .max(7),
});

/** Payload of the `request.approved` / `request.effect.revoked` outbox events (Phase 6 → Phase 7 boundary). */
export const requestEffectPayloadSchema = z.strictObject({
  requestId: z.uuid(),
  effectId: z.uuid(),
});

/** Live update pushed over `GET /notifications/events/stream` (identifiers only). */
export const realtimeEventSchema = z.strictObject({
  type: z.string(),
  entityType: z.string(),
  entityId: z.string(),
});

/** Data of every outbox-relayed job: the event's own organization binds the tenant context. */
export const outboxJobDataSchema = z.strictObject({
  eventId: z.uuid(),
  organizationId: z.uuid(),
  eventType: z.string(),
  payload: z.unknown(),
});

export type Notification = z.infer<typeof notificationSchema>;
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type NotificationRequestedPayloadInput = z.infer<typeof notificationRequestedPayloadSchema>;
