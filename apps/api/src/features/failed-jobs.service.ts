import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import { FailedOutboxService, QUEUE_NAMES } from '@company-ops/core';
import type { ActionContext } from '@company-ops/core';
import { redisConnectionOptions } from '@company-ops/shared';
import type { FailedJob } from '@company-ops/validation';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';

/** Failed jobs scanned per queue; BullMQ keeps failed jobs until they are removed by retention. */
const FAILED_SCAN_PER_QUEUE = 500;
const MAX_RESULTS = 100;
const MAX_ERROR_LENGTH = 500;

const truncate = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : value.slice(0, MAX_ERROR_LENGTH);

function organizationOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const organizationId: unknown = Reflect.get(data, 'organizationId');
  return typeof organizationId === 'string' ? organizationId : null;
}

/**
 * Failed background work of the active organization (P1-15): queue jobs whose data carries this
 * organization's id plus outbox events the relay could not dispatch. Jobs without an organization
 * (system maintenance) are never shown to tenants. Job payloads are never returned.
 */
@Injectable()
export class FailedJobsService implements OnApplicationShutdown {
  private queues: Queue[] | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(FailedOutboxService) private readonly outbox: FailedOutboxService,
  ) {}

  async list(action: ActionContext): Promise<FailedJob[]> {
    // Authorizes (`org.settings.manage`) before any queue is read.
    const events = await this.outbox.list(action);
    const organizationId = action.principal.organizationId;
    const results: FailedJob[] = events.map((event) => ({
      source: 'outbox',
      id: event.id,
      queue: null,
      name: event.eventType,
      attempts: event.attempts,
      error: truncate(event.lastError),
      failedAt: null,
      createdAt: event.createdAt,
    }));
    for (const queue of this.lazyQueues()) {
      const failed = await queue.getFailed(0, FAILED_SCAN_PER_QUEUE - 1);
      for (const job of failed) {
        if (organizationOf(job.data) !== organizationId || job.id === undefined) {
          continue;
        }
        results.push({
          source: 'queue',
          id: job.id,
          queue: queue.name,
          name: job.name,
          attempts: job.attemptsMade,
          error: truncate(job.failedReason),
          failedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn).toISOString(),
          createdAt: new Date(job.timestamp).toISOString(),
        });
      }
    }
    return results
      .sort((a, b) => (b.failedAt ?? b.createdAt).localeCompare(a.failedAt ?? a.createdAt))
      .slice(0, MAX_RESULTS);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled((this.queues ?? []).map((queue) => queue.close()));
  }

  /** Created on first use so API startup (and OpenAPI emission) never opens queue connections. */
  private lazyQueues(): Queue[] {
    this.queues ??= QUEUE_NAMES.map(
      (name) => new Queue(name, { connection: redisConnectionOptions(this.env.REDIS_URL) }),
    );
    return this.queues;
  }
}
