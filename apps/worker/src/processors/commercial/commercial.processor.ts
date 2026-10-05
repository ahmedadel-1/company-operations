import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, PrismaClient } from '@company-ops/core';
import type { DashboardInvalidator, TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { DASHBOARD_INVALIDATOR, TENANT_DB } from '../../worker-tokens.js';
import { COMMERCIAL_MONITOR_JOB, runCommercialMonitor } from './commercial-jobs.js';
import type { CommercialMonitorTotals } from './commercial-jobs.js';

/** Scheduled tender, contract, guarantee and corporate document monitor (Phase 10); jobs carry no organization. */
@Processor('commercial')
export class CommercialProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommercialProcessor.name);

  constructor(
    @InjectQueue('commercial') private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TENANT_DB) private readonly db: TenantScopedClient,
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
    @Inject(DASHBOARD_INVALIDATOR) private readonly invalidate: DashboardInvalidator,
  ) {
    super();
  }

  /** Idempotent: re-registering the scheduler on every start keeps exactly one schedule. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      COMMERCIAL_MONITOR_JOB,
      { every: this.env.COMMERCIAL_MONITOR_INTERVAL_MS },
      // One attempt: the next scheduled run is the retry, so failures never stack up duplicate passes.
      { name: COMMERCIAL_MONITOR_JOB, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  async process(job: Job): Promise<CommercialMonitorTotals> {
    if (job.name !== COMMERCIAL_MONITOR_JOB) {
      throw new UnrecoverableError(`Unknown commercial job "${job.name}".`);
    }
    const totals = await runCommercialMonitor(
      {
        prisma: this.prisma,
        db: this.db,
        tenant: this.tenant,
        invalidate: this.invalidate,
        onOrganizationError: (organizationId, error) => {
          this.logger.error({ err: error, organizationId }, 'Commercial monitor failed for an organization');
        },
      },
      new Date(),
    );
    if (totals.failedOrganizations > 0) {
      throw new Error(`Commercial monitor failed for ${String(totals.failedOrganizations)} organization(s).`);
    }
    return totals;
  }
}
