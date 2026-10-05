import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, DailyReportMissingCheck, PrismaClient } from '@company-ops/core';

import {
  checkMissingReports,
  MISSING_REPORTS_CHECK_EVERY_MS,
  MISSING_REPORTS_CHECK_JOB,
} from './missing-reports-check.js';

/** Scheduled report checks; jobs carry no organization and are never shown to tenants. */
@Processor('reports')
export class ReportsProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue('reports') private readonly queue: Queue,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
    @Inject(DailyReportMissingCheck) private readonly check: DailyReportMissingCheck,
  ) {
    super();
  }

  /** Idempotent: re-registering the scheduler on every start keeps exactly one schedule. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      MISSING_REPORTS_CHECK_JOB,
      { every: MISSING_REPORTS_CHECK_EVERY_MS },
      { name: MISSING_REPORTS_CHECK_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async process(job: Job): Promise<{ organizations: number; projects: number; notifications: number }> {
    if (job.name !== MISSING_REPORTS_CHECK_JOB) {
      throw new UnrecoverableError(`Unknown reports job "${job.name}".`);
    }
    return checkMissingReports({ prisma: this.prisma, tenant: this.tenant, check: this.check }, new Date());
  }
}
