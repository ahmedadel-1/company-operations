import { isLockedPreference, NOTIFICATION_CATEGORIES, NOTIFICATION_PREFERENCE_CHANNELS } from '@company-ops/shared';
import type { NotificationCategoryKey, NotificationPreferenceChannelKey, PreferenceLookup } from '@company-ops/shared';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { InvalidInputError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';

/** A member's stored opt-outs as a lookup (no row = enabled). */
export async function loadPreferenceLookup(
  db: TenantDb,
  organizationId: string,
  memberId: string,
): Promise<PreferenceLookup> {
  const rows = await db.notificationPreference.findMany({
    where: { organizationId, memberId, enabled: false },
    select: { category: true, channel: true },
  });
  const disabled = new Set(rows.map((row) => `${row.category}:${row.channel}`));
  return (category, channel) => !disabled.has(`${category}:${channel}`);
}

export interface NotificationPreferenceItem {
  readonly category: NotificationCategoryKey;
  readonly inApp: boolean;
  readonly email: boolean;
  readonly inAppLocked: boolean;
  readonly emailLocked: boolean;
}

export interface PreferenceChange {
  readonly category: NotificationCategoryKey;
  readonly channel: NotificationPreferenceChannelKey;
  readonly enabled: boolean;
}

/**
 * The caller's own notification preferences (P8-8, ADR-0023). Bound to the caller's member id: there
 * is no way to read or change another member's preferences. Locked combinations (security, admin
 * alerts in-app) cannot be disabled; CRITICAL notifications are delivered regardless.
 */
export class NotificationPreferenceService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async get(action: ActionContext): Promise<{ items: NotificationPreferenceItem[] }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const enabled = await loadPreferenceLookup(this.db, organizationId, action.principal.memberId);
    return {
      items: NOTIFICATION_CATEGORIES.map((category) => {
        const inAppLocked = isLockedPreference(category, 'IN_APP');
        const emailLocked = isLockedPreference(category, 'EMAIL');
        return {
          category,
          inApp: inAppLocked || enabled(category, 'IN_APP'),
          email: emailLocked || enabled(category, 'EMAIL'),
          inAppLocked,
          emailLocked,
        };
      }),
    };
  }

  async update(
    action: ActionContext,
    changes: readonly PreferenceChange[],
  ): Promise<{ items: NotificationPreferenceItem[] }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const memberId = action.principal.memberId;
    const seen = new Set<string>();
    for (const change of changes) {
      const key = `${change.category}:${change.channel}`;
      if (seen.has(key)) {
        throw new InvalidInputError('items', 'Each category and channel may appear once.');
      }
      seen.add(key);
      if (!NOTIFICATION_PREFERENCE_CHANNELS.includes(change.channel)) {
        throw new InvalidInputError('items', 'Unknown channel.');
      }
      if (!change.enabled && isLockedPreference(change.category, change.channel)) {
        throw new InvalidInputError('items', 'This notification cannot be turned off.');
      }
    }
    await this.db.$transaction(async (tx) => {
      for (const change of changes) {
        await tx.notificationPreference.upsert({
          where: {
            organizationId_memberId_category_channel: {
              organizationId,
              memberId,
              category: change.category,
              channel: change.channel,
            },
          },
          create: {
            organizationId,
            memberId,
            category: change.category,
            channel: change.channel,
            enabled: change.enabled,
          },
          update: { enabled: change.enabled },
          select: { id: true },
        });
      }
      await recordAudit(tx, organizationId, {
        action: 'notification.preferences.updated',
        entityType: 'organization_member',
        entityId: memberId,
        actor: userActor(action),
        metadata: {
          changes: changes.map((change) => `${change.category}:${change.channel}:${String(change.enabled)}`),
        },
        context: action.request,
      });
    });
    return this.get(action);
  }
}
