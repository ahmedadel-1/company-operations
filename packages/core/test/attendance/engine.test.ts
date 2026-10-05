import { describe, expect, it } from 'vitest';

import { ATTENDANCE_CORRECTION_TYPE_KEY } from '@company-ops/validation';

import { correctedTimes, correctionStatus } from '../../src/modules/attendance/attendance-correction.service.js';
import { correctionTypeContent } from '../../src/modules/attendance/correction-type.js';
import { dayStatus, deriveRecord, primaryEffect } from '../../src/modules/attendance/engine/derive.js';
import type { ActiveEffect, DerivationEvent, DerivationInput } from '../../src/modules/attendance/engine/derive.js';
import { evaluateGeofence, haversineMeters, roundCoordinate } from '../../src/modules/attendance/engine/geofence.js';
import type { GeofenceLocation } from '../../src/modules/attendance/engine/geofence.js';
import {
  correctedInstant,
  missingCheckoutDeadline,
  resolveWorkDate,
  scheduleFor,
  shiftRunsOn,
  zonedInstant,
} from '../../src/modules/attendance/engine/time.js';
import type { ShiftDefinition } from '../../src/modules/attendance/engine/time.js';
import { workflowPublishIssues } from '../../src/modules/requests/engine/workflow.js';

const RIYADH = 'Asia/Riyadh';
const NEW_YORK = 'America/New_York';
const iso = (value: string): Date => new Date(value);

const office: GeofenceLocation = {
  id: 'loc-a',
  latitude: 24.7136,
  longitude: 46.6753,
  radiusMeters: 100,
  type: 'OFFICE',
};
/** ~50 m north of the office (1e-5 degrees of latitude ≈ 1.11 m). */
const nearOffice = { latitude: 24.71405, longitude: 46.6753 };

describe('geofence', () => {
  it('computes great-circle distances in meters', () => {
    expect(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111_195, 0);
    expect(haversineMeters(office, office)).toBe(0);
  });

  it('rounds stored coordinates to five decimals', () => {
    expect(roundCoordinate(24.7136789)).toBe(24.71368);
    expect(roundCoordinate(-46.000004)).toBe(-46);
  });

  it('is INSIDE within the radius when accuracy is good enough', () => {
    const result = evaluateGeofence({ ...nearOffice, accuracy: 19.2 }, [office], 100);
    expect(result.result).toBe('INSIDE');
    expect(result.location?.id).toBe('loc-a');
    expect(result.distanceMeters).toBeGreaterThanOrEqual(49);
    expect(result.distanceMeters).toBeLessThanOrEqual(51);
    expect(result.accuracyMeters).toBe(20);
  });

  it('never reports LOW_ACCURACY positions as INSIDE, even within the radius', () => {
    const result = evaluateGeofence({ ...nearOffice, accuracy: 100.4 }, [office], 100);
    expect(result.result).toBe('LOW_ACCURACY');
    expect(result.location?.id).toBe('loc-a');
    expect(result.accuracyMeters).toBe(101);
  });

  it('is OUTSIDE against the nearest location beyond every radius', () => {
    const far: GeofenceLocation = { ...office, id: 'loc-far', latitude: 25.5 };
    const result = evaluateGeofence({ latitude: 24.7226, longitude: 46.6753, accuracy: 10 }, [far, office], 100);
    expect(result.result).toBe('OUTSIDE');
    expect(result.location?.id).toBe('loc-a');
    expect(result.distanceMeters).toBeGreaterThan(900);
  });

  it('matches the nearest containing location and handles an empty list', () => {
    const wide: GeofenceLocation = { ...office, id: 'loc-wide', latitude: 24.7142, radiusMeters: 500 };
    expect(evaluateGeofence({ ...nearOffice, accuracy: 5 }, [office, wide], 100).location?.id).toBe('loc-wide');
    expect(evaluateGeofence({ ...nearOffice, accuracy: 5 }, [], 100)).toEqual({
      result: 'OUTSIDE',
      location: null,
      distanceMeters: null,
      accuracyMeters: 5,
    });
  });
});

describe('time zones and DST', () => {
  it('maps wall times to instants in fixed and DST zones', () => {
    expect(zonedInstant('2026-10-04', 9 * 60, RIYADH).toISOString()).toBe('2026-10-04T06:00:00.000Z');
    expect(zonedInstant('2026-07-01', 9 * 60, NEW_YORK).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedInstant('2026-12-01', 9 * 60, NEW_YORK).toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });

  it('shifts spring-forward gap times forward and picks the earlier fall-back instant', () => {
    // 2026-03-08 02:30 does not exist in New York → 03:30 EDT.
    expect(zonedInstant('2026-03-08', 150, NEW_YORK).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // 2026-11-01 01:30 happens twice → the first (EDT) occurrence.
    expect(zonedInstant('2026-11-01', 90, NEW_YORK).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  const night: ShiftDefinition = {
    shiftId: 'night',
    name: 'Night',
    startMinute: 22 * 60,
    endMinute: 6 * 60,
    crossesMidnight: true,
    lateGraceMinutes: 10,
    earlyLeaveGraceMinutes: 0,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  };
  const day: ShiftDefinition = {
    ...night,
    shiftId: 'day',
    name: 'Day',
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    crossesMidnight: false,
    weekdays: [1, 2, 3, 4, 5],
  };

  it('ends overnight shifts on the next local day, across a DST change', () => {
    const fallBack = scheduleFor(night, '2026-10-31', NEW_YORK);
    expect(fallBack.start.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(fallBack.end.toISOString()).toBe('2026-11-01T11:00:00.000Z');
    expect((fallBack.end.getTime() - fallBack.start.getTime()) / 3_600_000).toBe(9);
    const springForward = scheduleFor(night, '2026-03-07', NEW_YORK);
    expect((springForward.end.getTime() - springForward.start.getTime()) / 3_600_000).toBe(7);
  });

  it('runs shifts on their ISO weekdays only', () => {
    expect(shiftRunsOn(day, '2026-10-04')).toBe(false); // Sunday
    expect(shiftRunsOn(day, '2026-10-05')).toBe(true); // Monday
  });

  it('assigns early-morning check-ins to the overnight shift that started yesterday', () => {
    const lookup = (date: string) => (date === '2026-10-04' || date === '2026-10-05' ? night : null);
    // 06:30 local, 30 minutes after the shift ended and inside the 240-minute window.
    expect(resolveWorkDate(iso('2026-10-05T03:30:00Z'), RIYADH, lookup, 240)).toBe('2026-10-04');
    // 10:30 local: the window has closed.
    expect(resolveWorkDate(iso('2026-10-05T07:30:00Z'), RIYADH, lookup, 240)).toBe('2026-10-05');
    expect(resolveWorkDate(iso('2026-10-05T03:30:00Z'), RIYADH, () => day, 240)).toBe('2026-10-05');
  });

  it('computes missing-checkout deadlines from the scheduled end or the end of the local day', () => {
    const end = iso('2026-10-04T14:00:00Z');
    expect(missingCheckoutDeadline('2026-10-04', RIYADH, end, 240, null).toISOString()).toBe(
      '2026-10-04T18:00:00.000Z',
    );
    expect(missingCheckoutDeadline('2026-10-04', RIYADH, end, 240, iso('2026-10-04T06:00:00Z')).toISOString()).toBe(
      '2026-10-04T18:00:00.000Z',
    );
    expect(missingCheckoutDeadline('2026-10-04', RIYADH, null, 60, null).toISOString()).toBe(
      '2026-10-04T22:00:00.000Z',
    );
  });

  it('starts the grace from a check-in later than the scheduled end, so a late check-in can be checked out', () => {
    expect(
      missingCheckoutDeadline('2026-10-04', RIYADH, iso('2026-10-04T14:00:00Z'), 240, iso('2026-10-04T18:20:00Z')),
    ).toEqual(iso('2026-10-04T22:20:00Z'));
    expect(missingCheckoutDeadline('2026-10-04', RIYADH, null, 60, iso('2026-10-04T21:30:00Z'))).toEqual(
      iso('2026-10-04T22:30:00Z'),
    );
  });

  it('builds corrected instants on the work date or the next day', () => {
    expect(correctedInstant('2026-10-04', '22:15', false, RIYADH).toISOString()).toBe('2026-10-04T19:15:00.000Z');
    expect(correctedInstant('2026-10-04', '06:05', true, RIYADH).toISOString()).toBe('2026-10-05T03:05:00.000Z');
  });
});

let sequence = 0;
function event(kind: DerivationEvent['kind'], at: string, extra: Partial<DerivationEvent> = {}): DerivationEvent {
  sequence += 1;
  return {
    id: `evt-${String(sequence).padStart(4, '0')}`,
    kind,
    recordedAt: iso(at),
    effectiveAt: null,
    mode: kind === 'CHECK_IN' ? 'OFFICE' : null,
    workLocationId: kind === 'CHECK_IN' || kind === 'CHECK_OUT' ? 'loc-a' : null,
    reviewStatus: 'NOT_REQUIRED',
    adjustmentId: null,
    previousCheckInAt: null,
    previousCheckOutAt: null,
    adjustedCheckInAt: null,
    adjustedCheckOutAt: null,
    ...extra,
  };
}

const baseInput: DerivationInput = {
  workDate: '2026-10-04',
  timeZone: RIYADH,
  today: '2026-10-04',
  scheduledStartAt: iso('2026-10-04T06:00:00Z'), // 09:00 local
  scheduledEndAt: iso('2026-10-04T14:00:00Z'), // 17:00 local
  lateGraceMinutes: 15,
  earlyLeaveGraceMinutes: 0,
  events: [],
  effects: [],
};
const leave: ActiveEffect = { mode: 'LEAVE', requestId: 'req-leave', startsAtMinute: null, endsAtMinute: null };

describe('record derivation', () => {
  it('never marks today or future days absent without evidence', () => {
    expect(deriveRecord(baseInput).status).toBe('SCHEDULED');
    expect(deriveRecord({ ...baseInput, workDate: '2026-10-05' }).status).toBe('SCHEDULED');
    expect(deriveRecord({ ...baseInput, workDate: '2026-10-03' }).status).toBe('ABSENT');
  });

  it('excuses leave and mission days and records their source request', () => {
    const derived = deriveRecord({ ...baseInput, workDate: '2026-10-03', effects: [leave] });
    expect(derived).toMatchObject({ status: 'EXCUSED', mode: 'LEAVE', sourceRequestId: 'req-leave' });
    const mission: ActiveEffect = { ...leave, mode: 'BUSINESS_MISSION', requestId: 'req-m' };
    expect(deriveRecord({ ...baseInput, effects: [mission] })).toMatchObject({
      status: 'EXCUSED',
      mode: 'BUSINESS_MISSION',
    });
    expect(primaryEffect([mission, leave])?.mode).toBe('LEAVE');
  });

  it('stores lateness and early leave after grace', () => {
    const derived = deriveRecord({
      ...baseInput,
      events: [event('CHECK_IN', '2026-10-04T06:20:00Z'), event('CHECK_OUT', '2026-10-04T13:50:00Z')],
    });
    expect(derived).toMatchObject({ status: 'COMPLETE', lateMinutes: 5, earlyLeaveMinutes: 10, workedMinutes: 450 });
    const onTime = deriveRecord({ ...baseInput, events: [event('CHECK_IN', '2026-10-04T06:15:00Z')] });
    expect(onTime).toMatchObject({ status: 'OPEN', lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: null });
  });

  it('moves the late and early thresholds for approved short permissions', () => {
    const morning: ActiveEffect = {
      mode: 'SHORT_LEAVE',
      requestId: 'req-s',
      startsAtMinute: 9 * 60,
      endsAtMinute: 11 * 60,
    };
    const afternoon: ActiveEffect = { ...morning, startsAtMinute: 15 * 60, endsAtMinute: 17 * 60 };
    const events = [event('CHECK_IN', '2026-10-04T07:30:00Z'), event('CHECK_OUT', '2026-10-04T12:30:00Z')];
    expect(deriveRecord({ ...baseInput, events, effects: [morning] })).toMatchObject({
      lateMinutes: 0,
      earlyLeaveMinutes: 90,
    });
    expect(deriveRecord({ ...baseInput, events, effects: [afternoon] })).toMatchObject({
      lateMinutes: 75,
      earlyLeaveMinutes: 0,
    });
    const unbounded: ActiveEffect = { ...morning, startsAtMinute: null, endsAtMinute: null };
    expect(deriveRecord({ ...baseInput, events, effects: [unbounded] })).toMatchObject({
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    });
    // Short permissions never set the mode of a day the employee was present.
    expect(deriveRecord({ ...baseInput, events, effects: [morning] }).mode).toBe('OFFICE');
  });

  it('marks missing check-out without inventing a check-out time', () => {
    const derived = deriveRecord({
      ...baseInput,
      events: [event('CHECK_IN', '2026-10-04T06:00:00Z'), event('SYSTEM_MISSING_CHECKOUT', '2026-10-04T18:00:00Z')],
    });
    expect(derived).toMatchObject({ status: 'MISSING_CHECKOUT', checkOutAt: null, workedMinutes: null });
    expect(derived.missingCheckoutAt?.toISOString()).toBe('2026-10-04T18:00:00.000Z');
  });

  it('applies and reverts adjustments while keeping the original evidence', () => {
    const checkIn = event('CHECK_IN', '2026-10-04T06:00:00Z');
    const adjusted = event('ADJUSTED', '2026-10-05T08:00:00Z', {
      adjustmentId: 'adj-1',
      previousCheckInAt: iso('2026-10-04T06:00:00Z'),
      adjustedCheckOutAt: iso('2026-10-04T14:00:00Z'),
    });
    const applied = deriveRecord({ ...baseInput, today: '2026-10-05', events: [checkIn, adjusted] });
    expect(applied).toMatchObject({ status: 'COMPLETE', adjusted: true, workedMinutes: 480 });
    const reverted = deriveRecord({
      ...baseInput,
      today: '2026-10-05',
      events: [checkIn, adjusted, event('ADJUSTMENT_REVERTED', '2026-10-05T09:00:00Z', { adjustmentId: 'adj-1' })],
    });
    expect(reverted).toMatchObject({ status: 'OPEN', checkOutAt: null });
    expect(reverted.checkInAt?.toISOString()).toBe('2026-10-04T06:00:00.000Z');
  });

  it('flags pending and rejected evidence for review until a correction re-decides it', () => {
    const pending = event('CHECK_IN', '2026-10-04T06:00:00Z', { reviewStatus: 'PENDING_REVIEW' });
    expect(deriveRecord({ ...baseInput, events: [pending] }).needsReview).toBe(true);
    const rejected = { ...pending, reviewStatus: 'REJECTED' as const };
    expect(deriveRecord({ ...baseInput, events: [rejected] }).needsReview).toBe(true);
    const fixed = event('ADJUSTED', '2026-10-04T15:00:00Z', { adjustedCheckOutAt: iso('2026-10-04T14:00:00Z') });
    expect(deriveRecord({ ...baseInput, events: [rejected, fixed] }).needsReview).toBe(false);
  });

  it('ignores a check-out without a check-in and one before the check-in', () => {
    expect(deriveRecord({ ...baseInput, events: [event('CHECK_OUT', '2026-10-04T14:00:00Z')] }).status).toBe(
      'SCHEDULED',
    );
    const backwards = deriveRecord({
      ...baseInput,
      events: [
        event('CHECK_IN', '2026-10-04T08:00:00Z'),
        event('CHECK_OUT', '2026-10-04T09:00:00Z', { effectiveAt: iso('2026-10-04T07:00:00Z') }),
      ],
    });
    expect(backwards).toMatchObject({ status: 'OPEN', checkOutAt: null });
  });
});

describe('day status', () => {
  const now = iso('2026-10-04T10:00:00Z'); // 13:00 Riyadh
  const shift = { runsThatDay: true, scheduledEnd: iso('2026-10-04T14:00:00Z') };
  const base = { date: '2026-10-04', today: '2026-10-04', now, record: null, effects: [], shift };

  it('reports future days as upcoming, never absent', () => {
    expect(dayStatus({ ...base, date: '2026-10-06', shift: null })).toBe('UPCOMING');
    expect(dayStatus({ ...base, date: '2026-10-06' })).toBe('UPCOMING');
  });

  it('waits for the scheduled end before marking today absent', () => {
    expect(dayStatus(base)).toBe('NOT_STARTED');
    expect(dayStatus({ ...base, now: iso('2026-10-04T15:00:00Z') })).toBe('ABSENT');
  });

  it('distinguishes records, leave, off days and missing schedules', () => {
    expect(dayStatus({ ...base, record: { status: 'OPEN' } })).toBe('CHECKED_IN');
    expect(dayStatus({ ...base, record: { status: 'MISSING_CHECKOUT' } })).toBe('MISSING_CHECKOUT');
    expect(dayStatus({ ...base, effects: [leave] })).toBe('ON_LEAVE');
    expect(dayStatus({ ...base, date: '2026-10-03', shift: { runsThatDay: false, scheduledEnd: null } })).toBe(
      'OFF_DAY',
    );
    expect(dayStatus({ ...base, date: '2026-10-03', shift: null })).toBe('NO_SCHEDULE');
    expect(dayStatus({ ...base, date: '2026-10-03' })).toBe('ABSENT');
  });
});

describe('corrections', () => {
  const later = iso('2026-10-10T00:00:00Z');

  it('takes a check-out at or before the check-in as the next day', () => {
    const times = correctedTimes('2026-10-04', RIYADH, { checkIn: '22:00', checkOut: '06:00' }, null, later);
    expect(times.checkInAt?.toISOString()).toBe('2026-10-04T19:00:00.000Z');
    expect(times.checkOutAt?.toISOString()).toBe('2026-10-05T03:00:00.000Z');
  });

  it('rejects future, orphaned and backwards corrections', () => {
    expect(() => correctedTimes('2026-10-04', RIYADH, { checkIn: '09:00' }, null, iso('2026-10-04T05:00:00Z'))).toThrow(
      /future/,
    );
    expect(() => correctedTimes('2026-10-04', RIYADH, { checkOut: '17:00' }, null, later)).toThrow(/needs a check-in/);
    expect(() =>
      correctedTimes(
        '2026-10-04',
        RIYADH,
        { checkIn: '17:00', checkOut: '09:00', checkOutNextDay: false },
        null,
        later,
      ),
    ).toThrow(/after the check-in/);
    expect(() => correctedTimes('2026-10-04', RIYADH, {}, null, later)).toThrow(/required/);
  });

  it('validates a single corrected time against the existing record', () => {
    const existing = { checkInAt: iso('2026-10-04T06:00:00Z'), checkOutAt: null };
    const times = correctedTimes('2026-10-04', RIYADH, { checkOut: '17:30' }, existing, later);
    expect(times).toEqual({ checkInAt: null, checkOutAt: iso('2026-10-04T14:30:00Z') });
    expect(() =>
      correctedTimes('2026-10-04', RIYADH, { checkOut: '08:00', checkOutNextDay: false }, existing, later),
    ).toThrow(/after the check-in/);
  });

  it('derives the correction status from the adjustment and its request', () => {
    const row = { appliedAt: null, revertedAt: null, request: { status: 'IN_REVIEW' } };
    expect(correctionStatus(row)).toBe('PENDING');
    expect(correctionStatus({ ...row, request: { status: 'REJECTED' } })).toBe('REJECTED');
    expect(correctionStatus({ ...row, appliedAt: later })).toBe('APPLIED');
    expect(correctionStatus({ ...row, appliedAt: later, revertedAt: later })).toBe('REVERTED');
  });

  it('keeps the reserved correction type publishable only under its reserved key', () => {
    const content = correctionTypeContent();
    expect(workflowPublishIssues(content, ATTENDANCE_CORRECTION_TYPE_KEY)).toEqual([]);
    expect(workflowPublishIssues(content, 'my_type')).toContainEqual({
      path: 'effects.attendance.mode',
      code: 'reserved',
    });
    const broken = {
      ...content,
      form: { ...content.form, fields: content.form.fields.filter((f) => f.key !== 'checkIn') },
    };
    expect(workflowPublishIssues(broken, ATTENDANCE_CORRECTION_TYPE_KEY)).toContainEqual({
      path: 'form.fields.checkIn',
      code: 'invalid',
    });
  });
});
