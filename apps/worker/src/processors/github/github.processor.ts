import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import {
  AsyncLocalTenantContext,
  GithubInstallationSync,
  GithubScheduler,
  GithubSyncEngine,
  GithubWebhookProcessor,
  PrismaClient,
} from '@company-ops/core';
import type { DashboardInvalidator, GithubRuntime, RealtimePublisher, TenantScopedClient } from '@company-ops/core';

import { WORKER_ENV } from '../../config/worker-env.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import { DASHBOARD_INVALIDATOR, GITHUB_RUNTIME, REALTIME_PUBLISHER, TENANT_DB } from '../../worker-tokens.js';
import {
  GITHUB_INSTALLATION_REFRESH_JOB,
  GITHUB_SCHEDULE_JOB,
  githubProgressPublisher,
  handleGithubJob,
  nextGithubSliceDelay,
  runGithubSchedule,
} from './github-jobs.js';
import type { GithubJobDeps, GithubJobResult, GithubScheduleTotals } from './github-jobs.js';

/** How often due reconciliations are looked for (each repository is still synced once per interval). */
const SCHEDULE_TICK_MS = 5 * 60 * 1000;

interface GithubWorkers extends GithubJobDeps {
  readonly scheduler: GithubScheduler;
}

/**
 * `github-sync` queue (Phase 5): repository sync-run slices, webhook delivery processing and
 * installation syncs (outbox-relayed, per organization), plus two organization-less schedules
 * (reconciliation and installation refresh). A sync run is one job that re-delays itself between
 * slices; slices of one repository never run in parallel (Redis lock). Without GitHub App
 * credentials the queue only rejects jobs and no schedule is registered.
 */
@Processor('github-sync', { concurrency: 4 })
export class GithubProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(GithubProcessor.name);
  private readonly workers: GithubWorkers | null;

  constructor(
    @InjectQueue('github-sync') private readonly queue: Queue,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(PrismaClient) prisma: PrismaClient,
    @Inject(TENANT_DB) db: TenantScopedClient,
    @Inject(AsyncLocalTenantContext) tenant: AsyncLocalTenantContext,
    @Inject(GITHUB_RUNTIME) runtime: GithubRuntime | null,
    @Inject(REALTIME_PUBLISHER) realtime: RealtimePublisher,
    @Inject(DASHBOARD_INVALIDATOR) invalidate: DashboardInvalidator,
  ) {
    super();
    const onOrganizationError = (organizationId: string, error: unknown): void => {
      this.logger.error({ err: error, organizationId }, 'GitHub scheduled work failed for an organization');
    };
    if (runtime === null) {
      this.workers = null;
      return;
    }
    const installations = new GithubInstallationSync(db, tenant, runtime);
    this.workers = {
      tenant,
      invalidate,
      installations,
      engine: new GithubSyncEngine(
        db,
        tenant,
        runtime,
        githubProgressPublisher(realtime, (error) => {
          this.logger.warn({ err: error }, 'GitHub progress hint could not be published');
        }),
        { historyDays: env.GITHUB_PR_HISTORY_DAYS },
      ),
      webhooks: new GithubWebhookProcessor(db, tenant, runtime, installations),
      scheduler: new GithubScheduler(prisma, db, tenant, onOrganizationError),
    };
  }

  /** Idempotent: re-registering on every start keeps exactly one schedule of each kind. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.workers === null) {
      await Promise.all([
        this.queue.removeJobScheduler(GITHUB_SCHEDULE_JOB),
        this.queue.removeJobScheduler(GITHUB_INSTALLATION_REFRESH_JOB),
      ]);
      return;
    }
    const opts = { attempts: 1, removeOnComplete: 100, removeOnFail: 500 };
    await this.queue.upsertJobScheduler(
      GITHUB_SCHEDULE_JOB,
      { every: Math.min(SCHEDULE_TICK_MS, this.env.GITHUB_RECONCILE_INTERVAL_MS) },
      { name: GITHUB_SCHEDULE_JOB, opts },
    );
    await this.queue.upsertJobScheduler(
      GITHUB_INSTALLATION_REFRESH_JOB,
      { every: Math.min(SCHEDULE_TICK_MS * 6, this.env.GITHUB_INSTALLATION_SYNC_INTERVAL_MS) },
      { name: GITHUB_INSTALLATION_REFRESH_JOB, opts },
    );
  }

  async process(job: Job, token?: string): Promise<GithubJobResult | GithubScheduleTotals | { installations: number }> {
    const workers = this.workers;
    if (workers === null) {
      throw new UnrecoverableError('The GitHub integration is not configured for this worker.');
    }
    if (job.name === GITHUB_SCHEDULE_JOB) {
      const totals = await runGithubSchedule(workers.scheduler, this.env.GITHUB_RECONCILE_INTERVAL_MS, new Date());
      if (totals.failedOrganizations > 0) {
        throw new Error(`GitHub scheduling failed for ${String(totals.failedOrganizations)} organization(s).`);
      }
      return totals;
    }
    if (job.name === GITHUB_INSTALLATION_REFRESH_JOB) {
      const totals = await workers.scheduler.refreshInstallations(
        this.env.GITHUB_INSTALLATION_SYNC_INTERVAL_MS,
        new Date(),
      );
      if (totals.failedOrganizations > 0) {
        throw new Error(
          `GitHub installation refresh failed for ${String(totals.failedOrganizations)} organization(s).`,
        );
      }
      return { installations: totals.queued };
    }
    const result = await handleGithubJob(job.name, job.data, workers);
    if (result.kind === 'slice') {
      const delay = nextGithubSliceDelay(result.outcome);
      if (delay !== null && token !== undefined) {
        // Same job, next slice: no new queue entry, and attempts are not consumed.
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    }
    return result;
  }
}
