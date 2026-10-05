import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, PrismaClient } from '@company-ops/core';
import type { TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { TENANT_DB } from '../../worker-tokens.js';
import { SLA_SWEEP_JOB, sweepSlas } from './sla-sweep-job.js';
import type { SlaSweepTotals } from './sla-sweep-job.js';

/** Scheduled SLA evaluation and escalation (P3-11/12); jobs carry no organization. */
@Processor('sla')
export class SlaProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(
    @InjectQueue('sla') private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TENANT_DB) private readonly db: TenantScopedClient,
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
  ) {
    super();
  }

  /** Idempotent: re-registering the scheduler on every start keeps exactly one schedule. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SLA_SWEEP_JOB,
      { every: this.env.SLA_SWEEP_INTERVAL_MS },
      // One attempt: the next scheduled run is the retry, so failures never stack up duplicate sweeps.
      { name: SLA_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  async process(job: Job): Promise<SlaSweepTotals> {
    if (job.name !== SLA_SWEEP_JOB) {
      throw new UnrecoverableError(`Unknown sla job "${job.name}".`);
    }
    const totals = await sweepSlas(
      {
        prisma: this.prisma,
        db: this.db,
        tenant: this.tenant,
        onOrganizationError: (organizationId, error) => {
          this.logger.error({ err: error, organizationId }, 'SLA sweep failed for an organization');
        },
      },
      new Date(),
    );
    if (totals.failedOrganizations > 0) {
      throw new Error(`SLA sweep failed for ${String(totals.failedOrganizations)} organization(s).`);
    }
    return totals;
  }
}
