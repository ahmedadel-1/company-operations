import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CSRF_HEADER } from '@company-ops/shared';

import { csrfInvalid } from '../../http/errors/http-errors.js';
import type { HttpRequest } from '../../http/http-types.js';
import { SKIP_CSRF } from '../decorators.js';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const ALLOWED_ORIGINS = Symbol('ALLOWED_ORIGINS');

function equalTokens(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests (SECURITY §3.4): synchronizer
 * token bound to the session (`X-CSRF-Token`) plus an `Origin` allow-list check. A missing Origin
 * is rejected. Safe methods are not checked and must not change state.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ALLOWED_ORIGINS) private readonly allowedOrigins: ReadonlySet<string>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF, targets) === true) {
      return true;
    }
    const origin = request.headers.origin;
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      throw csrfInvalid();
    }
    // Public state-changing endpoints without a session must opt out explicitly with @SkipCsrf.
    const session = request.auth?.session;
    if (session === undefined) {
      throw csrfInvalid();
    }
    const header = request.headers[CSRF_HEADER];
    const token = Array.isArray(header) ? undefined : header;
    if (token === undefined || !equalTokens(token, session.csrfToken)) {
      throw csrfInvalid();
    }
    return true;
  }
}
