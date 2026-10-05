import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, AttachmentService, PrismaClient, RetentionPurger } from '@company-ops/core';
import type { PurgeTotals, TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { TENANT_DB } from '../../worker-tokens.js';
import { DELETE_ATTACHMENT_OBJECT_JOB, handleDeleteAttachmentObjectJob } from './delete-attachment-object.js';
import { EXPIRE_ATTACHMENTS_EVERY_MS, EXPIRE_ATTACHMENTS_JOB, expirePendingAttachments } from './expire-attachments.js';

/** Scheduled, organization-less: applies retention policies to technical integration records. */
export const RETENTION_PURGE_JOB = 'retention.purge';

/**
 * System maintenance: the scheduled cross-organization sweeps (upload expiry, retention purge),
 * plus storage cleanup relayed from the outbox (bound to the event's organization). Never shown to
 * tenants.
 */
@Processor('maintenance')
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private readonly purger: RetentionPurger;

  constructor(
    @InjectQueue('maintenance') private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(TENANT_DB) db: TenantScopedClient,
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
  ) {
    super();
    this.purger = new RetentionPurger(prisma, db, tenant, (organizationId, error) => {
      this.logger.error({ err: error, organizationId }, 'Retention purge failed for an organization');
    });
  }

  /** Idempotent: re-registering the schedulers on every start keeps exactly one schedule each. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRE_ATTACHMENTS_JOB,
      { every: EXPIRE_ATTACHMENTS_EVERY_MS },
      { name: EXPIRE_ATTACHMENTS_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
    await this.queue.upsertJobScheduler(
      RETENTION_PURGE_JOB,
      { every: this.env.RETENTION_PURGE_INTERVAL_MS },
      { name: RETENTION_PURGE_JOB, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async process(job: Job): Promise<{ expired: number } | { deleted: boolean } | PurgeTotals> {
    if (job.name === DELETE_ATTACHMENT_OBJECT_JOB) {
      return handleDeleteAttachmentObjectJob(job.data, { tenant: this.tenant, attachments: this.attachments });
    }
    if (job.name === RETENTION_PURGE_JOB) {
      const totals = await this.purger.purgeAll(this.env.RETENTION_PURGE_BATCH_SIZE);
      if (totals.failedOrganizations > 0) {
        throw new Error(`Retention purge failed for ${String(totals.failedOrganizations)} organization(s).`);
      }
      return totals;
    }
    if (job.name !== EXPIRE_ATTACHMENTS_JOB) {
      throw new UnrecoverableError(`Unknown maintenance job "${job.name}".`);
    }
    return {
      expired: await expirePendingAttachments({
        prisma: this.prisma,
        tenant: this.tenant,
        attachments: this.attachments,
      }),
    };
  }
}
