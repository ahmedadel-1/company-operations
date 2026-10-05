import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorEnvelopeSchema,
  executiveDashboardResponseSchema,
  meDashboardResponseSchema,
  needsAttentionResponseSchema,
  notificationPreferencesResponseSchema,
  projectsDashboardResponseSchema,
  searchResponseSchema,
  setupChecklistResponseSchema,
  supportDashboardResponseSchema,
  teamDashboardResponseSchema,
  trendResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 8 over real HTTP (PostgreSQL, Redis): every dashboard, Needs Attention, trend, search,
 * setup-checklist and preference route answers with the shared Zod contract behind OpenAPI; refuses
 * anonymous callers (401) and callers without the permission (403); validates queries strictly; the
 * search route has its own per-user rate limit; preference changes need the CSRF token.
 */
const SEARCH_LIMIT = 4;

let stack: ApiStack;
let orgA: string;

function call(
  path: string,
  session: TestSession | null,
  init: { method?: string; body?: unknown; csrf?: boolean } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers(session === null ? {} : { cookie: session.cookie });
  if (method !== 'GET') {
    headers.set('origin', PUBLIC_URL);
    if (session !== null && init.csrf !== false) headers.set('x-csrf-token', session.csrfToken);
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${stack.baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function ok<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(200);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack/i);
  return envelope.error.code;
}

async function sessionFor(employeeNumber: string, organizationId = orgA): Promise<TestSession> {
  const profile = await stack.prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId, employeeNumber },
    select: { member: { select: { user: { select: { idpSubject: true } } } } },
  });
  const subject = profile.member.user?.idpSubject;
  if (subject === undefined) throw new Error(`${employeeNumber} has no linked user`);
  return createSession(stack, subject, organizationId, { mfa: true });
}

beforeAll(async () => {
  stack = await startApiStack({
    issuer: 'http://127.0.0.1:9/realms/company-ops',
    overrides: { RATE_LIMIT_SEARCH_PER_MINUTE: String(SEARCH_LIMIT) },
  });
  orgA = await seed(stack);
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('dashboard routes', () => {
  it('answer the general manager with the shared contracts', async () => {
    const gm = await sessionFor('EMP-00002');
    const me = await ok(await call('/dashboard/me', gm), meDashboardResponseSchema);
    expect(me.data.approvals).not.toBeNull();
    const team = await ok(await call('/dashboard/team', gm), teamDashboardResponseSchema);
    expect(team.data.attendance.employees.link?.path).toBe('/attendance/team');
    const support = await ok(await call('/dashboard/support', gm), supportDashboardResponseSchema);
    expect(support.data.support.open.value).toBe(2);
    // A second read is served from Redis and is identical.
    expect(await ok(await call('/dashboard/support', gm), supportDashboardResponseSchema)).toEqual(support);
    const projects = await ok(await call('/dashboard/projects', gm), projectsDashboardResponseSchema);
    expect(projects.data.projects.active.value).toBe(3);
    const executive = await ok(await call('/dashboard/executive', gm), executiveDashboardResponseSchema);
    expect(executive.data.projects?.active.value).toBe(3);
    await ok(await call('/dashboard/needs-attention', gm), needsAttentionResponseSchema);
    const trend = await ok(await call('/dashboard/trends?metric=support_flow&range=7d', gm), trendResponseSchema);
    expect(trend.data.dates).toHaveLength(7);
    const defaultRange = await ok(await call('/dashboard/trends?metric=attendance_presence', gm), trendResponseSchema);
    expect(defaultRange.data.range).toBe('30d');
  });

  it('refuse anonymous callers and callers without the permission', async () => {
    const employee = await sessionFor('EMP-00004');
    const routes = [
      '/dashboard/me',
      '/dashboard/team',
      '/dashboard/support',
      '/dashboard/projects',
      '/dashboard/executive',
      '/dashboard/needs-attention',
      '/dashboard/trends?metric=support_flow',
      '/search?q=traffic',
      '/organization/setup-checklist',
      '/notifications/preferences',
    ];
    for (const route of routes) {
      expect(await failure(await call(route, null), 401)).toBe('UNAUTHENTICATED');
    }
    for (const route of [
      '/dashboard/team',
      '/dashboard/support',
      '/dashboard/projects',
      '/dashboard/executive',
      '/dashboard/trends?metric=support_flow',
      '/dashboard/trends?metric=attendance_presence',
      '/organization/setup-checklist',
    ]) {
      expect(await failure(await call(route, employee), 403)).toBe('FORBIDDEN');
    }
    await ok(await call('/dashboard/me', employee), meDashboardResponseSchema);
    await ok(await call('/dashboard/needs-attention', employee), needsAttentionResponseSchema);
  });

  it('validate trend queries strictly', async () => {
    const gm = await sessionFor('EMP-00002');
    for (const query of ['', '?metric=revenue', '?metric=support_flow&range=1y', '?metric=support_flow&extra=1']) {
      expect(await failure(await call(`/dashboard/trends${query}`, gm), 400)).toBe('VALIDATION_FAILED');
    }
  });
});

describe('search route', () => {
  it('returns only what the caller may open and validates its query', async () => {
    const gm = await sessionFor('EMP-00002');
    const field = await sessionFor('EMP-00024');
    const all = await ok(await call('/search?q=Retail&types=projects', gm), searchResponseSchema);
    expect(all.data.groups[0]?.items.map((item) => item.title)).toEqual(['Retail POS Rollout']);
    const hidden = await ok(await call('/search?q=Retail&types=projects', field), searchResponseSchema);
    expect(hidden.data.groups[0]?.items).toEqual([]);
    expect(await failure(await call('/search?q=a', gm), 400)).toBe('VALIDATION_FAILED');
    expect(await failure(await call('/search?q=traffic&cursor=abc', gm), 400)).toBe('VALIDATION_FAILED');
    expect(await failure(await call('/search?q=traffic&types=github', gm), 400)).toBe('VALIDATION_FAILED');
    // Refused queries count against the per-user budget too; continue as another user.
    const hr = await sessionFor('EMP-00003');
    expect(await failure(await call('/search?q=traffic&limit=11', hr), 400)).toBe('VALIDATION_FAILED');
    expect(await failure(await call('/search?q=traffic&types=projects&cursor=bm90LWEtY3Vyc29y', hr), 400)).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('has its own per-user rate limit; other users are unaffected', async () => {
    const user = await sessionFor('EMP-00010');
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let attempt = 0; attempt <= SEARCH_LIMIT; attempt += 1) {
      const response = await call('/search?q=traffic', user);
      statuses.push(response.status);
      if (response.status === 429) limited = response;
      else await response.body?.cancel();
    }
    expect(statuses).toEqual([...Array.from({ length: SEARCH_LIMIT }, () => 200), 429]);
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(errorEnvelopeSchema.parse(await limited?.json()).error.code).toBe('RATE_LIMITED');
    // Other routes keep the general budget.
    await ok(await call('/dashboard/me', user), meDashboardResponseSchema);
    const other = await sessionFor('EMP-00011');
    await ok(await call('/search?q=traffic', other), searchResponseSchema);
  });
});

describe('setup checklist route', () => {
  it('is available to organization administrators', async () => {
    const admin = await sessionFor('EMP-00001');
    const checklist = await ok(await call('/organization/setup-checklist', admin), setupChecklistResponseSchema);
    expect(checklist.data.items.map((item) => item.key)).toContain('departments');
    const gm = await sessionFor('EMP-00002');
    expect(await failure(await call('/organization/setup-checklist', gm), 403)).toBe('FORBIDDEN');
  });
});

describe('notification preference routes', () => {
  it('read and change only the caller’s preferences; locked items and missing CSRF are refused', async () => {
    const owner = await sessionFor('EMP-00009');
    const before = await ok(await call('/notifications/preferences', owner), notificationPreferencesResponseSchema);
    expect(before.data.items.every((item) => item.inApp && item.email)).toBe(true);
    const change = { items: [{ category: 'PROJECTS', channel: 'EMAIL', enabled: false }] };
    expect(
      await failure(await call('/notifications/preferences', owner, { method: 'PUT', body: change, csrf: false }), 403),
    ).toBe('CSRF_INVALID');
    const after = await ok(
      await call('/notifications/preferences', owner, { method: 'PUT', body: change }),
      notificationPreferencesResponseSchema,
    );
    expect(after.data.items.find((item) => item.category === 'PROJECTS')).toMatchObject({ email: false, inApp: true });
    expect(
      await failure(
        await call('/notifications/preferences', owner, {
          method: 'PUT',
          body: { items: [{ category: 'ACCESS', channel: 'IN_APP', enabled: false }] },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    for (const body of [
      { items: [] },
      { items: [{ category: 'PROJECTS', channel: 'SMS', enabled: false }] },
      { items: [{ category: 'PROJECTS', channel: 'EMAIL', enabled: false }], memberId: 'someone-else' },
    ]) {
      expect(await failure(await call('/notifications/preferences', owner, { method: 'PUT', body }), 400)).toBe(
        'VALIDATION_FAILED',
      );
    }
    const other = await sessionFor('EMP-00010');
    const theirs = await ok(await call('/notifications/preferences', other), notificationPreferencesResponseSchema);
    expect(theirs.data.items.find((item) => item.category === 'PROJECTS')).toMatchObject({ email: true });
  });
});
