import { Module } from '@nestjs/common';
import type { DynamicModule, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module.js';
import { AUTH_RATE_LIMIT, WEBHOOK_RATE_LIMIT } from './auth/decorators.js';
import { CsrfGuard } from './auth/guards/csrf.guard.js';
import { PermissionGuard } from './auth/guards/permission.guard.js';
import { SessionGuard } from './auth/guards/session.guard.js';
import type { ApiEnv } from './config/api-env.js';
import { FeaturesModule } from './features/features.module.js';
import { ErrorEnvelopeFilter } from './http/errors/error-envelope.filter.js';
import { HealthModule } from './http/health/health.module.js';
import { IpThrottlerGuard } from './http/rate-limit/ip-throttler.guard.js';
import { PRINCIPAL_RATE_LIMITS, PrincipalRateLimitGuard } from './http/rate-limit/principal-rate-limit.guard.js';
import type { PrincipalRateLimits } from './http/rate-limit/principal-rate-limit.guard.js';
import { RedisThrottlerStorage } from './http/rate-limit/redis-throttler-storage.js';
import { InfrastructureModule, REDIS } from './infrastructure/infrastructure.module.js';
import { createLoggerParams } from './infrastructure/logging.js';
import { TenancyModule } from './tenancy/tenancy.module.js';

const MINUTE_MS = 60_000;

const hasMetadata = (key: string, context: ExecutionContext): boolean =>
  Reflect.getMetadata(key, context.getHandler()) === true || Reflect.getMetadata(key, context.getClass()) === true;
const isAuthRateLimited = (context: ExecutionContext): boolean => hasMetadata(AUTH_RATE_LIMIT, context);
const isWebhook = (context: ExecutionContext): boolean => hasMetadata(WEBHOOK_RATE_LIMIT, context);

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    const principalLimits: PrincipalRateLimits = {
      windowMs: MINUTE_MS,
      user: env.RATE_LIMIT_USER_PER_MINUTE,
      sensitive: env.RATE_LIMIT_SENSITIVE_PER_MINUTE,
      upload: env.RATE_LIMIT_UPLOAD_PER_MINUTE,
      jira: env.RATE_LIMIT_JIRA_PER_MINUTE,
      github: env.RATE_LIMIT_GITHUB_PER_MINUTE,
      attendance: env.RATE_LIMIT_ATTENDANCE_PER_MINUTE,
      search: env.RATE_LIMIT_SEARCH_PER_MINUTE,
    };
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(createLoggerParams(env)),
        // AsyncLocalStorage per request; holds the tenant context set by SessionGuard.
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        InfrastructureModule.register(env),
        // Per client IP, before authentication (SECURITY §5).
        ThrottlerModule.forRootAsync({
          inject: [REDIS],
          useFactory: (redis: Redis) => ({
            storage: new RedisThrottlerStorage(redis),
            throttlers: [
              {
                name: 'default',
                ttl: MINUTE_MS,
                limit: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
                skipIf: isWebhook,
              },
              {
                name: 'auth',
                ttl: MINUTE_MS,
                limit: env.RATE_LIMIT_AUTH_PER_MINUTE,
                skipIf: (context) => !isAuthRateLimited(context),
              },
              {
                name: 'webhook',
                ttl: MINUTE_MS,
                limit: env.RATE_LIMIT_WEBHOOK_PER_MINUTE,
                skipIf: (context) => !isWebhook(context),
              },
            ],
          }),
        }),
        TenancyModule,
        AuthModule.register(env),
        HealthModule,
        FeaturesModule.register(env),
      ],
      providers: [
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
        { provide: PRINCIPAL_RATE_LIMITS, useValue: principalLimits },
        PrincipalRateLimitGuard,
        // Order matters: IP rate limit, authenticate (sets tenant context), per-user rate limit,
        // CSRF, then authorize.
        { provide: APP_GUARD, useClass: IpThrottlerGuard },
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_GUARD, useExisting: PrincipalRateLimitGuard },
        { provide: APP_GUARD, useExisting: CsrfGuard },
        { provide: APP_GUARD, useExisting: PermissionGuard },
      ],
    };
  }
}
