import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_EMPLOYEES, MemberStatus, provisionOrganization } from '@company-ops/core';
import {
  employeePageResponseSchema,
  employeeResponseSchema,
  errorEnvelopeSchema,
  grantRoleResponseSchema,
  meResponseSchema,
} from '@company-ops/validation';

import { SESSION_COOKIE } from '../src/auth/session/cookies.js';
import {
  ALLOWED_EXTRA_ORIGIN,
  createSession,
  PUBLIC_URL,
  seed,
  sessionIdFromResponse,
  startApiStack,
} from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * HTTP security suite against the real application (guards, CLS tenant context, tenant-scoped
 * Prisma client) with real PostgreSQL 18 and Redis 8. Sessions are created the way the OIDC
 * callback creates them; the OIDC exchange itself is covered by keycloak-oidc.int.test.ts.
 */
const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  hr: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  disabled: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f05',
} as const;

const AUTH_LIMIT = 5;
const WEBHOOK_LIMIT = 8;

let stack: ApiStack;
let orgA: string;
let orgB: string;
const memberIds: Record<string, string> = {};
const profileIds: Record<string, string> = {};
let orgBMemberId: string;
let orgBProfileId: string;
let orgBRoleId: string;
let orgARoleIds: Record<string, string>;

async function errorCode(response: Response): Promise<string> {
  return errorEnvelopeSchema.parse(await response.json()).error.code;
}

function request(
  path: string,
  session: TestSession | undefined,
  init: RequestInit & { csrf?: boolean; origin?: string | null } = {},
) {
  const headers = new Headers(init.headers);
  if (session !== undefined) {
    headers.set('cookie', session.cookie);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    if (init.origin !== null) {
      headers.set('origin', init.origin ?? PUBLIC_URL);
    }
    if (init.csrf !== false && session !== undefined) {
      headers.set('x-csrf-token', session.csrfToken);
    }
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
  }
  return fetch(`${stack.baseUrl}/api/v1${path}`, { ...init, headers, redirect: 'manual' });
}

const json = (value: unknown): string => JSON.stringify(value);

beforeAll(async () => {
  // Discovery is never reached in this suite: OIDC configuration is resolved lazily.
  stack = await startApiStack({
    issuer: 'http://127.0.0.1:9/realms/company-ops',
    overrides: { RATE_LIMIT_AUTH_PER_MINUTE: String(AUTH_LIMIT), RATE_LIMIT_WEBHOOK_PER_MINUTE: String(WEBHOOK_LIMIT) },
  });
  orgA = await seed(stack);
  for (const [name, subject] of Object.entries(SUBJECT)) {
    const member = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgA, user: { idpSubject: subject } },
    });
    memberIds[name] = member.id;
    const profile = await stack.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: orgA, memberId: member.id },
    });
    profileIds[name] = profile.id;
  }
  orgARoleIds = Object.fromEntries(
    (await stack.prisma.role.findMany({ where: { organizationId: orgA } })).map((r) => [r.key, r.id]),
  );

  const provisioned = await provisionOrganization(
    stack.prisma,
    { slug: 'org-b', name: 'Org B', timeZone: 'UTC', workWeek: [1, 2, 3, 4, 5] },
    { type: 'CLI' },
  );
  orgB = provisioned.organizationId;
  orgBRoleId = provisioned.roleIds.EMPLOYEE;
  const gm = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: SUBJECT.gm } });
  const gmInB = await stack.prisma.organizationMember.create({
    data: { organizationId: orgB, userId: gm.id, status: MemberStatus.ACTIVE },
  });
  await stack.prisma.memberRole.create({
    data: { organizationId: orgB, memberId: gmInB.id, roleId: provisioned.roleIds.HR_ADMIN },
  });
  orgBMemberId = gmInB.id;
  const profileB = await stack.prisma.employeeProfile.create({
    data: { organizationId: orgB, memberId: gmInB.id, employeeNumber: 'B-0001', fullName: 'Org B person' },
  });
  orgBProfileId = profileB.id;
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('authentication and session', () => {
  it('denies unauthenticated requests (no cookie, unknown cookie, attacker-chosen id)', async () => {
    const none = await request('/me', undefined);
    expect(none.status).toBe(401);
    expect(await errorCode(none)).toBe('UNAUTHENTICATED');

    const forged = await fetch(`${stack.baseUrl}/api/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=attacker-chosen-session-id-0000000000` },
    });
    expect(forged.status).toBe(401);
    expect(await errorCode(forged)).toBe('SESSION_EXPIRED');
  });

  it('GET /me returns the server-side context and never tokens', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const response = await request('/me', session);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const body = meResponseSchema.parse(JSON.parse(text));
    expect(body.data.activeOrganization.slug).toBe('demo');
    expect(body.data.permissions.some((p) => p.key === 'employee.manage')).toBe(true);
    expect(text).not.toMatch(/token/i);
  });

  it('denies a disabled membership and destroys the session', async () => {
    const session = await createSession(stack, SUBJECT.employee, orgA);
    expect((await request('/me', session)).status).toBe(200);
    await stack.prisma.organizationMember.update({
      where: { organizationId_id: { organizationId: orgA, id: memberIds.employee ?? '' } },
      data: { status: MemberStatus.DISABLED },
    });
    try {
      const denied = await request('/me', session);
      expect(denied.status).toBe(401);
      expect(await errorCode(denied)).toBe('SESSION_EXPIRED');
      expect(await stack.sessions.load(session.id)).toBeNull();
    } finally {
      await stack.prisma.organizationMember.update({
        where: { organizationId_id: { organizationId: orgA, id: memberIds.employee ?? '' } },
        data: { status: MemberStatus.ACTIVE },
      });
    }
  });

  it('a seeded DISABLED membership cannot obtain a session', async () => {
    await expect(createSession(stack, SUBJECT.disabled, orgA)).rejects.toThrow(/No active membership/);
  });

  it('sets the session cookie with __Host-, HttpOnly, Secure, SameSite=Lax and Path=/', async () => {
    const session = await createSession(stack, SUBJECT.gm, orgA);
    const response = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: orgA }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});

describe('organization context', () => {
  it('rejects switching to an organization without membership, unknown ids and forged bodies', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const foreign = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: orgB }),
    });
    expect(foreign.status).toBe(404);
    const unknown = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: '0190f0a0-0000-7000-8000-0000000000ff' }),
    });
    expect(unknown.status).toBe(404);
    const extra = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: orgA, memberId: memberIds.admin }),
    });
    expect(extra.status).toBe(400);
    expect(await errorCode(extra)).toBe('VALIDATION_FAILED');
    const me = meResponseSchema.parse(await (await request('/me', session)).json());
    expect(me.data.activeOrganization.id).toBe(orgA);
  });

  it('switching validates membership, rotates the session id and CSRF token, and is audited', async () => {
    const session = await createSession(stack, SUBJECT.gm, orgA);
    const response = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: orgB }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { organizationId: string; csrfToken: string } };
    expect(body.data.organizationId).toBe(orgB);
    expect(body.data.csrfToken).not.toBe(session.csrfToken);
    const newId = sessionIdFromResponse(response);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(session.id);

    // Session fixation: the pre-switch id is dead.
    expect((await request('/me', session)).status).toBe(401);
    const rotated: TestSession = {
      id: newId ?? '',
      cookie: `${SESSION_COOKIE}=${newId ?? ''}`,
      csrfToken: body.data.csrfToken,
    };
    const me = meResponseSchema.parse(await (await request('/me', rotated)).json());
    expect(me.data.activeOrganization.id).toBe(orgB);
    expect(me.data.memberships.map((m) => m.organizationId)).toEqual(expect.arrayContaining([orgA, orgB]));

    expect(
      await stack.prisma.auditLog.count({ where: { organizationId: orgB, action: 'auth.organization.switched_in' } }),
    ).toBe(1);
    expect(
      await stack.prisma.auditLog.count({ where: { organizationId: orgA, action: 'auth.organization.switched_out' } }),
    ).toBe(1);
  });

  it('a forged organizationId in query, body or headers never changes scope', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const query = await request(`/employees?organizationId=${orgB}`, session);
    expect(query.status).toBe(400);
    const header = await request('/me', session, { headers: { 'x-organization-id': orgB } });
    expect(meResponseSchema.parse(await header.json()).data.activeOrganization.id).toBe(orgA);
    const body = await request(
      `/members/${memberIds.employee ?? ''}/roles`,
      await createSession(stack, SUBJECT.admin, orgA, { mfa: true }),
      {
        method: 'POST',
        body: json({ roleId: orgARoleIds.TEAM_LEAD, organizationId: orgB }),
      },
    );
    expect(body.status).toBe(400);
  });
});

describe('tenant isolation over HTTP', () => {
  it('Org A cannot fetch Org B data (404) and lists contain only Org A rows', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const foreign = await request(`/employees/${orgBProfileId}`, session);
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe('NOT_FOUND');
    const foreignRoles = await request(`/members/${orgBMemberId}/roles`, session);
    expect(foreignRoles.status).toBe(404);
    const own = await request(`/employees/${profileIds.employee ?? ''}`, session);
    expect(own.status).toBe(200);
    expect(employeeResponseSchema.parse(await own.json()).data.memberId).toBe(memberIds.employee);
    const list = employeePageResponseSchema.parse(await (await request('/employees?limit=100', session)).json());
    expect(list.data.some((e) => e.id === orgBProfileId)).toBe(false);
    expect(list.data.length).toBe(DEMO_EMPLOYEES.length);
  });

  it('Org A cannot update Org B data or link Org B records (404, nothing written)', async () => {
    const admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
    const before = await stack.prisma.memberRole.count();
    const updateForeign = await request(`/members/${orgBMemberId}/roles`, admin, {
      method: 'POST',
      body: json({ roleId: orgARoleIds.EMPLOYEE }),
    });
    expect(updateForeign.status).toBe(404);
    const linkForeign = await request(`/members/${memberIds.employee ?? ''}/roles`, admin, {
      method: 'POST',
      body: json({ roleId: orgBRoleId }),
    });
    expect(linkForeign.status).toBe(404);
    expect(await stack.prisma.memberRole.count()).toBe(before);

    const patchForeign = await request(`/employees/${orgBProfileId}`, admin, {
      method: 'PATCH',
      body: json({ fullName: 'Hijacked' }),
    });
    expect(patchForeign.status).toBe(404);
    const foreignManager = await request(`/employees/${profileIds.employee ?? ''}`, admin, {
      method: 'PATCH',
      body: json({ managerId: orgBProfileId }),
    });
    expect(foreignManager.status).toBe(404);
    const employeeProfile = await stack.prisma.employeeProfile.findUniqueOrThrow({
      where: { id: profileIds.employee ?? '' },
    });
    expect(employeeProfile.managerProfileId).not.toBe(orgBProfileId);
    const profileB = await stack.prisma.employeeProfile.findUniqueOrThrow({ where: { id: orgBProfileId } });
    expect(profileB.fullName).toBe('Org B person');
  });
});

describe('authorization', () => {
  it('denies a missing permission with 403', async () => {
    const employee = await createSession(stack, SUBJECT.employee, orgA);
    const audit = await request('/audit/events', employee);
    expect(audit.status).toBe(403);
    expect(await errorCode(audit)).toBe('FORBIDDEN');
    const write = await request(`/members/${memberIds.hr ?? ''}/roles`, employee, {
      method: 'POST',
      body: json({ roleId: orgARoleIds.EMPLOYEE }),
    });
    expect(write.status).toBe(403);
    const edit = await request(`/employees/${profileIds.hr ?? ''}`, employee, {
      method: 'PATCH',
      body: json({ fullName: 'Changed' }),
    });
    expect(edit.status).toBe(403);
  });

  it('hides contact fields outside the caller’s contact scope', async () => {
    const employee = await createSession(stack, SUBJECT.employee, orgA);
    const other = employeeResponseSchema.parse(
      await (await request(`/employees/${profileIds.hr ?? ''}`, employee)).json(),
    );
    expect(other.data.contactVisible).toBe(false);
    expect(other.data.phone).toBeNull();
    const hr = await createSession(stack, SUBJECT.hr, orgA);
    const visible = employeeResponseSchema.parse(
      await (await request(`/employees/${profileIds.employee ?? ''}`, hr)).json(),
    );
    expect(visible.data.contactVisible).toBe(true);
  });

  it('privileged permissions require MFA (401 MFA_REQUIRED), then grants refresh the target session', async () => {
    const employee = await createSession(stack, SUBJECT.employee, orgA);
    const noMfa = await createSession(stack, SUBJECT.admin, orgA);
    const denied = await request(`/members/${memberIds.employee ?? ''}/roles`, noMfa, {
      method: 'POST',
      body: json({ roleId: orgARoleIds.TEAM_LEAD }),
    });
    expect(denied.status).toBe(401);
    expect(await errorCode(denied)).toBe('MFA_REQUIRED');
    const hrNoMfa = await createSession(stack, SUBJECT.hr, orgA);
    const editDenied = await request(`/employees/${profileIds.employee ?? ''}`, hrNoMfa, {
      method: 'PATCH',
      body: json({ fullName: 'Changed' }),
    });
    expect(editDenied.status).toBe(401);
    expect(await errorCode(editDenied)).toBe('MFA_REQUIRED');

    const admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
    const granted = await request(`/members/${memberIds.employee ?? ''}/roles`, admin, {
      method: 'POST',
      body: json({ roleId: orgARoleIds.TEAM_LEAD }),
    });
    expect(granted.status).toBe(200);
    expect(grantRoleResponseSchema.parse(await granted.json()).data.created).toBe(true);
    const audit = await stack.prisma.auditLog.findFirstOrThrow({
      where: { organizationId: orgA, action: 'role.granted', entityId: memberIds.employee ?? '', actorType: 'USER' },
    });
    expect(audit.actorMemberId).toBe(memberIds.admin);
    expect(audit.requestId).not.toBeNull();

    // The employee's grants changed (authz_version): the next request reloads permissions and rotates the id.
    const next = await request(`/employees/${profileIds.hr ?? ''}`, employee);
    const rotatedId = sessionIdFromResponse(next);
    expect(rotatedId).toBeDefined();
    expect(rotatedId).not.toBe(employee.id);
    expect(next.status).toBe(200);
    expect((await request('/me', employee)).status).toBe(401);
  });

  it('non-privileged endpoints do not require MFA', async () => {
    const hr = await createSession(stack, SUBJECT.hr, orgA);
    expect((await request(`/employees/${profileIds.gm ?? ''}`, hr)).status).toBe(200);
    expect((await request('/departments', hr)).status).toBe(200);
  });

  it('the removed security-probe endpoints do not exist', async () => {
    const admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
    expect((await request('/security-probe/members', admin)).status).toBe(404);
    const post = await request(`/security-probe/members/${memberIds.employee ?? ''}/role-grants`, admin, {
      method: 'POST',
      body: json({ roleId: orgARoleIds.EMPLOYEE }),
    });
    expect(post.status).toBe(404);
  });
});

describe('CSRF', () => {
  const switchBody = () => json({ organizationId: orgA });

  it('accepts a valid token with an allowed Origin (app origin and configured extra origin)', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const ok = await request('/me/active-organization', session, { method: 'PUT', body: switchBody() });
    expect(ok.status).toBe(200);
    const other = await createSession(stack, SUBJECT.hr, orgA);
    const extra = await request('/me/active-organization', other, {
      method: 'PUT',
      body: switchBody(),
      origin: ALLOWED_EXTRA_ORIGIN,
    });
    expect(extra.status).toBe(200);
  });

  it.each([
    ['missing token', { csrf: false }],
    ['missing Origin', { origin: null }],
    ['foreign Origin', { origin: 'https://evil.example' }],
  ] as const)('rejects %s with 403 CSRF_INVALID', async (_label, options) => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const response = await request('/me/active-organization', session, {
      method: 'PUT',
      body: switchBody(),
      ...options,
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('CSRF_INVALID');
  });

  it('rejects a token from another session', async () => {
    const victim = await createSession(stack, SUBJECT.hr, orgA);
    const attacker = await createSession(stack, SUBJECT.employee, orgA);
    const response = await request(
      '/me/active-organization',
      { ...victim, csrfToken: attacker.csrfToken },
      { method: 'PUT', body: switchBody() },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('CSRF_INVALID');
  });

  it('GET /auth/csrf returns the session token; safe methods need no token', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const response = await request('/auth/csrf', session);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { csrfToken: string } }).data.csrfToken).toBe(session.csrfToken);
  });

  it('exempts only the back-channel logout endpoint (validated by its own token)', async () => {
    const response = await fetch(`${stack.baseUrl}/api/v1/auth/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('VALIDATION_FAILED');
  });
});

describe('HTTP hardening', () => {
  it('sends security headers and no x-powered-by', async () => {
    const response = await fetch(`${stack.baseUrl}/api/v1/health/live`);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).not.toBeNull();
  });

  it('allows CORS only for configured origins', async () => {
    const preflight = (origin: string) =>
      fetch(`${stack.baseUrl}/api/v1/me`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-csrf-token' },
      });
    const allowed = await preflight(ALLOWED_EXTRA_ORIGIN);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_EXTRA_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await preflight('https://evil.example');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits authentication endpoints (429 RATE_LIMITED)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await fetch(`${stack.baseUrl}/api/v1/auth/login`, { redirect: 'manual' });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(await errorCode(response)).toBe('RATE_LIMITED');
      }
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(AUTH_LIMIT);
    // No trusted proxy hops: a client-supplied X-Forwarded-For cannot select a fresh bucket.
    const spoofed = await fetch(`${stack.baseUrl}/api/v1/auth/login`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(spoofed.status).toBe(429);
  });

  it('server-to-server callbacks use a separate webhook bucket, unaffected by exhausted browser limits', async () => {
    // The auth bucket of this IP is exhausted by the previous test; back-channel logout still answers.
    const backchannel = () =>
      fetch(`${stack.baseUrl}/api/v1/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'logout_token=',
      });
    const statuses: number[] = [];
    for (let i = 0; i < WEBHOOK_LIMIT + 1; i += 1) {
      statuses.push((await backchannel()).status);
    }
    // Earlier tests in this file may have used part of the webhook budget, never the auth budget's.
    const firstLimited = statuses.indexOf(429);
    expect(firstLimited).toBeGreaterThan(AUTH_LIMIT);
    expect(statuses.slice(0, firstLimited).every((status) => status === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await fetch(`${stack.baseUrl}/api/v1/auth/login`, { redirect: 'manual' })).status).toBe(429);
  });

  it('errors use the envelope and never echo rejected values', async () => {
    const session = await createSession(stack, SUBJECT.hr, orgA);
    const response = await request('/me/active-organization', session, {
      method: 'PUT',
      body: json({ organizationId: 'secret-value-123' }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('secret-value-123');
    expect(errorEnvelopeSchema.parse(JSON.parse(text)).error.fieldErrors).toEqual([
      { path: 'organizationId', code: 'invalid' },
    ]);
  });
});
