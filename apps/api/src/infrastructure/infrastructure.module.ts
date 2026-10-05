import { once } from 'node:events';

import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { createPrismaClient, PrismaClient } from '@company-ops/core';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';

import { ApiMetrics } from './api-metrics.js';

export const REDIS = Symbol('REDIS');

const REDIS_STARTUP_WAIT_MS = 5_000;

@Injectable()
class InfrastructureLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Gives the first requests a ready connection; never blocks boot on an unreachable Redis. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.redis.status === 'ready') {
      return;
    }
    await once(this.redis, 'ready', { signal: AbortSignal.timeout(REDIS_STARTUP_WAIT_MS) }).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Redis not ready at startup; requests needing it fail until it is');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
  }
}

function createRedis(env: ApiEnv): Redis {
  const logger = new Logger('Redis');
  // Request-path client: while Redis is unreachable, commands fail at once (503 DEPENDENCY_UNAVAILABLE)
  // instead of queueing behind reconnect attempts. Connecting starts here but boot does not await it.
  const redis = new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', (error: Error) => {
    logger.warn({ err: error }, 'Redis connection error');
  });
  return redis;
}

/** Process-wide clients for PostgreSQL and Redis. Business modules arrive in Phase 1B. */
@Module({})
export class InfrastructureModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: InfrastructureModule,
      global: true,
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: PrismaClient, useFactory: () => createPrismaClient(env.DATABASE_URL) },
        { provide: REDIS, useFactory: () => createRedis(env) },
        InfrastructureLifecycle,
        ApiMetrics,
      ],
      exports: [API_ENV, PrismaClient, REDIS, ApiMetrics],
    };
  }
}
