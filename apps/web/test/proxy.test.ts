import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '@company-ops/shared';

import { storagePublicOrigin } from '../src/lib/storage-origin';
import { proxy } from '../src/proxy';

const ORIGIN = 'http://localhost:3000';

function call(path: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`${ORIGIN}${path}`, { headers }));
}

/** Request headers the proxy forwards with a rewrite (Next encodes them as `x-middleware-request-*`). */
function forwardedRequestHeaders(response: Response): Map<string, string> {
  const names = (response.headers.get('x-middleware-override-headers') ?? '').split(',').filter((name) => name !== '');
  return new Map(names.map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? '']));
}

describe('/api forwarding', () => {
  it('rewrites to API_INTERNAL_URL and keeps the path and query', () => {
    const response = call('/api/v1/employees?limit=5', { cookie: `${SESSION_COOKIE}=abc` });
    expect(response.headers.get('x-middleware-rewrite')).toBe('http://localhost:4000/api/v1/employees?limit=5');
    expect(forwardedRequestHeaders(response).get('cookie')).toBe(`${SESSION_COOKIE}=abc`);
  });

  it('drops client-supplied forwarding headers so callers cannot choose their IP', () => {
    const response = call('/api/v1/auth/login', {
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '7.7.7.7',
      forwarded: 'for=8.8.8.8',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
    });
    const forwarded = forwardedRequestHeaders(response);
    for (const name of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-proto', 'x-forwarded-host']) {
      expect(forwarded.has(name)).toBe(false);
    }
  });
});

describe('pages', () => {
  it('sends visitors without a session to sign-in with a safe return path', () => {
    const response = call('/people?q=ana');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/api/v1/auth/login?returnTo=%2Fpeople%3Fq%3Dana`);
    expect(call('/').headers.get('location')).toBe(`${ORIGIN}/api/v1/auth/login`);
  });

  it('never forwards an unsafe return path', () => {
    const response = call('//evil.example/x');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/api/v1/auth/login`);
  });

  it('moves sign-in errors to the public sign-in page', () => {
    const response = call('/?authError=no_active_membership');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?authError=no_active_membership`);
    expect(call('/sign-in?authError=x').headers.get('location')).toBeNull();
  });

  it('serves pages with a per-request nonce Content-Security-Policy', () => {
    const first = call('/', { cookie: `${SESSION_COOKIE}=abc` });
    const second = call('/', { cookie: `${SESSION_COOKIE}=abc` });
    const policy = first.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    expect(second.headers.get('content-security-policy')).not.toBe(policy);
  });

  it('allows uploads to and images from the configured storage origin only', () => {
    const previous = process.env.STORAGE_PUBLIC_ORIGIN;
    try {
      delete process.env.STORAGE_PUBLIC_ORIGIN;
      const unset = call('/', { cookie: `${SESSION_COOKIE}=abc` }).headers.get('content-security-policy') ?? '';
      expect(unset).toContain("img-src 'self' blob: data:;");
      process.env.STORAGE_PUBLIC_ORIGIN = 'https://files.example.com/bucket/path?x=1';
      const policy = call('/', { cookie: `${SESSION_COOKIE}=abc` }).headers.get('content-security-policy') ?? '';
      expect(policy).toContain("connect-src 'self' https://files.example.com;");
      expect(policy).toContain("img-src 'self' blob: data: https://files.example.com;");
    } finally {
      if (previous === undefined) {
        delete process.env.STORAGE_PUBLIC_ORIGIN;
      } else {
        process.env.STORAGE_PUBLIC_ORIGIN = previous;
      }
    }
  });
});

describe('storagePublicOrigin', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['not a url', null],
    ["javascript:alert('x')", null],
    ['ftp://files.example.com', null],
    ["https://files.example.com; script-src 'unsafe-inline'", null],
    ['http://localhost:8333/', 'http://localhost:8333'],
  ])('%s -> %s', (value, expected) => {
    expect(storagePublicOrigin(value)).toBe(expected);
  });
});
