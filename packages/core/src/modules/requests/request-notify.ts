import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { NotificationRequestedPayload } from '../../platform/outbox/outbox.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import { canViewRequest, loadRequestForAccess, requestKey } from './request-access.js';
import { parseLabel } from './request-config.js';

export interface RequestNotification {
  readonly type: string;
  readonly severity: NotificationRequestedPayload['severity'];
  readonly email: boolean;
  /** Id of the history event (or approval) that caused it: one notification per recipient and cause. */
  readonly causeId: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Queues request notifications in the caller's transaction (outbox). Each recipient is re-checked with
 * the same visibility rule as the API (their own scope, participation or delegation), so nobody is told
 * about a request they cannot open; the acting member is never notified about their own change.
 * Parameters are the request key and type name only: form contents and comments are never included.
 */
export async function notifyRequestRecipients(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  recipientMemberIds: readonly (string | null | undefined)[],
  notification: RequestNotification,
  actorMemberId: string | null,
  now: Date,
): Promise<number> {
  const candidates = [
    ...new Set(recipientMemberIds.filter((id): id is string => typeof id === 'string' && id !== actorMemberId)),
  ].sort();
  if (candidates.length === 0) {
    return 0;
  }
  const request = await db.requestInstance.findFirst({
    where: { organizationId, id: requestId },
    select: { number: true, requestType: { select: { name: true } } },
  });
  if (request === null) {
    return 0;
  }
  const typeName = parseLabel(request.requestType.name);
  const access = await loadMemberAccess(db, organizationId, candidates);
  let queued = 0;
  for (const memberId of candidates) {
    const member = access.get(memberId);
    if (member === undefined) {
      continue;
    }
    const loaded = await loadRequestForAccess(db, organizationId, requestId, memberId, now);
    if (loaded === null || !canViewRequest(member.principal, loaded)) {
      continue;
    }
    await enqueueOutboxEvent(db, organizationId, {
      eventType: 'notification.requested',
      aggregateType: 'request',
      aggregateId: requestId,
      payload: {
        recipientMemberId: memberId,
        type: notification.type,
        severity: notification.severity,
        entityType: 'request',
        entityId: requestId,
        params: {
          requestNumber: requestKey(request.number),
          typeName: typeName.en,
          ...(typeName.ar === undefined ? {} : { typeNameAr: typeName.ar }),
          ...notification.params,
        },
        dedupeKey: `${notification.type.toLowerCase()}:${requestId}:${notification.causeId}`,
        ...(notification.email ? { email: true } : {}),
      },
    });
    queued += 1;
  }
  return queued;
}

/** Announces a request change for live views (identifiers only; recipients re-fetch via the API). */
export async function announceRequestChange(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  fulfillment: boolean,
): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'request.changed',
    aggregateType: 'request',
    aggregateId: requestId,
    payload: { requestId, fulfillment },
  });
}

/** Members holding `request.admin` (stalled steps need an administrator). Bounded. */
export async function requestAdminMemberIds(db: TenantDb, organizationId: string): Promise<string[]> {
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      userId: { not: null },
      roles: { some: { role: { permissions: { some: { permissionKey: 'request.admin', scope: 'ORG' } } } } },
    },
    orderBy: { id: 'asc' },
    take: 50,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Active delegates of the given approvers for a request type at `now` (not transitive). */
export async function delegatesOf(
  db: TenantDb,
  organizationId: string,
  approverMemberIds: readonly string[],
  requestTypeId: string,
  now: Date,
): Promise<string[]> {
  if (approverMemberIds.length === 0) {
    return [];
  }
  const rows = await db.approvalDelegation.findMany({
    where: {
      organizationId,
      delegatorMemberId: { in: [...new Set(approverMemberIds)] },
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gt: now },
      OR: [{ requestTypeId: null }, { requestTypeId }],
    },
    take: 100,
    select: { delegateMemberId: true },
  });
  return [...new Set(rows.map((row) => row.delegateMemberId))];
}

/**
 * Users to hint about a request change over SSE: the requester, everyone assigned to or deciding its
 * approvals and active delegates of pending ones, each re-checked like notifications.
 */
export async function requestRealtimeAudience(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const request = await db.requestInstance.findFirst({
    where: { organizationId, id: requestId },
    select: { requesterMemberId: true, requestTypeId: true, status: true },
  });
  if (request === null) {
    return [];
  }
  const approvals = await db.requestApproval.findMany({
    where: { organizationId, requestId },
    take: 200,
    select: { approverMemberId: true, decidedByMemberId: true, status: true },
  });
  const pendingApprovers = approvals.filter((row) => row.status === 'PENDING').map((row) => row.approverMemberId);
  const candidates = [
    request.requesterMemberId,
    ...approvals.flatMap((row) => [row.approverMemberId, row.decidedByMemberId]),
    ...(await delegatesOf(db, organizationId, pendingApprovers, request.requestTypeId, now)),
  ].filter((id): id is string => id !== null);
  const access = await loadMemberAccess(db, organizationId, candidates);
  const userIds: string[] = [];
  for (const member of access.values()) {
    const loaded = await loadRequestForAccess(db, organizationId, requestId, member.memberId, now);
    if (loaded !== null && canViewRequest(member.principal, loaded)) {
      userIds.push(member.userId);
    }
  }
  return userIds.sort();
}
