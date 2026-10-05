import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Per-user rate limits (SECURITY §5) with deliberately small budgets: the general per-user bucket,
 * the stricter sensitive bucket, and isolation between principals sharing one IP address.
 */
const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  hr: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  technicalManager: 'seed-demo-emp-00006',
} as const;

const USER_LIMIT = 6;
const SENSITIVE_LIMIT = 2;
const JIRA_LIMIT = 2;
const AUTH_LIMIT = 3;

let stack: ApiStack;
let orgA: string;

const get = (path: string, session: TestSession): Promise<Response> =>
  fetch(`${stack.baseUrl}/api/v1${path}`, { headers: { cookie: session.cookie } });

beforeAll(async () => {
  stack = await startApiStack({
    issuer: 'http://127.0.0.1:9/realms/company-ops',
    overrides: {
      RATE_LIMIT_DEFAULT_PER_MINUTE: '1000',
      RATE_LIMIT_USER_PER_MINUTE: String(USER_LIMIT),
      RATE_LIMIT_SENSITIVE_PER_MINUTE: String(SENSITIVE_LIMIT),
      RATE_LIMIT_JIRA_PER_MINUTE: String(JIRA_LIMIT),
      RATE_LIMIT_AUTH_PER_MINUTE: String(AUTH_LIMIT),
      // As behind the production reverse proxy: the client IP comes from one trusted hop.
      TRUST_PROXY_HOPS: '1',
    },
  });
  orgA = await seed(stack);
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('per-user rate limits', () => {
  it('returns 429 RATE_LIMITED with Retry-After once a user exhausts the budget; other users are unaffected', async () => {
    const hr = await createSession(stack, SUBJECT.hr, orgA);
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < USER_LIMIT + 2; i += 1) {
      const response = await get('/organization', hr);
      statuses.push(response.status);
      if (response.status === 429) {
        limited = response;
      }
    }
    expect(statuses.slice(0, USER_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(errorEnvelopeSchema.parse(await limited?.json()).error.code).toBe('RATE_LIMITED');

    // Same IP, different principal: separate bucket.
    const gm = await createSession(stack, SUBJECT.gm, orgA);
    expect((await get('/organization', gm)).status).toBe(200);
    // A second session of the throttled user shares that user's bucket.
    const hrAgain = await createSession(stack, SUBJECT.hr, orgA);
    expect((await get('/organization', hrAgain)).status).toBe(429);
  });

  it('applies the stricter sensitive bucket to sensitive operations only', async () => {
    const admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
    const statuses: number[] = [];
    for (let i = 0; i < SENSITIVE_LIMIT + 1; i += 1) {
      const response = await fetch(`${stack.baseUrl}/api/v1/organization`, {
        method: 'PATCH',
        headers: {
          cookie: admin.cookie,
          origin: PUBLIC_URL,
          'x-csrf-token': admin.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: `Demo ${String(i)}` }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    // Non-sensitive reads still pass until the general budget is used.
    expect((await get('/organization', admin)).status).toBe(200);
  });

  it('limits requests that call Jira live in their own bucket, so one user cannot drain the shared Jira quota', async () => {
    const manager = await createSession(stack, SUBJECT.technicalManager, orgA, { mfa: true });
    const statuses: number[] = [];
    for (let i = 0; i < JIRA_LIMIT + 1; i += 1) {
      statuses.push((await get('/integrations/jira/projects?q=ops', manager)).status);
    }
    expect(statuses.slice(0, JIRA_LIMIT).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Cache-backed reads are not in the Jira bucket.
    expect((await get('/integrations/jira', manager)).status).toBe(200);
  });

  it('keeps per-user counters in Redis under hashed keys, never raw user ids', async () => {
    const user = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: SUBJECT.employee } });
    const employee = await createSession(stack, SUBJECT.employee, orgA);
    expect((await get('/organization', employee)).status).toBe(200);
    const { Redis } = await import('ioredis');
    const redis = new Redis(stack.env.REDIS_URL);
    try {
      const keys = await redis.keys('ops:rl:user:*');
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((key) => key.includes(user.id))).toBe(false);
      expect(keys.every((key) => /^ops:rl:user:[0-9a-f]{64}$/.test(key))).toBe(true);
    } finally {
      redis.disconnect();
    }
  });

  it('limits unauthenticated traffic per client IP; one client exhausting the auth bucket does not block another', async () => {
    const login = (clientIp: string): Promise<Response> =>
      fetch(`${stack.baseUrl}/api/v1/auth/login`, { redirect: 'manual', headers: { 'x-forwarded-for': clientIp } });
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT + 1; i += 1) {
      statuses.push((await login('203.0.113.10')).status);
    }
    expect(statuses.slice(0, AUTH_LIMIT).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await login('203.0.113.20')).status).not.toBe(429);
    const limited = await login('203.0.113.10');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('every API key lives in an application namespace, apart from BullMQ, and embeds no raw identifier', async () => {
    const user = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: SUBJECT.gm } });
    const gm = await createSession(stack, SUBJECT.gm, orgA);
    expect((await get('/organization', gm)).status).toBe(200);
    const sessionId = decodeURIComponent(gm.cookie.split('=')[1] ?? '');
    const { Redis } = await import('ioredis');
    const redis = new Redis(stack.env.REDIS_URL);
    try {
      const keys = await redis.keys('*');
      expect(keys.length).toBeGreaterThan(0);
      const namespaces =
        /^ops:(sess|sess-idp|oidc-tx|oidc-logout-jti|rl:(default|auth|webhook|user|sensitive|upload|jira)):/;
      expect(keys.filter((key) => !namespaces.test(key))).toEqual([]);
      // BullMQ uses its own `bull:` prefix, so queue keys can never collide with session or limiter keys.
      expect(keys.some((key) => key.startsWith('bull:'))).toBe(false);
      for (const secret of [user.id, SUBJECT.gm, orgA, sessionId]) {
        expect(keys.some((key) => key.includes(secret))).toBe(false);
      }
    } finally {
      redis.disconnect();
    }
  });
});
