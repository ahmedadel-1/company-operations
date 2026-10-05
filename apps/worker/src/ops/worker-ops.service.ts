import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  MetricsRegistry,
  outboxBacklog,
  pingDatabase,
  PrismaClient,
  PROMETHEUS_CONTENT_TYPE,
  QUEUE_NAMES,
  startOpsServer,
} from '@company-ops/core';
import type { OpsServer } from '@company-ops/core';
import { withTimeout } from '@company-ops/shared';

import { WORKER_ENV } from '../config/worker-env.js';
import type { WorkerEnv } from '../config/worker-env.js';
import { REDIS } from '../worker-tokens.js';

const CHECK_TIMEOUT_MS = 2_000;
const JOB_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'failed', 'completed'] as const;

/**
 * Worker health and metrics on the internal ops listener (ADR-0024). Readiness turns false as soon as
 * shutdown starts, so an orchestrator stops counting this instance before its jobs finish draining.
 */
@Injectable()
export class WorkerOpsService implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerOpsService.name);
  private server: OpsServer | null = null;
  private draining = false;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ModuleRef) private readonly modules: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.WORKER_OPS_PORT === 0) {
      return;
    }
    const metrics = this.createMetrics();
    this.server = await startOpsServer({
      host: this.env.WORKER_OPS_HOST,
      port: this.env.WORKER_OPS_PORT,
      routes: {
        '/health/live': () => Promise.resolve({ status: 200, body: '{"status":"ok"}' }),
        '/health/ready': async () => {
          const ready = !this.draining && (await this.dependenciesUp());
          return { status: ready ? 200 : 503, body: JSON.stringify({ status: ready ? 'ok' : 'unavailable' }) };
        },
        '/metrics': async () => ({ status: 200, body: await metrics.render(), contentType: PROMETHEUS_CONTENT_TYPE }),
      },
    });
    this.logger.log(`Ops listener on ${this.env.WORKER_OPS_HOST}:${String(this.server.port)}`);
  }

  beforeApplicationShutdown(): void {
    this.draining = true;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server?.close();
  }

  private async dependenciesUp(): Promise<boolean> {
    const results = await Promise.allSettled([
      withTimeout(pingDatabase(this.prisma), CHECK_TIMEOUT_MS, 'database ping'),
      withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS, 'redis ping'),
    ]);
    const failed = results.filter((result) => result.status === 'rejected');
    for (const failure of failed) {
      const reason: unknown = failure.reason;
      this.logger.warn({ err: reason }, 'Worker readiness check failed');
    }
    return failed.length === 0;
  }

  private createMetrics(): MetricsRegistry {
    const metrics = new MetricsRegistry();
    metrics.registerProcessMetrics();
    metrics.gauge('queue_jobs', 'Jobs per queue and state (completed and failed are retained jobs only).', async () => {
      const samples = await Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const queue = this.modules.get<Queue>(getQueueToken(name), { strict: false });
          const counts = await withTimeout(queue.getJobCounts(...JOB_STATES), CHECK_TIMEOUT_MS, 'queue counts');
          return JOB_STATES.map((state) => ({ labels: { queue: name, state }, value: counts[state] ?? 0 }));
        }),
      );
      return samples.flat();
    });
    metrics.gauge('outbox_events', 'Undispatched outbox events by state.', async () => {
      const backlog = await withTimeout(
        outboxBacklog(this.prisma, this.env.OUTBOX_MAX_ATTEMPTS),
        CHECK_TIMEOUT_MS,
        'outbox backlog',
      );
      return [
        { labels: { state: 'pending' }, value: backlog.pending },
        { labels: { state: 'failed' }, value: backlog.failed },
      ];
    });
    metrics.gauge('outbox_oldest_pending_seconds', 'Age of the oldest undispatched outbox event.', async () => {
      const backlog = await withTimeout(
        outboxBacklog(this.prisma, this.env.OUTBOX_MAX_ATTEMPTS),
        CHECK_TIMEOUT_MS,
        'outbox backlog',
      );
      return [{ value: Math.round(backlog.oldestPendingSeconds) }];
    });
    metrics.gauge('worker_ready', '1 while the worker accepts work, 0 while draining.', () => [
      { value: this.draining ? 0 : 1 },
    ]);
    return metrics;
  }
}
