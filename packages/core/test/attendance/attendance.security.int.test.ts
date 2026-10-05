import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { AttendanceCorrectionService } from '../../src/modules/attendance/attendance-correction.service.js';
import {
  AttendanceEffectConsumer,
  AttendanceJobRejectedError,
} from '../../src/modules/attendance/attendance-effects.js';
import { AttendancePolicyService } from '../../src/modules/attendance/attendance-policy.service.js';
import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';
import type { LocationInput } from '../../src/modules/attendance/attendance.service.js';
import { MissingCheckoutSweep } from '../../src/modules/attendance/missing-checkout-sweep.js';
import { ShiftService } from '../../src/modules/attendance/shift.service.js';
import { ApprovalService } from '../../src/modules/requests/approval.service.js';
import { RequestService } from '../../src/modules/requests/request.service.js';
import { RetentionPolicyService, RetentionPurger } from '../../src/modules/retention/retention.service.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  VersionConflictError,
} from '../../src/platform/errors.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Attendance (ADR-0022) against PostgreSQL 18 with the real migrations and the development seed:
 * server-side geofencing, accuracy policy, idempotent check-in/out, eligibility of locations (offices,
 * active project sites only, never foreign or inactive ones), shifts (overnight, overlap), reviews,
 * corrections through the Phase 6 engine, administrator corrections, effects, the missing-checkout
 * sweep, coordinate retention, export, scopes, tenant isolation and append-only evidence.
 *
 * The clock is fixed in March 2030 (Africa/Cairo, UTC+2, work week Sunday–Thursday); the seeded day
 * shift (09:00–17:00, grace 15) is assigned to every employee from the seeding day, open-ended.
 * Actors: EMP-00001 org admin (org.settings.manage, attendance.config), EMP-00003 HR admin
 * (attendance.admin/config/team org-wide), EMP-00008 team lead of EMP-00009/10/11/28, EMP-00013 lead of
 * EMP-00014/15/16/29 (and manager of the active TMP project whose sites include Smart Village), NW-001
 * another organization. Requests are approved by their resolved approver (the direct manager).
 */
let s: SeededDatabase;
let now = new Date('2030-03-03T07:00:00.000Z');
const clock = (): Date => now;
const at = (iso: string): void => {
  now = new Date(iso);
};

let attendance: AttendanceService;
let corrections: AttendanceCorrectionService;
let policies: AttendancePolicyService;
let shifts: ShiftService;
let requests: RequestService;
let approvals: ApprovalService;
let consumer: AttendanceEffectConsumer;
let sweep: MissingCheckoutSweep;

let admin: ActionContext;
let hr: ActionContext;
let lead: ActionContext;
let otherLead: ActionContext;
let foreign: ActionContext;

const HQ = { latitude: 30.045, longitude: 31.236 };
const FAR = { latitude: 30.1, longitude: 31.3 };
const SMART_VILLAGE = { latitude: 30.0712, longitude: 31.0172 };
const ALEXANDRIA = { latitude: 31.2003, longitude: 29.9189 };

const ok = (point: { latitude: number; longitude: number }, accuracy = 20): LocationInput => ({
  status: 'OK',
  ...point,
  accuracy,
});

const actor = (number: string): Promise<ActionContext> => s.actionFor(number);

const checkIn = (who: ActionContext, location: LocationInput | undefined, key: string = randomUUID()) =>
  s.as(who, () => attendance.check(who, 'CHECK_IN', { location }, key));
const checkOut = (who: ActionContext, location: LocationInput | undefined, key: string = randomUUID()) =>
  s.as(who, () => attendance.check(who, 'CHECK_OUT', { location }, key));

const eventCount = async (number: string): Promise<number> => {
  const employee = await s.employee(number);
  return s.prisma.attendanceEvent.count({ where: { organizationId: s.demoId, profileId: employee.profileId } });
};

const recordOf = async (number: string, date: string) => {
  const employee = await s.employee(number);
  return s.prisma.attendanceRecord.findFirst({
    where: { organizationId: s.demoId, profileId: employee.profileId, workDate: new Date(`${date}T00:00:00.000Z`) },
  });
};

const typeId = async (key: string): Promise<string> =>
  (await s.prisma.requestType.findFirstOrThrow({ where: { organizationId: s.demoId, key }, select: { id: true } })).id;

/** Approves the pending step as its resolved approver (the requester's direct manager). */
const approvePending = async (requestId: string): Promise<void> => {
  const approval = await s.prisma.requestApproval.findFirstOrThrow({
    where: { requestId, status: 'PENDING' },
    select: { id: true, approverMemberId: true },
  });
  const profile = await s.prisma.employeeProfile.findFirstOrThrow({
    where: { memberId: approval.approverMemberId },
    select: { employeeNumber: true },
  });
  const approver = await actor(profile.employeeNumber);
  await s.as(approver, () => approvals.approve(approver, approval.id, undefined));
};

const effectOf = (requestId: string) =>
  s.prisma.requestEffect.findFirstOrThrow({ where: { requestId }, select: { id: true, status: true, mode: true } });

const deliver = (signal: 'RECORDED' | 'REVOKED', requestId: string, effectId: string) =>
  s.asSystem(s.demoId, () => consumer.handle(signal, requestId, effectId, now));

const adminCancel = async (requestId: string): Promise<void> => {
  const row = await s.prisma.requestInstance.findFirstOrThrow({ where: { id: requestId }, select: { version: true } });
  await s.as(hr, () => requests.cancel(hr, requestId, row.version, 'Entered in error'));
};

beforeAll(async () => {
  s = await startSeededDatabase();
  attendance = new AttendanceService(s.tenantDb, s.tenant, clock);
  requests = new RequestService(s.tenantDb, s.tenant);
  approvals = new ApprovalService(s.tenantDb, s.tenant);
  corrections = new AttendanceCorrectionService(s.tenantDb, s.tenant, requests, attendance, clock);
  policies = new AttendancePolicyService(s.tenantDb, s.tenant);
  shifts = new ShiftService(s.tenantDb, s.tenant, clock);
  consumer = new AttendanceEffectConsumer(s.tenantDb, s.tenant);
  sweep = new MissingCheckoutSweep(s.tenantDb, s.tenant);
  admin = await actor('EMP-00001');
  hr = await actor('EMP-00003');
  lead = await actor('EMP-00008');
  otherLead = await actor('EMP-00013');
  foreign = await s.actionFor('NW-001', s.northwindId);
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('check-in and check-out', () => {
  it('records server-decided evidence inside the geofence, late and early minutes, and worked time', async () => {
    const employee = await actor('EMP-00009');
    at('2030-03-03T06:30:00.000Z');
    const today = await s.as(employee, () => attendance.today(employee));
    expect(today).toMatchObject({
      workDate: '2030-03-03',
      timeZone: 'Africa/Cairo',
      eligible: true,
      configured: true,
      nextAction: 'CHECK_IN',
      locationRequired: true,
      scheduledStartAt: '2030-03-03T07:00:00.000Z',
      scheduledEndAt: '2030-03-03T15:00:00.000Z',
      maxAccuracyMeters: 100,
    });
    expect(today.eligibleLocationCount).toBeGreaterThanOrEqual(1);

    at('2030-03-03T07:20:00.000Z');
    const key = randomUUID();
    const first = await checkIn(employee, ok({ latitude: 30.0450123, longitude: 31.2360987 }), key);
    expect(first.replayed).toBe(false);
    expect(first.record).toMatchObject({ status: 'OPEN', workDate: '2030-03-03', lateMinutes: 5, mode: 'OFFICE' });
    expect(first.record.checkInLocation?.name).toBe('Cairo HQ');
    expect(first.event).toMatchObject({ kind: 'CHECK_IN', geofenceResult: 'INSIDE', reviewStatus: 'NOT_REQUIRED' });
    expect(first.event.distanceMeters).toBeLessThanOrEqual(200);
    expect(first.event).not.toHaveProperty('latitude');
    const stored = await s.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: first.event.id } });
    expect(stored.latitude?.toNumber()).toBe(30.04501);
    expect(stored.longitude?.toNumber()).toBe(31.2361);
    expect(stored.recordedAt.toISOString()).toBe('2030-03-03T07:20:00.000Z');

    // A replay of the same key returns the original outcome without a new event, even later.
    at('2030-03-03T07:25:00.000Z');
    const replay = await checkIn(employee, ok(FAR), key);
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    expect(await eventCount('EMP-00009')).toBe(1);
    // The key is bound to its owner and to the action.
    const colleague = await actor('EMP-00010');
    await expect(checkIn(colleague, ok(HQ), key)).rejects.toBeInstanceOf(ConflictError);
    await expect(checkOut(employee, ok(HQ), key)).rejects.toBeInstanceOf(ConflictError);
    await expect(checkIn(employee, ok(HQ))).rejects.toMatchObject({
      code: 'ATTENDANCE_ALREADY_CHECKED_IN',
      status: 409,
    });

    at('2030-03-03T14:30:00.000Z');
    const out = await checkOut(employee, ok(HQ));
    expect(out.record).toMatchObject({ status: 'COMPLETE', earlyLeaveMinutes: 15, workedMinutes: 430 });
    await expect(checkOut(employee, ok(HQ))).rejects.toMatchObject({ code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
    await expect(checkIn(employee, ok(HQ))).rejects.toMatchObject({ code: 'ATTENDANCE_ALREADY_CHECKED_OUT' });
    expect(await eventCount('EMP-00009')).toBe(2);
  });

  it('refuses positions outside every eligible geofence without storing anything', async () => {
    const employee = await actor('EMP-00010');
    at('2030-03-03T07:00:00.000Z');
    const refused: unknown = await checkIn(employee, ok(FAR)).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: 'ATTENDANCE_OUTSIDE_GEOFENCE',
      status: 422,
      details: { nearestLocation: 'Cairo HQ' },
    });
    // Errors carry the distance and the location name, never the submitted coordinates.
    expect(JSON.stringify(refused)).not.toMatch(/latitude|longitude|30\.1|31\.3/);
    // Project sites count only for active members of an ACTIVE project linked to them.
    await expect(checkIn(employee, ok(SMART_VILLAGE))).rejects.toMatchObject({ code: 'ATTENDANCE_OUTSIDE_GEOFENCE' });
    const posMember = await actor('EMP-00009');
    at('2030-03-04T07:00:00.000Z');
    await expect(checkIn(posMember, ok(ALEXANDRIA))).rejects.toMatchObject({ code: 'ATTENDANCE_OUTSIDE_GEOFENCE' });
    expect(await eventCount('EMP-00010')).toBe(0);
    expect(await recordOf('EMP-00010', '2030-03-03')).toBeNull();
  });

  it('accepts an active project member at the project site', async () => {
    const member = await actor('EMP-00014');
    at('2030-03-03T07:00:00.000Z');
    const result = await checkIn(member, ok(SMART_VILLAGE));
    expect(result.event).toMatchObject({ geofenceResult: 'INSIDE', mode: 'SITE' });
    expect(result.record.checkInLocation?.name).toBe('Smart Village Site');
  });

  it('never matches inactive or foreign locations', async () => {
    const employee = await actor('EMP-00011');
    const inactive = await s.prisma.workLocation.create({
      data: {
        organizationId: s.demoId,
        name: 'Closed branch',
        type: 'OFFICE',
        latitude: 30.2,
        longitude: 31.5,
        allowedRadiusMeters: 500,
        active: false,
      },
    });
    const northwind = await s.prisma.workLocation.create({
      data: {
        organizationId: s.northwindId,
        name: 'Northwind office',
        type: 'OFFICE',
        latitude: 30.3,
        longitude: 31.6,
        allowedRadiusMeters: 500,
      },
    });
    at('2030-03-10T07:00:00.000Z');
    await expect(checkIn(employee, ok({ latitude: 30.2, longitude: 31.5 }))).rejects.toMatchObject({
      code: 'ATTENDANCE_OUTSIDE_GEOFENCE',
    });
    await expect(checkIn(employee, ok({ latitude: 30.3, longitude: 31.6 }))).rejects.toMatchObject({
      code: 'ATTENDANCE_OUTSIDE_GEOFENCE',
    });
    expect(inactive.id).not.toBe(northwind.id);
    expect(await recordOf('EMP-00011', '2030-03-10')).toBeNull();
  });

  it('flags low accuracy for review (never INSIDE) and lets the team lead decide once', async () => {
    const employee = await actor('EMP-00011');
    at('2030-03-03T07:00:00.000Z');
    const result = await checkIn(employee, ok(HQ, 150.2));
    expect(result.event).toMatchObject({
      geofenceResult: 'LOW_ACCURACY',
      reviewStatus: 'PENDING_REVIEW',
      accuracyMeters: 151,
      accuracyThresholdMeters: 100,
    });
    expect(result.record.needsReview).toBe(true);

    const queue = await s.as(lead, () => attendance.reviews(lead, {}));
    expect(queue.items.map((item) => item.event.id)).toContain(result.event.id);
    expect((await s.as(otherLead, () => attendance.reviews(otherLead, {}))).items.map((i) => i.event.id)).not.toContain(
      result.event.id,
    );
    // The employee, a colleague and another organization cannot decide it.
    await expect(
      s.as(employee, () => attendance.review(employee, result.event.id, 'ACCEPTED', undefined)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const colleague = await actor('EMP-00010');
    await expect(
      s.as(colleague, () => attendance.review(colleague, result.event.id, 'ACCEPTED', undefined)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(foreign, () => attendance.review(foreign, result.event.id, 'ACCEPTED', undefined)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(lead, () => attendance.review(lead, result.event.id, 'REJECTED', undefined)),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const decided = await s.as(lead, () => attendance.review(lead, result.event.id, 'ACCEPTED', 'Indoor signal'));
    expect(decided.record.needsReview).toBe(false);
    expect(decided.events.find((event) => event.id === result.event.id)).toMatchObject({
      reviewStatus: 'ACCEPTED',
      geofenceResult: 'LOW_ACCURACY',
    });
    await expect(s.as(lead, () => attendance.review(lead, result.event.id, 'REJECTED', 'again'))).rejects.toThrow(
      /already reviewed/,
    );
    const notices = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, aggregateId: result.record.id, eventType: 'notification.requested' },
    });
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]?.payload)).not.toMatch(/latitude|longitude|30\.04/);
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, action: 'attendance.review.decided', entityId: result.event.id },
      }),
    ).toBe(1);
  });

  it('applies the policy: rejected low accuracy, required location, audited changes', async () => {
    const before = await s.as(hr, () => policies.get(hr));
    expect(before).toMatchObject({
      configured: true,
      lowAccuracyAction: 'FLAG_FOR_REVIEW',
      missingLocationAction: 'REJECT',
    });
    await expect(
      s.as(hr, () =>
        policies.set(hr, {
          maxAccuracyMeters: 50,
          lowAccuracyAction: 'REJECT',
          missingLocationAction: 'REJECT',
          missingCheckoutAfterMinutes: 240,
          version: before.version,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const changed = await s.as(admin, () =>
      policies.set(admin, {
        maxAccuracyMeters: 50,
        lowAccuracyAction: 'REJECT',
        missingLocationAction: 'REJECT',
        missingCheckoutAfterMinutes: 240,
        version: before.version,
      }),
    );
    try {
      await expect(
        s.as(admin, () =>
          policies.set(admin, {
            maxAccuracyMeters: 60,
            lowAccuracyAction: 'REJECT',
            missingLocationAction: 'REJECT',
            missingCheckoutAfterMinutes: 240,
            version: before.version,
          }),
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      const employee = await actor('EMP-00028');
      at('2030-03-03T07:00:00.000Z');
      await expect(checkIn(employee, ok(HQ, 80))).rejects.toMatchObject({
        code: 'ATTENDANCE_LOW_ACCURACY',
        status: 422,
        details: { accuracyMeters: 80, maxAccuracyMeters: 50 },
      });
      await expect(checkIn(employee, { status: 'PERMISSION_DENIED' })).rejects.toMatchObject({
        code: 'ATTENDANCE_LOCATION_REQUIRED',
      });
      await expect(checkIn(employee, undefined)).rejects.toBeInstanceOf(InvalidInputError);
      expect(await eventCount('EMP-00028')).toBe(0);
    } finally {
      await s.as(admin, () =>
        policies.set(admin, {
          maxAccuracyMeters: 100,
          lowAccuracyAction: 'FLAG_FOR_REVIEW',
          missingLocationAction: 'REJECT',
          missingCheckoutAfterMinutes: 240,
          version: changed.version,
        }),
      );
    }
    const audits = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, action: 'attendance.policy.updated' },
      select: { metadata: true },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses employees who are not active', async () => {
    const employee = await actor('EMP-00030');
    const subject = await s.employee('EMP-00030');
    await s.prisma.employeeProfile.update({ where: { id: subject.profileId }, data: { employmentStatus: 'ON_LEAVE' } });
    try {
      at('2030-03-03T07:00:00.000Z');
      expect(await s.as(employee, () => attendance.today(employee))).toMatchObject({
        eligible: false,
        ineligibleReason: 'NOT_ACTIVE',
        nextAction: 'NONE',
      });
      await expect(checkIn(employee, ok(HQ))).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_ELIGIBLE', status: 409 });
    } finally {
      await s.prisma.employeeProfile.update({ where: { id: subject.profileId }, data: { employmentStatus: 'ACTIVE' } });
    }
  });

  it('serializes concurrent check-ins of one employee and concurrent replays of one key', async () => {
    const employee = await actor('EMP-00029');
    at('2030-03-03T07:00:00.000Z');
    const results = await Promise.allSettled([
      checkIn(employee, ok(HQ)),
      checkIn(employee, ok(HQ)),
      checkIn(employee, ok(HQ)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'ATTENDANCE_ALREADY_CHECKED_IN' });
    }
    at('2030-03-03T15:00:00.000Z');
    const key = randomUUID();
    const outs = await Promise.all([checkOut(employee, ok(HQ), key), checkOut(employee, ok(HQ), key)]);
    expect(new Set(outs.map((out) => out.event.id)).size).toBe(1);
    expect(await eventCount('EMP-00029')).toBe(2);
  });
});

describe('shifts', () => {
  it('handles an overnight shift as one work day and rejects overlapping or past assignments', async () => {
    const employee = await actor('EMP-00015');
    const subject = await s.employee('EMP-00015');
    const night = await s.prisma.shift.findFirstOrThrow({ where: { organizationId: s.demoId, name: 'Night shift' } });
    const day = await s.prisma.shift.findFirstOrThrow({ where: { organizationId: s.demoId, name: 'Day shift' } });
    at('2030-03-10T08:00:00.000Z');
    await expect(s.as(lead, () => shifts.listShifts(lead, false))).rejects.toBeInstanceOf(ForbiddenError);
    const current = await s.as(hr, () => shifts.listAssignments(hr, { profileId: subject.profileId }));
    const seeded = current.items[0];
    if (seeded === undefined) throw new Error('missing seeded assignment');
    await expect(
      s.as(hr, () =>
        shifts.createAssignment(hr, { profileId: subject.profileId, shiftId: night.id, effectiveFrom: '2030-03-11' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      s.as(hr, () => shifts.endAssignment(hr, seeded.id, { effectiveTo: '2030-03-08', version: seeded.version })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await s.as(hr, () => shifts.endAssignment(hr, seeded.id, { effectiveTo: '2030-03-10', version: seeded.version }));
    await expect(
      s.as(hr, () =>
        shifts.createAssignment(hr, { profileId: subject.profileId, shiftId: night.id, effectiveFrom: '2030-03-09' }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await s.as(hr, () =>
      shifts.createAssignment(hr, { profileId: subject.profileId, shiftId: night.id, effectiveFrom: '2030-03-11' }),
    );
    await expect(
      s.as(hr, () =>
        shifts.createAssignment(hr, {
          profileId: subject.profileId,
          shiftId: day.id,
          effectiveFrom: '2030-04-01',
          effectiveTo: '2030-04-30',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // The database exclusion constraint backs the service check.
    await expect(
      s.prisma.employeeShiftAssignment.create({
        data: {
          organizationId: s.demoId,
          profileId: subject.profileId,
          shiftId: day.id,
          effectiveFrom: new Date('2030-05-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
    expect(
      await s.prisma.auditLog.count({
        where: {
          organizationId: s.demoId,
          action: { in: ['attendance.shift_assignment.created', 'attendance.shift_assignment.ended'] },
        },
      }),
    ).toBeGreaterThanOrEqual(3);

    at('2030-03-11T20:05:00.000Z');
    const started = await checkIn(employee, ok(HQ));
    expect(started.record).toMatchObject({
      workDate: '2030-03-11',
      scheduledStartAt: '2030-03-11T20:00:00.000Z',
      scheduledEndAt: '2030-03-12T04:00:00.000Z',
      lateMinutes: 0,
    });
    expect(started.record.shift?.name).toBe('Night shift');
    at('2030-03-12T04:10:00.000Z');
    const today = await s.as(employee, () => attendance.today(employee));
    expect(today).toMatchObject({ workDate: '2030-03-11', nextAction: 'CHECK_OUT' });
    const ended = await checkOut(employee, ok(HQ));
    expect(ended.record).toMatchObject({
      id: started.record.id,
      status: 'COMPLETE',
      workedMinutes: 485,
      earlyLeaveMinutes: 0,
    });
  });
});

describe('visibility and tenant isolation', () => {
  it('shows records to the employee, their team lead and HR only; device details to HR only', async () => {
    const record = await recordOf('EMP-00009', '2030-03-03');
    if (record === null) throw new Error('missing record');
    at('2030-03-06T08:00:00.000Z');
    const self = await actor('EMP-00009');
    const own = await s.as(self, () => attendance.recordDetail(self, record.id));
    expect(own.canCorrect).toBe(false);
    expect(own.events.every((event) => event.device === null)).toBe(true);
    expect(JSON.stringify(own)).not.toMatch(/"latitude"|"longitude"/);
    expect((await s.as(lead, () => attendance.recordDetail(lead, record.id))).record.id).toBe(record.id);
    const asHr = await s.as(hr, () => attendance.recordDetail(hr, record.id));
    expect(asHr.canCorrect).toBe(true);
    expect(asHr.events[0]?.device).not.toBeNull();
    const colleague = await actor('EMP-00010');
    for (const outsider of [colleague, otherLead, foreign]) {
      await expect(s.as(outsider, () => attendance.recordDetail(outsider, record.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    await expect(s.as(colleague, () => attendance.records(colleague, {}))).rejects.toBeInstanceOf(ForbiddenError);

    const team = await s.as(lead, () => attendance.records(lead, { from: '2030-03-01', to: '2030-03-31', limit: 100 }));
    const teamNumbers = new Set(team.items.map((item) => item.employee.employeeNumber));
    expect(teamNumbers.has('EMP-00009')).toBe(true);
    expect(teamNumbers.has('EMP-00014')).toBe(false);
    const mine = await s.as(self, () => attendance.myRecords(self, { from: '2030-03-01', to: '2030-03-31' }));
    expect(mine.items.every((item) => item.employee.employeeNumber === 'EMP-00009')).toBe(true);
    const theirs = await s.as(foreign, () => attendance.records(foreign, { from: '2030-03-01', to: '2030-03-31' }));
    expect(theirs.items).toEqual([]);
  });

  it('never shows future days as absent', async () => {
    at('2030-03-06T08:00:00.000Z');
    const page = await s.as(lead, () => attendance.teamDay(lead, { date: '2030-03-20' }));
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.status !== 'ABSENT')).toBe(true);
    const past = await s.as(lead, () => attendance.teamDay(lead, { date: '2030-03-05' }));
    expect(past.items.find((item) => item.employee.employeeNumber === 'EMP-00028')?.status).toBe('ABSENT');
  });

  it('keeps evidence append-only and organizations apart in the database', async () => {
    const event = await s.prisma.attendanceEvent.findFirstOrThrow({
      where: { organizationId: s.demoId, kind: 'CHECK_IN', reviewStatus: 'NOT_REQUIRED', latitude: { not: null } },
    });
    await expect(
      s.prisma.attendanceEvent.update({ where: { id: event.id }, data: { latitude: null } }),
    ).rejects.toThrow();
    await expect(
      s.prisma.attendanceEvent.update({ where: { id: event.id }, data: { reviewStatus: 'ACCEPTED' } }),
    ).rejects.toThrow();
    await expect(s.prisma.attendanceEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(s.prisma.attendanceRecord.delete({ where: { id: event.recordId } })).rejects.toThrow();
    const owner = await s.db.psql('postgres', `UPDATE attendance_events SET latitude = NULL WHERE id = '${event.id}';`);
    expect(owner.output).toMatch(/append-only/);
    const truncate = await s.db.psql('postgres', 'TRUNCATE attendance_events CASCADE;');
    expect(truncate.output).toMatch(/append-only|cannot|rejected/);

    const nwProfile = await s.prisma.employeeProfile.findFirstOrThrow({ where: { organizationId: s.northwindId } });
    await expect(
      s.prisma.attendanceEvent.create({
        data: {
          organizationId: s.northwindId,
          recordId: event.recordId,
          profileId: nwProfile.id,
          kind: 'CHECK_IN',
          recordedAt: new Date(),
          workDate: new Date('2030-03-03T00:00:00.000Z'),
          mode: 'REMOTE',
          geofenceResult: 'NOT_REQUIRED',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow(/oreign key/);
    const demoShift = await s.prisma.shift.findFirstOrThrow({ where: { organizationId: s.demoId } });
    await expect(
      s.prisma.employeeShiftAssignment.create({
        data: {
          organizationId: s.northwindId,
          profileId: nwProfile.id,
          shiftId: demoShift.id,
          effectiveFrom: new Date('2031-01-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/oreign key/);
  });
});

describe('effects', () => {
  it('materializes approved leave on past and current days, blocks check-in, and reverts on cancellation', async () => {
    const employee = await actor('EMP-00010');
    const leaveTypeId = await typeId('leave');
    const created = await s.as(employee, () =>
      requests.create(
        employee,
        {
          requestTypeId: leaveTypeId,
          formData: { leaveType: 'annual', dates: { start: '2030-03-05', end: '2030-03-07' } },
          submit: true,
        },
        undefined,
      ),
    );
    await approvePending(created.id);
    const effect = await effectOf(created.id);
    expect(effect).toMatchObject({ mode: 'LEAVE', status: 'RECORDED' });

    at('2030-03-06T06:00:00.000Z');
    // Forged deliveries: an effect paired with another request, another organization's context, or a
    // revocation that never happened are rejected and write nothing.
    await expect(deliver('RECORDED', randomUUID(), effect.id)).rejects.toBeInstanceOf(AttendanceJobRejectedError);
    await expect(
      s.asSystem(s.northwindId, () => consumer.handle('RECORDED', created.id, effect.id, now)),
    ).rejects.toBeInstanceOf(AttendanceJobRejectedError);
    await expect(deliver('REVOKED', created.id, effect.id)).rejects.toBeInstanceOf(AttendanceJobRejectedError);
    expect(await s.prisma.attendanceEvent.count({ where: { requestEffectId: effect.id } })).toBe(0);

    const applied = await deliver('RECORDED', created.id, effect.id);
    expect(applied).toMatchObject({ outcome: 'APPLIED', dates: 2 });
    expect(await deliver('RECORDED', created.id, effect.id)).toMatchObject({ outcome: 'APPLIED', dates: 0 });
    expect((await recordOf('EMP-00010', '2030-03-05'))?.status).toBe('EXCUSED');
    expect((await recordOf('EMP-00010', '2030-03-06'))?.mode).toBe('LEAVE');
    // Future days are never materialized: they derive from the effect.
    expect(await recordOf('EMP-00010', '2030-03-07')).toBeNull();

    at('2030-03-06T07:00:00.000Z');
    await expect(checkIn(employee, ok(HQ))).rejects.toMatchObject({ code: 'ATTENDANCE_ON_LEAVE', status: 409 });
    expect(await s.as(employee, () => attendance.today(employee))).toMatchObject({
      plannedMode: 'LEAVE',
      nextAction: 'NONE',
      locationRequired: false,
    });

    await adminCancel(created.id);
    expect((await effectOf(created.id)).status).toBe('REVOKED');
    expect(await deliver('REVOKED', created.id, effect.id)).toMatchObject({ outcome: 'REVERTED', dates: 2 });
    expect(await deliver('REVOKED', created.id, effect.id)).toMatchObject({ outcome: 'REVERTED', dates: 0 });
    // A late RECORDED delivery after the revocation changes nothing.
    expect(await deliver('RECORDED', created.id, effect.id)).toMatchObject({ outcome: 'SKIPPED' });
    expect((await recordOf('EMP-00010', '2030-03-05'))?.status).toBe('ABSENT');
    const reopened = await checkIn(employee, ok(HQ));
    expect(reopened.record).toMatchObject({ workDate: '2030-03-06', status: 'OPEN' });
    const events = await s.prisma.attendanceEvent.findMany({
      where: { requestEffectId: effect.id },
      select: { kind: true },
    });
    expect(events.map((event) => event.kind).sort()).toEqual([
      'EFFECT_APPLIED',
      'EFFECT_APPLIED',
      'EFFECT_REVOKED',
      'EFFECT_REVOKED',
    ]);
  });

  it('records approved remote work without requiring or storing a location', async () => {
    const employee = await actor('EMP-00020');
    const wfhTypeId = await typeId('work_from_home');
    const wfh = await s.as(employee, () =>
      requests.create(
        employee,
        {
          requestTypeId: wfhTypeId,
          formData: { dates: { start: '2030-03-04', end: '2030-03-04' }, reason: 'Home office' },
          submit: true,
        },
        undefined,
      ),
    );
    await approvePending(wfh.id);
    at('2030-03-04T06:30:00.000Z');
    expect(await s.as(employee, () => attendance.today(employee))).toMatchObject({
      plannedMode: 'REMOTE',
      locationRequired: false,
    });
    at('2030-03-04T07:00:00.000Z');
    const result = await checkIn(employee, ok(FAR));
    expect(result.record.mode).toBe('REMOTE');
    expect(result.event).toMatchObject({ geofenceResult: 'NOT_REQUIRED', mode: 'REMOTE', hasCoordinates: false });
    const stored = await s.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: result.event.id } });
    expect(stored.latitude).toBeNull();
    expect(stored.longitude).toBeNull();
  });
});

describe('corrections', () => {
  it('runs an employee correction through approval, applies it once, and reverts it on cancellation', async () => {
    const employee = await actor('EMP-00009');
    at('2030-03-06T08:00:00.000Z');
    const input = {
      workDate: '2030-03-05',
      reasonCode: 'FORGOT_CHECK_IN',
      checkIn: '09:00',
      checkOut: '17:00',
      details: 'Phone battery was empty.',
    } as const;
    await expect(
      s.as(employee, () => corrections.submit(employee, { ...input, workDate: '2030-03-07' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(employee, () => corrections.submit(employee, { ...input, workDate: '2030-01-01' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(employee, () =>
        corrections.submit(employee, { workDate: '2030-03-05', reasonCode: 'FORGOT_CHECK_IN', details: 'x' }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const key = randomUUID();
    const submitted = await s.as(employee, () => corrections.submit(employee, input, key));
    expect(submitted).toMatchObject({
      status: 'PENDING',
      reasonCode: 'FORGOT_CHECK_IN',
      requestedCheckInAt: '2030-03-05T07:00:00.000Z',
      requestedCheckOutAt: '2030-03-05T15:00:00.000Z',
      originalCheckInAt: null,
    });
    expect((await s.as(employee, () => corrections.submit(employee, input, key))).id).toBe(submitted.id);
    await expect(
      s.as(employee, () => corrections.submit(employee, { ...input, reasonCode: 'SYSTEM_ISSUE' }, key)),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(s.as(employee, () => corrections.submit(employee, input))).rejects.toBeInstanceOf(ConflictError);
    const request = await s.prisma.requestInstance.findUniqueOrThrow({
      where: { id: submitted.request.id },
      select: { status: true, formData: true, requestType: { select: { key: true } } },
    });
    expect(request).toMatchObject({ status: 'PENDING_APPROVAL', requestType: { key: 'attendance_correction' } });
    expect(request.formData).toMatchObject({ reasonCode: 'forgot_check_in', workDate: '2030-03-05' });

    // Evidence is unchanged until the approved effect is applied by the worker.
    expect((await recordOf('EMP-00009', '2030-03-05'))?.checkInAt ?? null).toBeNull();
    await approvePending(submitted.request.id);
    const effect = await effectOf(submitted.request.id);
    expect(effect).toMatchObject({ mode: 'CORRECTION', status: 'RECORDED' });
    expect(await deliver('RECORDED', submitted.request.id, effect.id)).toMatchObject({ outcome: 'APPLIED', dates: 1 });
    expect(await deliver('RECORDED', submitted.request.id, effect.id)).toMatchObject({ outcome: 'SKIPPED' });
    const corrected = await recordOf('EMP-00009', '2030-03-05');
    expect(corrected).toMatchObject({ status: 'COMPLETE', adjusted: true, workedMinutes: 480 });
    expect(corrected?.checkInAt?.toISOString()).toBe('2030-03-05T07:00:00.000Z');
    const mine = await s.as(employee, () => corrections.listMine(employee, {}));
    expect(mine.items.find((item) => item.id === submitted.id)?.status).toBe('APPLIED');

    // The trusted adjustment row is immutable, even for the database owner.
    const tamper = await s.db.psql(
      'postgres',
      `UPDATE attendance_adjustment_requests SET requested_check_in_at = now() WHERE id = '${submitted.id}';`,
    );
    expect(tamper.output).toMatch(/cannot be changed/);

    await adminCancel(submitted.request.id);
    expect(await deliver('REVOKED', submitted.request.id, effect.id)).toMatchObject({ outcome: 'REVERTED', dates: 1 });
    expect(await deliver('REVOKED', submitted.request.id, effect.id)).toMatchObject({ outcome: 'SKIPPED' });
    const reverted = await recordOf('EMP-00009', '2030-03-05');
    expect(reverted).toMatchObject({ status: 'ABSENT', checkInAt: null, checkOutAt: null });
    const kinds = await s.prisma.attendanceEvent.findMany({
      where: { recordId: reverted?.id ?? '' },
      orderBy: { recordedAt: 'asc' },
      select: { kind: true },
    });
    expect(kinds.map((row) => row.kind)).toEqual(['ADJUSTED', 'ADJUSTMENT_REVERTED']);
  });

  it('lets HR correct directly with optimistic concurrency, never their own record, audited', async () => {
    const subject = await s.employee('EMP-00010');
    const self = await s.employee('EMP-00003');
    at('2030-03-06T08:00:00.000Z');
    const input = {
      profileId: subject.profileId,
      workDate: '2030-03-04',
      reasonCode: 'SYSTEM_ISSUE',
      checkIn: '09:00',
      checkOut: '17:00',
      note: 'Badge reader outage',
      version: null,
    } as const;
    await expect(s.as(lead, () => corrections.adminCorrect(lead, input))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(admin, () => corrections.adminCorrect(admin, input))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(hr, () => corrections.adminCorrect(hr, { ...input, profileId: self.profileId })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(hr, () => corrections.adminCorrect(hr, { ...input, workDate: '2030-03-07' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(foreign, () => corrections.adminCorrect(foreign, input))).rejects.toBeInstanceOf(ForbiddenError);
    // A forged profile id from another organization is unknown here.
    const northwindProfile = await s.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: s.northwindId },
      select: { id: true },
    });
    await expect(
      s.as(hr, () => corrections.adminCorrect(hr, { ...input, profileId: northwindProfile.id })),
    ).rejects.toBeInstanceOf(NotFoundError);

    const first = await s.as(hr, () => corrections.adminCorrect(hr, input));
    expect(first.record).toMatchObject({ status: 'COMPLETE', adjusted: true, checkInAt: '2030-03-04T07:00:00.000Z' });
    await expect(s.as(hr, () => corrections.adminCorrect(hr, input))).rejects.toBeInstanceOf(VersionConflictError);
    const second = await s.as(hr, () =>
      corrections.adminCorrect(hr, {
        ...input,
        reasonCode: 'INCORRECT_TIME',
        checkOut: '18:00',
        version: first.record.version,
      }),
    );
    expect(second.record.checkOutAt).toBe('2030-03-04T16:00:00.000Z');
    expect(second.events.filter((event) => event.kind === 'ADJUSTED')).toHaveLength(2);
    expect(second.events[0]?.actor).not.toBeNull();
    const audits = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, action: 'attendance.record.corrected', entityId: first.record.id },
    });
    expect(audits).toHaveLength(2);
  });
});

describe('missing checkout', () => {
  it('flags an open record once after the deadline, without inventing a check-out, and notifies once', async () => {
    const employee = await actor('EMP-00016');
    at('2030-03-04T07:00:00.000Z');
    const started = await checkIn(employee, ok(HQ));
    // The deadline is the scheduled end (15:00Z) plus the policy's 240 minutes.
    at('2030-03-04T18:59:00.000Z');
    await s.asSystem(s.demoId, () => sweep.run(now));
    expect((await recordOf('EMP-00016', '2030-03-04'))?.status).toBe('OPEN');
    at('2030-03-04T19:01:00.000Z');
    await expect(checkOut(employee, ok(HQ))).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_CHECKED_IN' });
    const first = await s.asSystem(s.demoId, () => sweep.run(now));
    expect(first.flagged).toBeGreaterThanOrEqual(1);
    const flagged = await recordOf('EMP-00016', '2030-03-04');
    expect(flagged).toMatchObject({ status: 'MISSING_CHECKOUT', checkOutAt: null });
    const second = await s.asSystem(s.demoId, () => sweep.run(now));
    expect(second.flagged).toBe(0);
    expect(
      await s.prisma.attendanceEvent.count({ where: { recordId: started.record.id, kind: 'SYSTEM_MISSING_CHECKOUT' } }),
    ).toBe(1);
    const notices = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, aggregateId: started.record.id, eventType: 'notification.requested' },
      select: { payload: true },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      type: 'ATTENDANCE_MISSING_CHECKOUT',
      dedupeKey: `attendance-missing:${started.record.id}`,
    });
    // Another organization's sweep never touches this record.
    await s.asSystem(s.northwindId, () => sweep.run(now));
    expect(await s.prisma.attendanceEvent.count({ where: { recordId: started.record.id } })).toBe(2);
  });

  it('lets a check-in after the deadline be checked out; the grace then runs from the check-in', async () => {
    const employee = await actor('EMP-00016');
    // Past the scheduled end (15:00Z) plus 240 minutes, so the day's usual deadline is already over.
    at('2030-03-05T19:20:00.000Z');
    const started = await checkIn(employee, ok(HQ));
    expect(started.record.status).toBe('OPEN');
    at('2030-03-05T23:19:00.000Z');
    await s.asSystem(s.demoId, () => sweep.run(now));
    expect((await recordOf('EMP-00016', '2030-03-05'))?.status).toBe('OPEN');
    const out = await checkOut(employee, ok(HQ));
    expect(out.record).toMatchObject({ status: 'COMPLETE', checkOutAt: '2030-03-05T23:19:00.000Z' });
    expect(
      await s.prisma.attendanceEvent.count({ where: { recordId: started.record.id, kind: 'SYSTEM_MISSING_CHECKOUT' } }),
    ).toBe(0);
  });
});

describe('export and retention', () => {
  it('exports records in scope as bounded, formula-safe CSV without coordinates, audited', async () => {
    at('2030-03-06T08:00:00.000Z');
    const subject = await s.employee('EMP-00011');
    const original = await s.prisma.employeeProfile.findUniqueOrThrow({
      where: { id: subject.profileId },
      select: { fullName: true },
    });
    await s.prisma.employeeProfile.update({
      where: { id: subject.profileId },
      data: { fullName: '=HYPERLINK("http://x")' },
    });
    try {
      const file = await s.as(lead, () => attendance.exportCsv(lead, { from: '2030-03-01', to: '2030-03-31' }));
      const [header = '', ...rows] = file.csv.trim().split('\r\n');
      expect(header).toContain('employee_number');
      expect(header).not.toMatch(/latitude|longitude|ip|agent/);
      expect(file.csv).toContain('EMP-00009');
      expect(file.csv).not.toContain('EMP-00014');
      expect(file.csv).toContain(`"'=HYPERLINK(""http://x"")"`);
      expect(rows.length).toBe(file.rows);
      const everyone = await s.as(hr, () => attendance.exportCsv(hr, { from: '2030-03-01', to: '2030-03-31' }));
      expect(everyone.csv).toContain('EMP-00014');
    } finally {
      await s.prisma.employeeProfile.update({
        where: { id: subject.profileId },
        data: { fullName: original.fullName },
      });
    }
    await expect(
      s.as(hr, () => attendance.exportCsv(hr, { from: '2030-01-01', to: '2030-03-31' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const colleague = await actor('EMP-00010');
    await expect(
      s.as(colleague, () => attendance.exportCsv(colleague, { from: '2030-03-01', to: '2030-03-31' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.prisma.auditLog.count({ where: { organizationId: s.demoId, action: 'attendance.exported' } })).toBe(
      2,
    );
  });

  it('clears aged coordinates under an explicit policy only, keeping the evidence and audit history', async () => {
    const retention = new RetentionPolicyService(s.tenantDb, s.tenant);
    const errors: unknown[] = [];
    const purger = new RetentionPurger(s.prisma, s.tenantDb, s.tenant, (_organizationId, error) => errors.push(error));
    const employee = await actor('EMP-00019');
    at('2026-01-15T08:00:00.000Z');
    const old = await checkIn(employee, ok(HQ));
    at('2030-03-06T08:00:00.000Z');

    // Without a policy nothing is purged; another organization's policy never reaches this one.
    await s.prisma.retentionPolicy.create({
      data: {
        organizationId: s.northwindId,
        category: 'ATTENDANCE_COORDINATES',
        retainDays: 30,
        action: 'NULL_COORDINATES',
      },
    });
    await purger.purgeAll(500);
    expect(errors).toEqual([]);
    expect((await s.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: old.event.id } })).latitude).not.toBeNull();

    await expect(
      s.as(admin, () => retention.set(admin, 'ATTENDANCE_COORDINATES', { retainDays: 7, version: null })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(hr, () => retention.set(hr, 'ATTENDANCE_COORDINATES', { retainDays: 30, version: null })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const preview = await s.as(admin, () => retention.preview(admin, 'ATTENDANCE_COORDINATES', 30));
    expect(preview.eligible).toBeGreaterThanOrEqual(1);
    await s.as(admin, () => retention.set(admin, 'ATTENDANCE_COORDINATES', { retainDays: 30, version: null }));
    const totals = await purger.purgeAll(500);
    expect(errors).toEqual([]);
    expect(totals.purged).toBeGreaterThanOrEqual(1);
    const purged = await s.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: old.event.id } });
    expect(purged).toMatchObject({ latitude: null, longitude: null, geofenceResult: 'INSIDE' });
    expect(purged.distanceMeters).not.toBeNull();
    // Recent (here: future-dated) evidence keeps its coordinates.
    expect(
      await s.prisma.attendanceEvent.count({
        where: {
          organizationId: s.demoId,
          recordedAt: { gt: new Date('2030-01-01T00:00:00.000Z') },
          latitude: { not: null },
        },
      }),
    ).toBeGreaterThan(0);
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, action: 'retention.records_purged', entityId: 'ATTENDANCE_COORDINATES' },
      }),
    ).toBe(1);
    // The runtime role cannot clear coordinates outside the retention function.
    const direct = await s.db.psql(
      'ops_app',
      `UPDATE attendance_events SET latitude = NULL WHERE id = '${old.event.id}';`,
    );
    expect(direct.output).toMatch(/permission denied|append-only/);
  });
});
