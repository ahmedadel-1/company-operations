import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@company-ops/shared';

import { storagePublicOrigin } from './lib/storage-origin';

/**
 * Runs before every route (ARCHITECTURE §6):
 * - `/api/*` is forwarded to the API at request time (`API_INTERNAL_URL`), so the browser only ever
 *   talks to the web origin and the HttpOnly session cookie stays first-party. Reading the target at
 *   runtime keeps the built artifact environment-independent.
 * - Pages without a session cookie go straight to sign-in; the API decides whether a present cookie
 *   is still valid (the UI then shows "session expired").
 * - Every page gets a per-request nonce-based Content-Security-Policy (SECURITY §8).
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search, searchParams } = request.nextUrl;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const target = new URL(`${pathname}${search}`, apiInternalUrl());
    // Client-supplied forwarding headers would be passed through verbatim and trusted by the API
    // (TRUST_PROXY_HOPS), letting a caller choose its rate-limit and audit IP. Without them, the
    // web server reports the address of its own peer.
    const headers = new Headers(request.headers);
    for (const name of FORWARDING_HEADERS) {
      headers.delete(name);
    }
    return NextResponse.rewrite(target, { request: { headers } });
  }

  const authError = searchParams.get('authError');
  if (authError !== null && pathname !== '/sign-in') {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('authError', authError);
    return NextResponse.redirect(signIn);
  }

  if (pathname !== '/sign-in' && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL('/api/v1/auth/login', request.url);
    const returnTo = `${pathname}${search}`;
    if (returnTo !== '/' && isSafeReturnTo(returnTo)) {
      login.searchParams.set('returnTo', returnTo);
    }
    return NextResponse.redirect(login);
  }

  return withContentSecurityPolicy(request);
}

const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
] as const;

function apiInternalUrl(): string {
  return (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** Mirrors the API's `returnToPathSchema`; anything else signs in to the home page. */
function isSafeReturnTo(value: string): boolean {
  return value.length <= 512 && /^\/(?![/\\])[^\\\s\p{Cc}]*$/u.test(value);
}

function withContentSecurityPolicy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === 'development';
  const storage = storagePublicOrigin(process.env.STORAGE_PUBLIC_ORIGIN);
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Radix positions popovers with inline style attributes, which nonces cannot cover.
    "style-src 'self' 'unsafe-inline'",
    // Object storage: direct uploads (connect) and pre-signed avatar images (img).
    `img-src 'self' blob: data:${storage === null ? '' : ` ${storage}`}`,
    "font-src 'self'",
    `connect-src 'self'${storage === null ? '' : ` ${storage}`}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' && request.nextUrl.protocol === 'https:'
      ? ['upgrade-insecure-requests']
      : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|healthz$).*)'],
};
