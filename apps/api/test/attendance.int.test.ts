import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attendanceCheckResponseSchema,
  attendanceCorrectionResponseSchema,
  attendancePolicyResponseSchema,
  attendanceRecordDetailResponseSchema,
  attendanceRecordPageResponseSchema,
  attendanceTeamDayPageResponseSchema,
  attendanceTodayResponseSchema,
  errorEnvelopeSchema,
  shiftAssignmentPageResponseSchema,
  shiftListResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 7 (attendance) over real HTTP with the real clock: Idempotency-Key handling (201 then 200 on
 * replay), strict bodies (no client location id or extra fields), refused evidence as 422 with stable
 * codes, scopes (404 outside, 403 without permission), fresh MFA for privileged changes, the CSV export
 * and the per-user attendance rate limit. Responses match the shared Zod contracts behind OpenAPI.
 */
let stack: ApiStack;
let orgA: string;
let orgB: string;

const HQ = { status: 'OK', latitude: 30.045, longitude: 31.236, accuracy: 15 } as const;
const FAR = { status: 'OK', latitude: 30.1, longitude: 31.3, accuracy: 15 } as const;

function call(
  path: string,
  session: TestSession,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers({ cookie: session.cookie, ...init.headers });
  if (method !== 'GET') {
    headers.set('origin', PUBLIC_URL);
    headers.set('x-csrf-token', session.csrfToken);
  }
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${stack.baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function ok<T>(response: Response, schema: { parse(value: unknown): T }, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack/i);
  return envelope.error.code;
}

async function sessionFor(employeeNumber: string, organizationId = orgA, mfa = true): Promise<TestSession> {
  const profile = await stack.prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId, employeeNumber },
    select: { member: { select: { user: { select: { idpSubject: true } } } } },
  });
  const subject = profile.member.user?.idpSubject;
  if (subject === undefined) throw new Error(`${employeeNumber} has no linked user`);
  return createSession(stack, subject, organizationId, { mfa });
}

const check = (session: TestSession, kind: 'check-in' | 'check-out', body: unknown, key?: string) =>
  call(`/attendance/${kind}`, session, {
    method: 'POST',
    body,
    ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  orgB = (await stack.prisma.organization.findFirstOrThrow({ where: { id: { not: orgA } }, select: { id: true } })).id;
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('check-in over HTTP', () => {
  it('requires a UUID Idempotency-Key and a strict body without client location ids', async () => {
    const employee = await sessionFor('EMP-00009');
    expect(await failure(await check(employee, 'check-in', { location: HQ }), 400)).toBe('VALIDATION_FAILED');
    expect(await failure(await check(employee, 'check-in', { location: HQ }, 'not-a-uuid'), 400)).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await failure(
        await check(employee, 'check-in', { location: HQ, workLocationId: randomUUID() }, randomUUID()),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await check(employee, 'check-in', { location: { ...HQ, workLocationId: randomUUID() } }, randomUUID()),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    // Distance, time, organization and employee are decided by the server; client values are refused.
    // A separate employee keeps EMP-00009's per-minute attendance budget for the scope tests.
    const forger = await sessionFor('EMP-00016');
    for (const forged of [
      { location: { ...HQ, distanceMeters: 0 } },
      { location: HQ, recordedAt: '2020-01-01T08:00:00.000Z' },
      { location: HQ, organizationId: randomUUID() },
      { location: HQ, profileId: randomUUID() },
    ]) {
      expect(await failure(await check(forger, 'check-in', forged, randomUUID()), 400)).toBe('VALIDATION_FAILED');
    }
    expect(
      await stack.prisma.attendanceEvent.count({
        where: { organizationId: orgA, profile: { employeeNumber: 'EMP-00016' } },
      }),
    ).toBe(0);
    expect(
      await failure(await check(employee, 'check-in', { location: { ...HQ, latitude: 91 } }, randomUUID()), 400),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await check(employee, 'check-in', { location: { status: 'OK', latitude: 30, longitude: 31 } }, randomUUID()),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await stack.prisma.attendanceEvent.count({
        where: { organizationId: orgA, profile: { employeeNumber: 'EMP-00009' } },
      }),
    ).toBe(0);
  });

  it('creates once (201), replays the same key (200) and refuses evidence with stable codes (422)', async () => {
    const employee = await sessionFor('EMP-00010');
    expect(await failure(await check(employee, 'check-in', { location: FAR }, randomUUID()), 422)).toBe(
      'ATTENDANCE_OUTSIDE_GEOFENCE',
    );
    expect(
      await failure(
        await check(employee, 'check-in', { location: { status: 'PERMISSION_DENIED' } }, randomUUID()),
        422,
      ),
    ).toBe('ATTENDANCE_LOCATION_REQUIRED');
    const key = randomUUID();
    const created = await ok(
      await check(employee, 'check-in', { location: HQ }, key),
      attendanceCheckResponseSchema,
      201,
    );
    expect(created.data.replayed).toBe(false);
    expect(created.data.event.geofenceResult).toBe('INSIDE');
    const replay = await ok(
      await check(employee, 'check-in', { location: HQ }, key),
      attendanceCheckResponseSchema,
      200,
    );
    expect(replay.data).toMatchObject({ replayed: true, event: { id: created.data.event.id } });
    expect(JSON.stringify(replay)).not.toMatch(/"latitude"|"longitude"/);
    expect(await failure(await check(employee, 'check-in', { location: HQ }, randomUUID()), 409)).toBe(
      'ATTENDANCE_ALREADY_CHECKED_IN',
    );
    const out = await ok(
      await check(employee, 'check-out', { location: HQ }, randomUUID()),
      attendanceCheckResponseSchema,
      201,
    );
    expect(out.data.record.checkOutAt).not.toBeNull();

    const today = await ok(await call('/attendance/today', employee), attendanceTodayResponseSchema);
    expect(today.data).toMatchObject({ eligible: true, nextAction: 'NONE', timeZone: 'Africa/Cairo' });
    const mine = await ok(await call('/attendance/me/records', employee), attendanceRecordPageResponseSchema);
    expect(mine.data.map((record) => record.id)).toContain(created.data.record.id);
    const stored = await stack.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: created.data.event.id } });
    expect(stored.userAgent).not.toBeNull();
  });

  it('limits check-ins per user without breaking a burst of retries', async () => {
    const employee = await sessionFor('EMP-00011');
    const key = randomUUID();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await check(employee, 'check-in', { location: HQ }, key);
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1).every((status) => status === 200)).toBe(true);
    const limited = await check(employee, 'check-in', { location: HQ }, key);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(await failure(limited, 429)).toBe('RATE_LIMITED');
    // Another user's budget is independent.
    const other = await sessionFor('EMP-00028');
    await ok(await call('/attendance/today', other), attendanceTodayResponseSchema);
  });
});

describe('scopes over HTTP', () => {
  it('shows records to the team lead and HR, 404 to others and 403 without the permission', async () => {
    const employee = await sessionFor('EMP-00009');
    const created = await ok(
      await check(employee, 'check-in', { location: HQ }, randomUUID()),
      attendanceCheckResponseSchema,
      201,
    );
    const recordId = created.data.record.id;
    const lead = await sessionFor('EMP-00008');
    const hr = await sessionFor('EMP-00003');
    const otherLead = await sessionFor('EMP-00013');
    const colleague = await sessionFor('EMP-00010');
    const foreign = await sessionFor('NW-001', orgB);

    const asLead = await ok(await call(`/attendance/records/${recordId}`, lead), attendanceRecordDetailResponseSchema);
    expect(asLead.data.canCorrect).toBe(false);
    const asHr = await ok(await call(`/attendance/records/${recordId}`, hr), attendanceRecordDetailResponseSchema);
    expect(asHr.data.canCorrect).toBe(true);
    for (const outsider of [otherLead, colleague, foreign]) {
      expect(await failure(await call(`/attendance/records/${recordId}`, outsider), 404)).toBe('NOT_FOUND');
    }
    await failure(await call('/attendance/records', colleague), 403);
    await failure(await call('/attendance/team/day', colleague), 403);
    await failure(await call('/attendance/shifts', lead), 403);
    const day = await ok(await call('/attendance/team/day', lead), attendanceTeamDayPageResponseSchema);
    expect(day.data.some((item) => item.employee.employeeNumber === 'EMP-00009')).toBe(true);
    expect(day.data.some((item) => item.employee.employeeNumber === 'EMP-00014')).toBe(false);
    const team = await ok(
      await call('/attendance/records?needsReview=false', lead),
      attendanceRecordPageResponseSchema,
    );
    expect(team.data.every((record) => record.employee.employeeNumber !== 'EMP-00014')).toBe(true);
    const shifts = await ok(await call('/attendance/shifts', hr), shiftListResponseSchema);
    expect(shifts.data.map((shift) => shift.name).sort()).toEqual(['Day shift', 'Night shift']);
    await ok(await call('/attendance/shift-assignments?limit=5', hr), shiftAssignmentPageResponseSchema);
  });

  it('exports CSV in scope with a byte order mark, bounded, without coordinates', async () => {
    const hr = await sessionFor('EMP-00003');
    const response = await call(`/attendance/export?from=${isoDate(-7)}&to=${isoDate(1)}`, hr);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="attendance-/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('employee_number');
    expect(text).not.toMatch(/latitude|longitude/);
    expect(await failure(await call(`/attendance/export?from=${isoDate(-90)}&to=${isoDate(0)}`, hr), 400)).toBe(
      'VALIDATION_FAILED',
    );
    const colleague = await sessionFor('EMP-00010');
    await failure(await call(`/attendance/export?from=${isoDate(-7)}&to=${isoDate(0)}`, colleague), 403);
  });
});

describe('privileged changes over HTTP', () => {
  it('needs fresh MFA for direct corrections and policy changes', async () => {
    const subject = await stack.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: orgA, employeeNumber: 'EMP-00014' },
      select: { id: true },
    });
    const body = {
      profileId: subject.id,
      workDate: isoDate(-1),
      reasonCode: 'SYSTEM_ISSUE',
      checkIn: '09:00',
      checkOut: '17:00',
      note: 'Badge reader outage',
      version: null,
    };
    const hrWithoutMfa = await sessionFor('EMP-00003', orgA, false);
    expect(
      await failure(await call('/attendance/admin/corrections', hrWithoutMfa, { method: 'POST', body }), 401),
    ).toBe('MFA_REQUIRED');
    const lead = await sessionFor('EMP-00013');
    await failure(await call('/attendance/admin/corrections', lead, { method: 'POST', body }), 403);
    const hr = await sessionFor('EMP-00003');
    expect(
      await failure(
        await call('/attendance/admin/corrections', hr, { method: 'POST', body: { ...body, note: undefined } }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    const corrected = await ok(
      await call('/attendance/admin/corrections', hr, { method: 'POST', body }),
      attendanceRecordDetailResponseSchema,
    );
    expect(corrected.data.record.adjusted).toBe(true);
    expect(await failure(await call('/attendance/admin/corrections', hr, { method: 'POST', body }), 409)).toBe(
      'VERSION_CONFLICT',
    );

    const admin = await sessionFor('EMP-00001');
    const policy = await ok(await call('/attendance/policy', admin), attendancePolicyResponseSchema);
    const update = {
      maxAccuracyMeters: 120,
      lowAccuracyAction: 'FLAG_FOR_REVIEW',
      missingLocationAction: 'REJECT',
      missingCheckoutAfterMinutes: 240,
      version: policy.data.version,
    };
    const adminWithoutMfa = await sessionFor('EMP-00001', orgA, false);
    expect(await failure(await call('/attendance/policy', adminWithoutMfa, { method: 'PUT', body: update }), 401)).toBe(
      'MFA_REQUIRED',
    );
    await failure(await call('/attendance/policy', hr, { method: 'PUT', body: update }), 403);
    const saved = await ok(
      await call('/attendance/policy', admin, { method: 'PUT', body: update }),
      attendancePolicyResponseSchema,
    );
    expect(saved.data.maxAccuracyMeters).toBe(120);
  });

  it('submits an employee correction as a request, once per key', async () => {
    const employee = await sessionFor('EMP-00015');
    const key = randomUUID();
    const body = {
      workDate: isoDate(-1),
      reasonCode: 'FORGOT_CHECK_IN',
      checkIn: '09:05',
      details: 'Forgot my phone.',
    };
    const created = await ok(
      await call('/attendance/corrections', employee, { method: 'POST', body, headers: { 'idempotency-key': key } }),
      attendanceCorrectionResponseSchema,
      201,
    );
    expect(created.data.status).toBe('PENDING');
    const replay = await ok(
      await call('/attendance/corrections', employee, { method: 'POST', body, headers: { 'idempotency-key': key } }),
      attendanceCorrectionResponseSchema,
      201,
    );
    expect(replay.data.id).toBe(created.data.id);
    expect(
      await failure(
        await call('/attendance/corrections', employee, {
          method: 'POST',
          body: { ...body, reasonCode: 'BAD_REASON' },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await call('/attendance/corrections', employee, { method: 'POST', body: { ...body, workDate: isoDate(3) } }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
  });
});
