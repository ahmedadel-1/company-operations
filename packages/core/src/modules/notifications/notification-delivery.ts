import { preferenceAllows } from '@company-ops/shared';

import type { EmailChannel } from '../../platform/email/email-channel.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { renderNotificationEmail } from './email-templates.js';
import type { EmailLanguage } from './email-templates.js';
import type { NotificationEntityAccess } from './notification-entity-access.js';
import { loadPreferenceLookup } from './notification-preferences.js';

export type DeliveryOutcome =
  | 'sent'
  | 'already_sent'
  | 'skipped_disabled'
  | 'skipped_no_address'
  | 'skipped_inactive'
  | 'skipped_preference'
  | 'suppressed_not_authorized'
  | 'not_found';

/** `last_error` of a suppressed delivery: a reason code only, never the subject or its content. */
export const NOT_AUTHORIZED_REASON = 'recipient_not_authorized';

/** A delivery claimed this long ago without finishing is assumed abandoned (worker crash). */
export const DELIVERY_CLAIM_TIMEOUT_MS = 10 * 60_000;

/** Raised while another attempt holds a fresh claim; the job is retried later. */
export class DeliveryInProgressError extends Error {
  constructor() {
    super('The delivery is being sent by another attempt.');
    this.name = 'DeliveryInProgressError';
  }
}

function errorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return `${name}${code === '' ? '' : ` ${code}`}`.slice(0, 120);
}

/**
 * Sends one email delivery (P3-9) in the system tenant context of the delivery's organization.
 * Idempotent: SENT and SKIPPED deliveries are never sent again, and an attempt claims the delivery
 * (`SENDING`) with a conditional update before talking to SMTP, so concurrent retries cannot both
 * send. A crash between sending and recording leaves a stale claim that is retried after
 * {@link DELIVERY_CLAIM_TIMEOUT_MS}; the stable Message-ID lets mail systems drop that duplicate.
 * Recipients who are no longer active members are skipped. Immediately before claiming, the
 * recipient's access to the notification's subject is re-evaluated against current grants; if it is
 * gone the delivery becomes SUPPRESSED (terminal, never retried, reason code only). The content
 * comes from the notification type and params only (no comment text).
 */
export class NotificationDeliveryService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly email: EmailChannel,
    private readonly appPublicUrl: string,
    private readonly messageIdHost: string,
    private readonly entityAccess: NotificationEntityAccess,
  ) {}

  async send(deliveryId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const delivery = await this.db.notificationDelivery.findFirst({
      where: { organizationId, id: deliveryId },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        notification: {
          select: {
            type: true,
            severity: true,
            params: true,
            entityType: true,
            entityId: true,
            recipientMemberId: true,
            recipient: {
              select: {
                status: true,
                user: { select: { email: true } },
                profile: { select: { workEmail: true, locale: true } },
                organization: { select: { defaultLocale: true } },
              },
            },
          },
        },
      },
    });
    if (delivery === null) {
      return 'not_found';
    }
    if (delivery.status === 'SENT' || delivery.status === 'SKIPPED' || delivery.status === 'SUPPRESSED') {
      return 'already_sent';
    }
    if (delivery.status === 'SENDING' && now.getTime() - delivery.updatedAt.getTime() < DELIVERY_CLAIM_TIMEOUT_MS) {
      throw new DeliveryInProgressError();
    }
    const { notification } = delivery;
    const recipient = notification.recipient;
    if (!this.email.enabled) {
      return this.skip(organizationId, delivery.id, 'email_disabled', 'skipped_disabled');
    }
    if (recipient.status !== 'ACTIVE') {
      return this.skip(organizationId, delivery.id, 'recipient_inactive', 'skipped_inactive');
    }
    const address = recipient.profile?.workEmail ?? recipient.user?.email ?? null;
    if (address === null) {
      return this.skip(organizationId, delivery.id, 'no_address', 'skipped_no_address');
    }
    const enabled = await loadPreferenceLookup(this.db, organizationId, notification.recipientMemberId);
    if (!preferenceAllows(enabled, notification.type, notification.severity, 'EMAIL')) {
      return this.skip(organizationId, delivery.id, 'preference_disabled', 'skipped_preference');
    }
    const stillAllowed = await this.entityAccess(
      organizationId,
      notification.recipientMemberId,
      notification.entityType,
      notification.entityId,
    );
    if (!stillAllowed) {
      await this.db.notificationDelivery.updateMany({
        where: { organizationId, id: delivery.id, status: { in: ['PENDING', 'FAILED', 'SENDING'] } },
        data: { status: 'SUPPRESSED', lastError: NOT_AUTHORIZED_REASON },
      });
      return 'suppressed_not_authorized';
    }
    const claimed = await this.db.notificationDelivery.updateMany({
      where: { organizationId, id: delivery.id, status: delivery.status, updatedAt: delivery.updatedAt },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new DeliveryInProgressError();
    }
    const language: EmailLanguage =
      (recipient.profile?.locale ?? recipient.organization.defaultLocale) === 'ar' ? 'ar' : 'en';
    const params =
      typeof notification.params === 'object' && notification.params !== null && !Array.isArray(notification.params)
        ? notification.params
        : {};
    const rendered = renderNotificationEmail({
      type: notification.type,
      params,
      language,
      link: this.linkFor(notification.entityType, notification.entityId),
    });
    try {
      await this.email.send({
        to: address,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        messageId: `<${delivery.id}@${this.messageIdHost}>`,
        language,
      });
    } catch (error) {
      await this.db.notificationDelivery.updateMany({
        where: { organizationId, id: delivery.id },
        data: { status: 'FAILED', lastError: errorSummary(error) },
      });
      throw error;
    }
    await this.db.notificationDelivery.updateMany({
      where: { organizationId, id: delivery.id },
      data: { status: 'SENT', sentAt: new Date(), lastError: null },
    });
    return 'sent';
  }

  private async skip(
    organizationId: string,
    deliveryId: string,
    reason: string,
    outcome: DeliveryOutcome,
  ): Promise<DeliveryOutcome> {
    await this.db.notificationDelivery.updateMany({
      where: { organizationId, id: deliveryId },
      data: { status: 'SKIPPED', lastError: reason },
    });
    return outcome;
  }

  private linkFor(entityType: string | null, entityId: string | null): string {
    if (entityType === 'support_ticket' && entityId !== null) {
      return `${this.appPublicUrl}/support/tickets/${encodeURIComponent(entityId)}`;
    }
    if (entityType === 'request' && entityId !== null) {
      return `${this.appPublicUrl}/requests/${encodeURIComponent(entityId)}`;
    }
    if (entityType === 'tender' && entityId !== null) {
      return `${this.appPublicUrl}/tenders/${encodeURIComponent(entityId)}`;
    }
    if (entityType === 'contract' && entityId !== null) {
      return `${this.appPublicUrl}/contracts/${encodeURIComponent(entityId)}`;
    }
    if (entityType === 'corporate_document' && entityId !== null) {
      return `${this.appPublicUrl}/documents/${encodeURIComponent(entityId)}`;
    }
    if (entityType === 'approval_delegation') {
      return `${this.appPublicUrl}/approvals/delegations`;
    }
    if (entityType === 'jira_connection') {
      return `${this.appPublicUrl}/admin/integrations/jira`;
    }
    if (entityType === 'github_installation') {
      return `${this.appPublicUrl}/admin/integrations/github`;
    }
    return `${this.appPublicUrl}/notifications`;
  }
}
