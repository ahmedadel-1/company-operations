import type { IncomingHttpHeaders } from 'node:http';

import type { TenantContext } from '@company-ops/core';

import type { SessionRecord } from '../auth/session/session.types.js';

/**
 * The parts of the Express request/response the API uses (Express adds them at runtime). Typed
 * structurally because the toolchain has no Express type package.
 */
export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
}

export interface HttpRequest {
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly originalUrl: string;
  readonly ip?: string | undefined;
  readonly id?: unknown;
  /** Set by `SessionGuard` for authenticated requests. */
  auth?: AuthenticatedRequestState | undefined;
}

export interface AuthenticatedRequestState {
  readonly sessionId: string;
  readonly session: SessionRecord;
  readonly tenant: TenantContext;
}

export interface HttpResponse {
  cookie(name: string, value: string, options: CookieOptions): unknown;
  clearCookie(name: string, options: CookieOptions): unknown;
  redirect(status: number, url: string): void;
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
}
