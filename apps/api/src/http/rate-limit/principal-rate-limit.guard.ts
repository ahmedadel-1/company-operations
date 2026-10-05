import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';

import { ERROR_CODES } from '@company-ops/shared';

import { PRINCIPAL_RATE_LIMIT } from '../../auth/decorators.js';
import type { PrincipalRateLimitBucket } from '../../auth/decorators.js';
import { REDIS } from '../../infrastructure/infrastructure.module.js';
import type { HttpRequest, HttpResponse } from '../http-types.js';
import { RedisThrottlerStorage } from './redis-throttler-storage.js';

export const PRINCIPAL_RATE_LIMITS = Symbol('PRINCIPAL_RATE_LIMITS');

/** Requests per window for each per-user bucket. */
export interface PrincipalRateLimits {
  readonly windowMs: number;
  readonly user: number;
  readonly sensitive: number;
  readonly upload: number;
  readonly jira: number;
  readonly github: number;
  readonly attendance: number;
  readonly search: number;
}

/**
 * Per-user limits for authenticated requests (SECURITY §5), applied after `SessionGuard`, so they
 * hold across IP addresses and sessions of the same user and one user cannot exhaust another's
 * budget. Keys use a hash of the user id (`ops:rl:user:<sha256>`), never a raw identifier.
 * Unauthenticated requests are limited per IP by the global throttler instead.
 */
@Injectable()
export class PrincipalRateLimitGuard implements CanActivate {
  private readonly storage: RedisThrottlerStorage;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRINCIPAL_RATE_LIMITS) private readonly limits: PrincipalRateLimits,
    @Inject(REDIS) redis: Redis,
  ) {
    this.storage = new RedisThrottlerStorage(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const auth = request.auth;
    if (auth === undefined) {
      return true;
    }
    const key = createHash('sha256').update(auth.tenant.userId).digest('hex');
    const extra = this.reflector.getAllAndOverride<PrincipalRateLimitBucket | undefined>(PRINCIPAL_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    const buckets: { name: string; limit: number }[] = [{ name: 'user', limit: this.limits.user }];
    if (extra !== undefined) {
      buckets.push({ name: extra, limit: this.limits[extra] });
    }
    for (const bucket of buckets) {
      const record = await this.storage.increment(key, this.limits.windowMs, bucket.limit, 0, bucket.name);
      if (record.isBlocked) {
        http.getResponse<HttpResponse>().setHeader('Retry-After', String(record.timeToBlockExpire));
        throw new HttpException(
          { code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}
