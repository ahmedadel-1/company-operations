import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly payload: unknown;
  readonly attempts: number;
}

interface ClaimedRow {
  id: string;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  payload: unknown;
  attempts: number;
}

/**
 * Outbox relay claim (system process, ARCHITECTURE §3). This is deliberately cross-organization:
 * the relay moves every tenant's pending events to the queue, and each event carries its own
 * `organization_id`, which consumers use to build their tenant context.
 *
 * Claims up to `limit` due events with `FOR UPDATE SKIP LOCKED` (concurrent relays never claim
 * the same row), increments `attempts` and pushes `available_at` forward by `leaseMs`, so an event
 * whose relay crashed before marking it dispatched becomes due again after the lease. Events at
 * `maxAttempts` are no longer claimed (permanently failed, visible through the admin API).
 */
export async function claimOutboxEvents(
  db: RawSqlClient,
  options: { limit: number; leaseMs: number; maxAttempts: number },
): Promise<ClaimedOutboxEvent[]> {
  const rows = await db.$queryRaw<ClaimedRow[]>(Prisma.sql`
    UPDATE outbox_events o
    SET attempts = o.attempts + 1,
        available_at = now() + make_interval(secs => ${options.leaseMs / 1000})
    WHERE o.id IN (
      SELECT id FROM outbox_events
      WHERE dispatched_at IS NULL AND available_at <= now() AND attempts < ${options.maxAttempts}
      ORDER BY available_at, id
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING o.id::text AS id, o.organization_id::text AS organization_id, o.event_type, o.aggregate_type,
              o.aggregate_id, o.payload, o.attempts
  `);
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

/** Marks a claimed event as handed to the queue. Bound to the event's own organization. */
export async function markOutboxEventDispatched(
  db: RawSqlClient,
  event: { id: string; organizationId: string },
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE outbox_events SET dispatched_at = now(), last_error = NULL
    WHERE id = ${event.id}::uuid AND organization_id = ${event.organizationId}::uuid AND dispatched_at IS NULL
  `);
}

export interface OutboxBacklog {
  /** Undispatched events still eligible for the relay. */
  readonly pending: number;
  /** Undispatched events at `maxAttempts` (permanently failed until an operator acts). */
  readonly failed: number;
  /** Age in seconds of the oldest pending event; 0 when nothing is pending. */
  readonly oldestPendingSeconds: number;
}

/**
 * Operational totals across all organizations for metrics (ADR-0024): counts only, no tenant, event or
 * payload detail. Served by the `dispatched_at, available_at` index.
 */
export async function outboxBacklog(db: RawSqlClient, maxAttempts: number): Promise<OutboxBacklog> {
  const rows = await db.$queryRaw<{ pending: bigint; failed: bigint; oldest: number | null }[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE attempts < ${maxAttempts}) AS pending,
           count(*) FILTER (WHERE attempts >= ${maxAttempts}) AS failed,
           extract(epoch FROM now() - min(created_at) FILTER (WHERE attempts < ${maxAttempts}))::float8 AS oldest
    FROM outbox_events
    WHERE dispatched_at IS NULL
  `);
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0n),
    failed: Number(row?.failed ?? 0n),
    oldestPendingSeconds: Math.max(0, row?.oldest ?? 0),
  };
}

/** Records a relay failure; the event becomes due again after `retryInMs` unless out of attempts. */
export async function markOutboxEventFailed(
  db: RawSqlClient,
  event: { id: string; organizationId: string },
  error: string,
  retryInMs: number,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE outbox_events
    SET last_error = ${error.slice(0, 1000)},
        available_at = now() + make_interval(secs => ${retryInMs / 1000})
    WHERE id = ${event.id}::uuid AND organization_id = ${event.organizationId}::uuid AND dispatched_at IS NULL
  `);
}
