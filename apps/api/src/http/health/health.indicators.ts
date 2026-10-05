import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { Redis } from 'ioredis';

import { pingDatabase, PrismaClient } from '@company-ops/core';
import { withTimeout } from '@company-ops/shared';

import { REDIS } from '../../infrastructure/infrastructure.module.js';

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await withTimeout(pingDatabase(this.prisma), CHECK_TIMEOUT_MS, 'database ping');
      return indicator.up();
    } catch (error) {
      this.logger.warn({ err: error }, 'Database readiness check failed');
      return indicator.down({ message: 'unreachable' });
    }
  }
}

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS, 'redis ping');
      return indicator.up();
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis readiness check failed');
      return indicator.down({ message: 'unreachable' });
    }
  }
}
