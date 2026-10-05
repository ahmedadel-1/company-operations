import type { Prisma } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

import { InvalidInputError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { NotificationRequestedPayload } from '../../platform/outbox/outbox.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { organizationZone } from '../attendance/attendance-store.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import type { Principal } from '../authorization/policy.js';
import { isValidTimeZone } from '../organizations/provision-organization.js';
import { localToday, toDateOnly } from '../projects/business-date.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import type { TicketPersonRef } from '../support/ticket-views.js';

export type PersonRef = TicketPersonRef;
export { memberRefSelect, toPersonRef };

export const personOrNull = (row: Parameters<typeof toPersonRef>[0] | null): PersonRef | null =>
  row === null ? null : toPersonRef(row);

export const iso = (value: Date): string => value.toISOString();
export const isoOrNull = (value: Date | null): string | null => (value === null ? null : value.toISOString());
export const dateOnly = (value: Date | null): string | null => toDateOnly(value);
export const dateOnlyStrict = (value: Date): string => value.toISOString().slice(0, 10);

/** The organization's zone and local date (all commercial date rules use it). */
export async function organizationToday(
  db: TenantDb,
  organizationId: string,
  now: Date,
): Promise<{ timeZone: string; today: string }> {
  const timeZone = await organizationZone(db, organizationId);
  return { timeZone, today: localToday(now, timeZone) };
}

/** IANA zone names are checked against the runtime's zone database. */
export function assertTimeZone(field: string, value: string): void {
  if (!isValidTimeZone(value)) {
    throw new InvalidInputError(field, 'Unknown time zone.');
  }
}

/** Members assigned to commercial work must be ACTIVE members of the organization. */
export async function assertActiveMembers(
  db: TenantDb,
  organizationId: string,
  entries: readonly (readonly [field: string, memberId: string | null | undefined])[],
): Promise<void> {
  const ids = [...new Set(entries.map(([, id]) => id).filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) return;
  const rows = await db.organizationMember.findMany({
    where: { organizationId, id: { in: ids }, status: 'ACTIVE' },
    select: { id: true },
  });
  const found = new Set(rows.map((row) => row.id));
  for (const [field, id] of entries) {
    if (typeof id === 'string' && !found.has(id)) {
      throw new InvalidInputError(field, 'The member does not exist or is not active.');
    }
  }
}

/** Active members holding `permission` at any scope (candidates; callers re-check per record). Bounded. */
export async function permissionHolderIds(
  db: TenantDb,
  organizationId: string,
  permission: PermissionKey,
): Promise<string[]> {
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      userId: { not: null },
      roles: { some: { role: { permissions: { some: { permissionKey: permission } } } } },
    },
    orderBy: { id: 'asc' },
    take: 100,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export interface CommercialNotification {
  readonly type: string;
  readonly severity: NotificationRequestedPayload['severity'];
  readonly entityType: 'tender' | 'contract' | 'corporate_document';
  readonly entityId: string;
  /** Record key and title only; never money, document contents or comments. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** Unique per cause, so a retried operation or monitor rerun never repeats a notification. */
  readonly dedupeKey: string;
  readonly email?: boolean;
}

/**
 * Queues one notification per recipient in the caller's transaction. Each recipient is re-checked
 * with `allowed(principal)` against their own current grants (the record's visibility rule); the
 * acting member is never notified about their own change.
 */
export async function notifyMembers(
  db: TenantDb,
  organizationId: string,
  recipientIds: readonly (string | null | undefined)[],
  notification: CommercialNotification,
  allowed: (principal: Principal) => boolean | Promise<boolean>,
  actorMemberId: string | null,
): Promise<number> {
  const candidates = [
    ...new Set(recipientIds.filter((id): id is string => typeof id === 'string' && id !== actorMemberId)),
  ].sort();
  if (candidates.length === 0) return 0;
  const access = await loadMemberAccess(db, organizationId, candidates);
  let queued = 0;
  for (const memberId of candidates) {
    const member = access.get(memberId);
    if (member === undefined || member.employmentStatus === 'TERMINATED') continue;
    if (!(await allowed(member.principal))) continue;
    await enqueueOutboxEvent(db, organizationId, {
      eventType: 'notification.requested',
      aggregateType: notification.entityType,
      aggregateId: notification.entityId,
      payload: {
        recipientMemberId: memberId,
        type: notification.type,
        severity: notification.severity,
        entityType: notification.entityType,
        entityId: notification.entityId,
        params: notification.params,
        dedupeKey: `${notification.dedupeKey}:${memberId}`,
        ...(notification.email === true ? { email: true } : {}),
      },
    });
    queued += 1;
  }
  return queued;
}

/** Dashboards, needs-attention and search caches of the organization are refreshed. */
export async function announceCommercialChange(
  db: TenantDb,
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'dashboard.changed',
    aggregateType,
    aggregateId,
    payload: { domains: ['commercial'] },
  });
}

export type EventParams = Record<string, string | number | boolean | null>;

/** Business timeline entry of a tender (append-only; identifiers and i18n parameters only). */
export async function appendTenderEvent(
  db: TenantDb,
  organizationId: string,
  tenderId: string,
  type: string,
  actorMemberId: string | null,
  metadata: EventParams = {},
): Promise<void> {
  await db.tenderEvent.create({
    data: { organizationId, tenderId, type, actorMemberId, metadata: metadata as Prisma.InputJsonObject },
    select: { id: true },
  });
}

/**
 * Business timeline entry of a contract. Money goes under `financial` only and is stripped for readers
 * without `contract.financial.view`.
 */
export async function appendContractEvent(
  db: TenantDb,
  organizationId: string,
  contractId: string,
  type: string,
  actorMemberId: string | null,
  metadata: EventParams = {},
  financial?: EventParams,
): Promise<void> {
  const json: Record<string, Prisma.InputJsonValue | null> = { ...metadata };
  if (financial !== undefined) json.financial = financial;
  await db.contractEvent.create({
    data: { organizationId, contractId, type, actorMemberId, metadata: json },
    select: { id: true },
  });
}

/** Timeline parameters for a reader: nested values dropped, `financial` only when permitted. */
export function eventParams(metadata: Prisma.JsonValue, includeFinancial: boolean): EventParams {
  const result: EventParams = {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return result;
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'financial') {
      if (includeFinancial && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [financialKey, financialValue] of Object.entries(value)) {
          if (isScalar(financialValue)) result[financialKey] = financialValue;
        }
      }
      continue;
    }
    if (isScalar(value)) result[key] = value;
  }
  return result;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
