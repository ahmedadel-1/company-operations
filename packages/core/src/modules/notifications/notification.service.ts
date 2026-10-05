import type { NotificationSeverity, Prisma } from '@company-ops/db';
import { preferenceAllows } from '@company-ops/shared';

import { InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { NotificationRequestedPayload } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { loadPreferenceLookup } from './notification-preferences.js';

export interface NotificationView {
  readonly id: string;
  readonly type: string;
  readonly severity: NotificationSeverity;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

const select = {
  id: true,
  type: true,
  severity: true,
  entityType: true,
  entityId: true,
  params: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof select }>;

const toView = (row: NotificationRow): NotificationView => ({
  id: row.id,
  type: row.type,
  severity: row.severity,
  entityType: row.entityType,
  entityId: row.entityId,
  params: typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params) ? row.params : {},
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * In-app notifications (P1-15, ADR-0011 foundation). A member only ever sees and changes their own
 * notifications: every query is bound to the organization and to the caller's member id, so
 * another member's notification id is 404.
 */
export class NotificationService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(
    action: ActionContext,
    filter: { unreadOnly?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<NotificationView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const size = pageSize(filter.limit);
    const and: Prisma.NotificationWhereInput[] = [{ recipientMemberId: action.principal.memberId }];
    if (filter.unreadOnly === true) {
      and.push({ readAt: null });
    }
    if (filter.cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(filter.cursor, 2);
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.notification.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async unreadCount(action: ActionContext): Promise<number> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.notification.count({
      where: { organizationId, recipientMemberId: action.principal.memberId, readAt: null },
    });
  }

  async markRead(action: ActionContext, notificationId: string): Promise<NotificationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const existing = await this.db.notification.findFirst({
      where: { organizationId, id: notificationId, recipientMemberId: action.principal.memberId },
      select,
    });
    if (existing === null) {
      throw new NotFoundError('Notification');
    }
    if (existing.readAt !== null) {
      return toView(existing);
    }
    const row = await this.db.notification.update({
      where: { organizationId_id: { organizationId, id: existing.id } },
      data: { readAt: new Date() },
      select,
    });
    return toView(row);
  }

  async markAllRead(action: ActionContext): Promise<number> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const result = await this.db.notification.updateMany({
      where: { organizationId, recipientMemberId: action.principal.memberId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}

export type NotificationWriteResult =
  | {
      readonly kind: 'created' | 'duplicate';
      readonly notificationId: string;
      /** The recipient's user, for the real-time hint (null without an identity or when in-app is muted). */
      readonly recipientUserId: string | null;
    }
  | { readonly kind: 'recipient_not_found' };

/**
 * Creates a notification from an outbox request inside the event's organization (system or member
 * tenant context). Idempotent: the unique (organization, recipient, dedupe_key) makes a re-delivered
 * job return the existing row instead of creating a second one. When the request asks for email,
 * the email delivery row and its outbox event are written in the same transaction, once per
 * notification (unique per notification and channel), so a retried job never queues a second email.
 */
export class NotificationWriter {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async create(request: NotificationRequestedPayload): Promise<NotificationWriteResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    return this.db.$transaction(async (tx) => {
      const recipient = await tx.organizationMember.findFirst({
        where: { organizationId, id: request.recipientMemberId },
        select: { id: true, userId: true, status: true },
      });
      if (recipient === null) {
        return { kind: 'recipient_not_found' } as const;
      }
      const key = { organizationId, recipientMemberId: recipient.id, dedupeKey: request.dedupeKey };
      const existing = await tx.notification.findFirst({ where: key, select: { id: true } });
      if (existing !== null) {
        return { kind: 'duplicate', notificationId: existing.id, recipientUserId: recipient.userId } as const;
      }
      const enabled = await loadPreferenceLookup(tx, organizationId, recipient.id);
      const inAppMuted = !preferenceAllows(enabled, request.type, request.severity, 'IN_APP');
      const emailAllowed = preferenceAllows(enabled, request.type, request.severity, 'EMAIL');
      const row = await tx.notification.upsert({
        where: { organizationId_recipientMemberId_dedupeKey: key },
        create: {
          ...key,
          type: request.type,
          severity: request.severity,
          entityType: request.entityType,
          entityId: request.entityId,
          params: { ...request.params },
          // Muted in-app: kept for history, but never unread and never announced.
          readAt: inAppMuted ? new Date() : null,
        },
        update: {},
        select: { id: true },
      });
      if (request.email === true && recipient.status === 'ACTIVE' && emailAllowed) {
        const delivery = await tx.notificationDelivery.create({
          data: { organizationId, notificationId: row.id, channel: 'EMAIL' },
          select: { id: true },
        });
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'notification.email.requested',
          aggregateType: 'notification',
          aggregateId: row.id,
          payload: { deliveryId: delivery.id },
        });
      }
      return {
        kind: 'created',
        notificationId: row.id,
        recipientUserId: inAppMuted ? null : recipient.userId,
      } as const;
    });
  }
}
