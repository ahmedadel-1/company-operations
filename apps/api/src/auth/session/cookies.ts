import { SESSION_COOKIE } from '@company-ops/shared';

import type { CookieOptions, HttpRequest, HttpResponse } from '../../http/http-types.js';

/**
 * `__Host-` prefix: the browser only accepts the cookie with Secure, Path=/ and no Domain, so it is
 * bound to the exact origin (SECURITY §3.3). Browsers treat http://localhost as a secure context.
 */
export { SESSION_COOKIE };
/** Opaque handle of the pending OIDC authorization request (the request itself lives in Redis). */
export const OIDC_TX_COOKIE = '__Host-ops_oidc';

const baseOptions: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };

/** Reads one cookie from the raw header. Malformed or duplicated values yield undefined. */
export function readCookie(request: Pick<HttpRequest, 'headers'>, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  let found: string | undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = part.slice(index + 1).trim();
  }
  return found !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(found) ? found : undefined;
}

export function setSessionCookie(response: HttpResponse, sessionId: string, maxAgeMs: number): void {
  response.cookie(SESSION_COOKIE, sessionId, { ...baseOptions, maxAge: maxAgeMs });
}

export function clearSessionCookie(response: HttpResponse): void {
  response.clearCookie(SESSION_COOKIE, baseOptions);
}

export function setOidcTransactionCookie(response: HttpResponse, transactionId: string, maxAgeMs: number): void {
  response.cookie(OIDC_TX_COOKIE, transactionId, { ...baseOptions, maxAge: maxAgeMs });
}

export function clearOidcTransactionCookie(response: HttpResponse): void {
  response.clearCookie(OIDC_TX_COOKIE, baseOptions);
}
