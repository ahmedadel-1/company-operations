import type { JobsOptions } from 'bullmq';

import {
  claimOutboxEvents,
  isOutboxEventType,
  markOutboxEventDispatched,
  markOutboxEventFailed,
  OUTBOX_ROUTES,
  outboxJobId,
} from '@company-ops/core';
import type { ClaimedOutboxEvent, OutboxJobData, PrismaClient, QueueName } from '@company-ops/core';

/** The part of a BullMQ queue the relay uses. */
export interface RelayQueue {
  add(name: string, data: OutboxJobData, options: JobsOptions): Promise<unknown>;
}

export interface OutboxRelayOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  /** Attempts per queue job (exponential backoff) before it stays failed. */
  readonly jobAttempts: number;
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Exponential backoff for events the relay could not hand to the queue: 1 s, 2 s, 4 s ... 5 min. */
export const relayRetryDelayMs = (attempts: number): number =>
  Math.min(1000 * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_DELAY_MS);

export interface RelayResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

/**
 * Moves due outbox events to BullMQ (ARCHITECTURE §3). The job id is derived from the event id, so
 * a relay that crashes between `add` and `markDispatched` (or two relays racing after a lease
 * expiry) re-adds the same job id and BullMQ keeps exactly one job. Each event is updated only
 * within its own organization. Events of an unknown type, or that cannot be queued, are retried
 * with backoff until `maxAttempts`, after which they stay visible as failed.
 */
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queues: (name: QueueName) => RelayQueue,
    private readonly options: OutboxRelayOptions,
  ) {}

  async relayBatch(): Promise<RelayResult> {
    const events = await claimOutboxEvents(this.prisma, {
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
      maxAttempts: this.options.maxAttempts,
    });
    let dispatched = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.dispatch(event);
        await markOutboxEventDispatched(this.prisma, event);
        dispatched += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Unknown relay error';
        await markOutboxEventFailed(this.prisma, event, message, relayRetryDelayMs(event.attempts));
      }
    }
    return { claimed: events.length, dispatched, failed };
  }

  private async dispatch(event: ClaimedOutboxEvent): Promise<void> {
    if (!isOutboxEventType(event.eventType)) {
      throw new Error(`No route for outbox event type "${event.eventType}".`);
    }
    const route = OUTBOX_ROUTES[event.eventType];
    const data: OutboxJobData = {
      eventId: event.id,
      organizationId: event.organizationId,
      eventType: event.eventType,
      payload: event.payload,
    };
    await this.queues(route.queue).add(route.jobName, data, {
      jobId: outboxJobId(event.id),
      attempts: this.options.jobAttempts,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      // Failed jobs stay for 30 days so administrators can see them (GET /admin/failed-jobs).
      removeOnFail: { age: 30 * 24 * 3600 },
    });
  }
}
