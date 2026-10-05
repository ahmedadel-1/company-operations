import { createParamDecorator, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import type { PermissionKey } from '@company-ops/shared';

import type { AuthenticatedRequestState, HttpRequest } from '../http/http-types.js';

export const IS_PUBLIC = 'ops:isPublic';
export const SKIP_CSRF = 'ops:skipCsrf';
export const REQUIRED_PERMISSION = 'ops:requiredPermission';
export const AUTH_RATE_LIMIT = 'ops:authRateLimit';

/** No session required (deny-by-default otherwise). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Only for endpoints authenticated by other means (back-channel logout, future webhooks). */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF, true);

/** Route-level capability check (SECURITY §2.2); resource scope is checked by the service. */
export const RequirePermission = (permission: PermissionKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Applies the stricter authentication rate limit (`RATE_LIMIT_AUTH_PER_MINUTE`). */
export const AuthRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(AUTH_RATE_LIMIT, true);

export const WEBHOOK_RATE_LIMIT = 'ops:webhookRateLimit';

/**
 * Server-to-server callbacks (OIDC back-channel logout; later Jira/GitHub webhooks) get their own
 * per-source bucket (`RATE_LIMIT_WEBHOOK_PER_MINUTE`) instead of the browser `default`/`auth` buckets,
 * so a burst of identity-provider logouts is never throttled by limits meant for people.
 */
export const WebhookRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(WEBHOOK_RATE_LIMIT, true);

export type PrincipalRateLimitBucket = 'sensitive' | 'upload' | 'jira' | 'github' | 'attendance' | 'search';
export const PRINCIPAL_RATE_LIMIT = 'ops:principalRateLimit';

/**
 * Adds a per-user bucket on top of the general per-user limit: `sensitive` for role, membership,
 * invitation and settings changes; `upload` for attachment upload intents; `jira` and `github` for
 * requests that call Jira or GitHub live (or queue work against them); `attendance` for check-in/out.
 */
export const PrincipalRateLimit = (bucket: PrincipalRateLimitBucket): MethodDecorator & ClassDecorator =>
  SetMetadata(PRINCIPAL_RATE_LIMIT, bucket);

/** The authenticated request state set by `SessionGuard`. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedRequestState => {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (request.auth === undefined) {
      throw new UnauthorizedException();
    }
    return request.auth;
  },
);
