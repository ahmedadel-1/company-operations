import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import {
  AsyncLocalTenantContext,
  AttachmentService,
  createGithubRuntime,
  createJiraRuntime,
  createPrismaClient,
  createTenantScopedClient,
  DailyReportMissingCheck,
  dashboardInvalidator,
  EnvelopeCipher,
  loadAppPrivateKey,
  NO_SCAN,
  NotificationDeliveryService,
  notificationEntityAccess,
  NotificationWriter,
  PrismaClient,
  ProjectActivityWriter,
  QUEUE_NAMES,
  redisDashboardCacheStore,
  redisKeyValueStore,
  S3Storage,
} from '@company-ops/core';
import type { EmailChannel, GithubRuntime, JiraRuntime, QueueName, TenantScopedClient } from '@company-ops/core';
import { GITHUB_WEB_BASE_URL } from '@company-ops/config';
import { pinoSecurityOptions, redisConnectionOptions } from '@company-ops/shared';

import { WORKER_ENV } from './config/worker-env.js';
import type { WorkerEnv } from './config/worker-env.js';
import { createEmailChannel, messageIdHost, SmtpEmailChannel } from './email/smtp-email-channel.js';
import { OutboxRelay } from './outbox/outbox-relay.js';
import { bullErrorLogging } from './ops/bull-error-logging.js';
import { WorkerOpsService } from './ops/worker-ops.service.js';
import { OutboxRelayService } from './outbox/outbox-relay.service.js';
import { AttendanceProcessor } from './processors/attendance/attendance.processor.js';
import { CommercialProcessor } from './processors/commercial/commercial.processor.js';
import { GithubProcessor } from './processors/github/github.processor.js';
import { JiraProcessor } from './processors/jira/jira.processor.js';
import { MaintenanceProcessor } from './processors/maintenance/maintenance.processor.js';
import { NotificationsProcessor } from './processors/notifications/notifications.processor.js';
import { ProjectsProcessor } from './processors/projects/projects.processor.js';
import { ReportsProcessor } from './processors/reports/reports.processor.js';
import { RequestsProcessor } from './processors/requests/requests.processor.js';
import { SlaProcessor } from './processors/sla/sla.processor.js';
import { RedisRealtimePublisher } from './realtime/redis-realtime-publisher.js';
import {
  DASHBOARD_INVALIDATOR,
  EMAIL_CHANNEL,
  GITHUB_RUNTIME,
  JIRA_RUNTIME,
  REALTIME_PUBLISHER,
  REDIS,
  TENANT_DB,
} from './worker-tokens.js';

@Injectable()
class WorkerLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(S3Storage) private readonly storage: S3Storage,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.storage.destroy();
    if (this.email instanceof SmtpEmailChannel) {
      this.email.close();
    }
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
  }
}

/** Jira token use and refresh, sync and webhook upkeep; null when the deployment has no Jira app. */
function createWorkerJiraRuntime(env: WorkerEnv, db: TenantScopedClient, redis: Redis): JiraRuntime | null {
  if (
    env.JIRA_OAUTH_CLIENT_ID === undefined ||
    env.JIRA_OAUTH_CLIENT_SECRET === undefined ||
    env.APP_ENCRYPTION_KEY === undefined
  ) {
    return null;
  }
  return createJiraRuntime({
    settings: {
      clientId: env.JIRA_OAUTH_CLIENT_ID,
      clientSecret: env.JIRA_OAUTH_CLIENT_SECRET,
      authBaseUrl: env.JIRA_AUTH_BASE_URL,
      apiBaseUrl: env.JIRA_API_BASE_URL,
      publicUrl: env.APP_PUBLIC_URL,
    },
    fetch: (url, init) => fetch(url, init),
    kv: redisKeyValueStore(redis),
    db,
    cipher: EnvelopeCipher.fromBase64(
      env.APP_ENCRYPTION_KEY_ID,
      env.APP_ENCRYPTION_KEY,
      env.APP_ENCRYPTION_KEYS_PREVIOUS,
    ),
  });
}

/**
 * GitHub App installation tokens, sync and webhook processing; null when the deployment has no
 * GitHub App. The worker never needs the client secret, slug or webhook secret.
 */
function createWorkerGithubRuntime(env: WorkerEnv, redis: Redis): GithubRuntime | null {
  if (
    env.GITHUB_APP_ID === undefined ||
    env.GITHUB_APP_CLIENT_ID === undefined ||
    env.GITHUB_APP_PRIVATE_KEY === undefined ||
    env.APP_ENCRYPTION_KEY === undefined
  ) {
    return null;
  }
  return createGithubRuntime({
    settings: {
      appId: env.GITHUB_APP_ID,
      clientId: env.GITHUB_APP_CLIENT_ID,
      privateKey: loadAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY),
      clientSecret: null,
      slug: null,
      webhookSecret: null,
      apiBaseUrl: env.GITHUB_API_BASE_URL,
      webBaseUrl: GITHUB_WEB_BASE_URL,
      publicUrl: env.APP_PUBLIC_URL,
    },
    fetch: (url, init) => fetch(url, init),
    kv: redisKeyValueStore(redis),
    cipher: EnvelopeCipher.fromBase64(
      env.APP_ENCRYPTION_KEY_ID,
      env.APP_ENCRYPTION_KEY,
      env.APP_ENCRYPTION_KEYS_PREVIOUS,
    ),
  });
}

const PROCESSORS = [
  NotificationsProcessor,
  ProjectsProcessor,
  ReportsProcessor,
  MaintenanceProcessor,
  SlaProcessor,
  RequestsProcessor,
  AttendanceProcessor,
  JiraProcessor,
  GithubProcessor,
  CommercialProcessor,
] as const;

function createRedis(env: WorkerEnv): Redis {
  const logger = new Logger('Redis');
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 2_000, maxRetriesPerRequest: 1 });
  redis.on('error', (error: Error) => {
    logger.warn({ err: error }, 'Redis connection error');
  });
  return redis;
}

/**
 * Background runtime adapter (ARCHITECTURE §3): the outbox relay, the `notifications` (in-app,
 * email, real-time hints) and `projects` (timeline) consumers, scheduled `reports` checks, the `sla`
 * sweep, `maintenance` jobs, the `jira-sync` queue (Phase 4), the `attendance` sweep (Phase 7) and the
 * `commercial` monitor (Phase 10). Every job runs inside the tenant context of the organization it belongs to,
 * through the same tenant-guarded Prisma client the API uses.
 */
@Module({})
export class WorkerModule {
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: { level: env.LOG_LEVEL, ...pinoSecurityOptions() },
        }),
        BullModule.forRoot({ connection: redisConnectionOptions(env.REDIS_URL) }),
        BullModule.registerQueue(...QUEUE_NAMES.map((name) => ({ name }))),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: PrismaClient, useFactory: () => createPrismaClient(env.DATABASE_URL) },
        { provide: AsyncLocalTenantContext, useValue: new AsyncLocalTenantContext() },
        {
          provide: TENANT_DB,
          useFactory: (prisma: PrismaClient, tenant: AsyncLocalTenantContext) =>
            createTenantScopedClient(prisma, tenant),
          inject: [PrismaClient, AsyncLocalTenantContext],
        },
        {
          provide: NotificationWriter,
          useFactory: (db: TenantScopedClient, tenant: AsyncLocalTenantContext) => new NotificationWriter(db, tenant),
          inject: [TENANT_DB, AsyncLocalTenantContext],
        },
        { provide: REDIS, useFactory: () => createRedis(env) },
        {
          provide: REALTIME_PUBLISHER,
          useFactory: (redis: Redis) => new RedisRealtimePublisher(redis),
          inject: [REDIS],
        },
        {
          provide: DASHBOARD_INVALIDATOR,
          useFactory: (redis: Redis) => {
            const logger = new Logger('DashboardCache');
            return dashboardInvalidator(redisDashboardCacheStore(redis), (operation, error) => {
              logger.warn({ err: error, operation }, 'Dashboard cache invalidation failed');
            });
          },
          inject: [REDIS],
        },
        {
          provide: JIRA_RUNTIME,
          useFactory: (db: TenantScopedClient, redis: Redis) => createWorkerJiraRuntime(env, db, redis),
          inject: [TENANT_DB, REDIS],
        },
        {
          provide: GITHUB_RUNTIME,
          useFactory: (redis: Redis) => createWorkerGithubRuntime(env, redis),
          inject: [REDIS],
        },
        { provide: EMAIL_CHANNEL, useFactory: () => createEmailChannel(env) },
        {
          provide: NotificationDeliveryService,
          useFactory: (db: TenantScopedClient, tenant: AsyncLocalTenantContext, email: EmailChannel) =>
            new NotificationDeliveryService(
              db,
              tenant,
              email,
              env.APP_PUBLIC_URL,
              messageIdHost(env),
              notificationEntityAccess(db),
            ),
          inject: [TENANT_DB, AsyncLocalTenantContext, EMAIL_CHANNEL],
        },
        {
          provide: ProjectActivityWriter,
          useFactory: (db: TenantScopedClient, tenant: AsyncLocalTenantContext) =>
            new ProjectActivityWriter(db, tenant),
          inject: [TENANT_DB, AsyncLocalTenantContext],
        },
        {
          provide: DailyReportMissingCheck,
          useFactory: (db: TenantScopedClient, tenant: AsyncLocalTenantContext, writer: NotificationWriter) =>
            new DailyReportMissingCheck(db, tenant, writer),
          inject: [TENANT_DB, AsyncLocalTenantContext, NotificationWriter],
        },
        {
          provide: S3Storage,
          useFactory: () =>
            new S3Storage({
              endpoint: env.S3_ENDPOINT,
              publicEndpoint: env.S3_PUBLIC_ENDPOINT,
              region: env.S3_REGION,
              bucket: env.S3_BUCKET,
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
            }),
        },
        {
          // Maintenance only expires uploads; no owner policy is needed for that.
          provide: AttachmentService,
          useFactory: (db: TenantScopedClient, tenant: AsyncLocalTenantContext, storage: S3Storage) =>
            new AttachmentService(db, tenant, storage, [], NO_SCAN),
          inject: [TENANT_DB, AsyncLocalTenantContext, S3Storage],
        },
        {
          provide: OutboxRelay,
          useFactory: (prisma: PrismaClient, modules: ModuleRef) =>
            new OutboxRelay(prisma, (name: QueueName) => modules.get<Queue>(getQueueToken(name), { strict: false }), {
              batchSize: env.OUTBOX_BATCH_SIZE,
              leaseMs: env.OUTBOX_LEASE_MS,
              maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
              jobAttempts: env.JOB_MAX_ATTEMPTS,
            }),
          inject: [PrismaClient, ModuleRef],
        },
        OutboxRelayService,
        ...PROCESSORS,
        bullErrorLogging(PROCESSORS),
        WorkerOpsService,
        WorkerLifecycle,
      ],
    };
  }
}
