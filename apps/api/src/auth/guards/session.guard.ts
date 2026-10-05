import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { HttpRequest, HttpResponse } from '../../http/http-types.js';
import { sessionExpired, unauthenticated } from '../../http/errors/http-errors.js';
import { ClsTenantContext } from '../../tenancy/cls-tenant-context.js';
import { AuthService } from '../auth.service.js';
import { IS_PUBLIC } from '../decorators.js';
import { readCookie, SESSION_COOKIE, setSessionCookie, clearSessionCookie } from '../session/cookies.js';
import { SessionStore } from '../session/session.store.js';

/**
 * Global authentication guard (deny by default). Loads the server-side session from the opaque
 * cookie, revalidates membership/grants, and establishes the request tenant context from the
 * session only.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ClsTenantContext) private readonly tenant: ClsTenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [context.getHandler(), context.getClass()]) ===
      true
    ) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();

    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId === undefined) {
      throw unauthenticated();
    }
    const record = await this.sessions.load(sessionId);
    if (record === null) {
      clearSessionCookie(response);
      throw sessionExpired();
    }
    const check = await this.auth.revalidate(sessionId, record);
    if (check.kind === 'invalid') {
      clearSessionCookie(response);
      throw sessionExpired();
    }
    let activeId = sessionId;
    if (check.kind === 'rotated') {
      activeId = check.sessionId;
      setSessionCookie(response, activeId, this.sessions.cookieMaxAgeMs(check.record));
    }
    const tenant = {
      organizationId: check.record.organizationId,
      memberId: check.record.memberId,
      userId: check.record.userId,
    };
    request.auth = { sessionId: activeId, session: check.record, tenant };
    this.tenant.set(tenant);
    return true;
  }
}
