import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import {
  AsyncLocalTenantContext,
  JiraScheduler,
  JiraSyncEngine,
  JiraWebhookProcessor,
  JiraWebhookRegistrar,
  PrismaClient,
} from '@company-ops/core';
import type { DashboardInvalidator, JiraRuntime, RealtimePublisher, TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { DASHBOARD_INVALIDATOR, JIRA_RUNTIME, REALTIME_PUBLISHER, TENANT_DB } from '../../worker-tokens.js';
import {
  handleJiraJob,
  JIRA_SCHEDULE_JOB,
  JIRA_WEBHOOK_REFRESH_JOB,
  nextSliceDelay,
  runJiraSchedule,
  syncProgressPublisher,
} from './jira-jobs.js';
import type { JiraJobDeps, JiraJobResult, JiraScheduleTotals } from './jira-jobs.js';

/** How often due reconciliations are looked for (each mapping is still synced only once per interval). */
const SCHEDULE_TICK_MS = 5 * 60 * 1000;

interface JiraWorkers extends JiraJobDeps {
  readonly scheduler: JiraScheduler;
}

/**
 * `jira-sync` queue (Phase 4): sync-run slices, webhook processing, webhook registration upkeep and
 * connection cleanup (outbox-relayed, per organization), plus two organization-less schedules.
 * A sync run is one job that re-delays itself between slices, so a long import never holds a worker
 * and every slice resumes from the run's persisted checkpoint. Slices of one connection never run in
 * parallel (Redis sync lock), so concurrency only lets webhooks and other organizations proceed
 * while an import is running. Without Jira app credentials the
 * queue only rejects jobs and no schedule is registered.
 */
@Processor('jira-sync', { concurrency: 4 })
export class JiraProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(JiraProcessor.name);
  private readonly workers: JiraWorkers | null;

  constructor(
    @InjectQueue('jira-sync') private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) prisma: PrismaClient,
    @Inject(TENANT_DB) db: TenantScopedClient,
    @Inject(AsyncLocalTenantContext) tenant: AsyncLocalTenantContext,
    @Inject(JIRA_RUNTIME) runtime: JiraRuntime | null,
    @Inject(REALTIME_PUBLISHER) realtime: RealtimePublisher,
    @Inject(DASHBOARD_INVALIDATOR) invalidate: DashboardInvalidator,
  ) {
    super();
    const onOrganizationError = (organizationId: string, error: unknown): void => {
      this.logger.error({ err: error, organizationId }, 'Jira scheduled work failed for an organization');
    };
    this.workers =
      runtime === null
        ? null
        : {
            tenant,
            invalidate,
            engine: new JiraSyncEngine(
              db,
              tenant,
              runtime.clients,
              runtime.coordination,
              syncProgressPublisher(realtime, (error) => {
                this.logger.warn({ err: error }, 'Jira progress hint could not be published');
              }),
            ),
            webhooks: new JiraWebhookProcessor(db, tenant, runtime.clients),
            registrar: new JiraWebhookRegistrar(db, tenant, runtime.clients, runtime.settings),
            scheduler: new JiraScheduler(prisma, db, tenant, onOrganizationError),
          };
  }

  /** Idempotent: re-registering on every start keeps exactly one schedule of each kind. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.workers === null) {
      await Promise.all([
        this.queue.removeJobScheduler(JIRA_SCHEDULE_JOB),
        this.queue.removeJobScheduler(JIRA_WEBHOOK_REFRESH_JOB),
      ]);
      return;
    }
    const opts = { attempts: 1, removeOnComplete: 100, removeOnFail: 500 };
    await this.queue.upsertJobScheduler(
      JIRA_SCHEDULE_JOB,
      { every: Math.min(SCHEDULE_TICK_MS, this.env.JIRA_RECONCILE_INTERVAL_MS) },
      { name: JIRA_SCHEDULE_JOB, opts },
    );
    await this.queue.upsertJobScheduler(
      JIRA_WEBHOOK_REFRESH_JOB,
      { every: this.env.JIRA_WEBHOOK_REFRESH_INTERVAL_MS },
      { name: JIRA_WEBHOOK_REFRESH_JOB, opts },
    );
  }

  async process(job: Job, token?: string): Promise<JiraJobResult | JiraScheduleTotals | { connections: number }> {
    const workers = this.workers;
    if (workers === null) {
      throw new UnrecoverableError('The Jira integration is not configured for this worker.');
    }
    if (job.name === JIRA_SCHEDULE_JOB) {
      const totals = await runJiraSchedule(
        workers.scheduler,
        { reconcileMs: this.env.JIRA_RECONCILE_INTERVAL_MS, deepReconcileMs: this.env.JIRA_DEEP_RECONCILE_INTERVAL_MS },
        new Date(),
      );
      if (totals.failedOrganizations > 0) {
        throw new Error(`Jira scheduling failed for ${String(totals.failedOrganizations)} organization(s).`);
      }
      return totals;
    }
    if (job.name === JIRA_WEBHOOK_REFRESH_JOB) {
      const totals = await workers.scheduler.forEachConnection(async (connectionId) => {
        try {
          await workers.registrar.sync(connectionId);
        } catch (error) {
          this.logger.warn({ err: error, connectionId }, 'Jira webhook upkeep failed for a connection');
        }
      });
      return { connections: totals.queued };
    }
    const result = await handleJiraJob(job.name, job.data, workers);
    if (result.kind === 'slice') {
      const delay = nextSliceDelay(result.outcome);
      if (delay !== null && token !== undefined) {
        // Same job, next slice: no new queue entry, and attempts are not consumed.
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    }
    return result;
  }
}
