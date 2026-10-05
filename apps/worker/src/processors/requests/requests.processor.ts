import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, PrismaClient } from '@company-ops/core';
import type { DashboardInvalidator, TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { DASHBOARD_INVALIDATOR, TENANT_DB } from '../../worker-tokens.js';
import { handleRequestJob, REQUEST_SLA_SWEEP_JOB } from './request-jobs.js';
import type { RequestJobResult } from './request-jobs.js';

/** Approval reminders (scheduled) and request effect events (outbox, consumed by attendance), Phases 6-7. */
@Processor('requests')
export class RequestsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(RequestsProcessor.name);

  constructor(
    @InjectQueue('requests') private readonly queue: Queue,
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
      REQUEST_SLA_SWEEP_JOB,
      { every: this.env.REQUEST_SLA_SWEEP_INTERVAL_MS },
      { name: REQUEST_SLA_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  async process(job: Job): Promise<RequestJobResult> {
    const result = await handleRequestJob(
      job.name,
      job.data,
      {
        prisma: this.prisma,
        db: this.db,
        tenant: this.tenant,
        invalidate: this.invalidate,
        onOrganizationError: (organizationId, error) => {
          this.logger.error({ err: error, organizationId }, 'Approval reminder sweep failed for an organization');
        },
      },
      new Date(),
    );
    if (result.kind === 'sweep' && result.failedOrganizations > 0) {
      throw new Error(`Approval reminder sweep failed for ${String(result.failedOrganizations)} organization(s).`);
    }
    if (result.kind === 'effect') {
      this.logger.log(
        { effectId: result.effectId, outcome: result.outcome, dates: result.dates },
        'Attendance effect processed',
      );
    }
    return result;
  }
}
