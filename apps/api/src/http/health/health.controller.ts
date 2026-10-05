import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import type { HealthCheckResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { ERROR_CODES } from '@company-ops/shared';

import { Public } from '../../auth/decorators.js';
import { ApiMetrics } from '../../infrastructure/api-metrics.js';

import { DatabaseHealthIndicator, RedisHealthIndicator } from './health.indicators.js';

/** Unauthenticated probes; not rate limited so orchestrator checks never depend on Redis counters. */
@Controller({ path: 'health', version: '1' })
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(DatabaseHealthIndicator) private readonly database: DatabaseHealthIndicator,
    @Inject(RedisHealthIndicator) private readonly redis: RedisHealthIndicator,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {}

  /** Liveness: the process is running and serving HTTP. Never touches dependencies. */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Readiness: PostgreSQL and Redis answer. Object storage joins this check with the StoragePort
   * (ROADMAP P1-14).
   */
  @Get('ready')
  @HealthCheck()
  async ready(): Promise<HealthCheckResult> {
    if (this.metrics.draining) {
      throw new ServiceUnavailableException({
        code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        message: 'The instance is shutting down.',
      });
    }
    try {
      return await this.health.check([() => this.database.check('database'), () => this.redis.check('redis')]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException({
          code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          message: 'One or more dependencies are unavailable.',
          details: error.getResponse(),
        });
      }
      throw error;
    }
  }
}
