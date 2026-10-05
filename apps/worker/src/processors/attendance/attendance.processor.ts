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
import { ATTENDANCE_SWEEP_JOB, sweepAttendance } from './attendance-jobs.js';
import type { AttendanceSweepTotals } from './attendance-jobs.js';

/** Scheduled missing check-out sweep (Phase 7); jobs carry no organization. */
@Processor('attendance')
export class AttendanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttendanceProcessor.name);

  constructor(
    @InjectQueue('attendance') private readonly queue: Queue,
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
      ATTENDANCE_SWEEP_JOB,
      { every: this.env.ATTENDANCE_SWEEP_INTERVAL_MS },
      // One attempt: the next scheduled run is the retry, so failures never stack up duplicate sweeps.
      { name: ATTENDANCE_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 } },
    );
  }

  async process(job: Job): Promise<AttendanceSweepTotals> {
    if (job.name !== ATTENDANCE_SWEEP_JOB) {
      throw new UnrecoverableError(`Unknown attendance job "${job.name}".`);
    }
    const totals = await sweepAttendance(
      {
        prisma: this.prisma,
        db: this.db,
        tenant: this.tenant,
        invalidate: this.invalidate,
        onOrganizationError: (organizationId, error) => {
          this.logger.error({ err: error, organizationId }, 'Missing check-out sweep failed for an organization');
        },
      },
      new Date(),
    );
    if (totals.failedOrganizations > 0) {
      throw new Error(`Missing check-out sweep failed for ${String(totals.failedOrganizations)} organization(s).`);
    }
    return totals;
  }
}
