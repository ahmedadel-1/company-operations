import { zonedInstant } from './time.js';

/**
 * Derived attendance state (ADR-0022). `deriveRecord` folds a record's append-only events with its
 * shift snapshot and the request effects active on its date. Pure and deterministic: the same inputs
 * always rebuild the same state, so records can be recomputed from evidence at any time.
 */

export type AttendanceMode = 'OFFICE' | 'SITE' | 'REMOTE' | 'BUSINESS_MISSION' | 'LEAVE';
export type RecordStatus = 'OPEN' | 'COMPLETE' | 'MISSING_CHECKOUT' | 'EXCUSED' | 'ABSENT' | 'SCHEDULED';
export type EventKind =
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'ADJUSTED'
  | 'ADJUSTMENT_REVERTED'
  | 'SYSTEM_MISSING_CHECKOUT'
  | 'EFFECT_APPLIED'
  | 'EFFECT_REVOKED';
export type ReviewStatus = 'NOT_REQUIRED' | 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED';
export type EffectMode = 'LEAVE' | 'REMOTE' | 'BUSINESS_MISSION' | 'SHORT_LEAVE';

export interface DerivationEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly recordedAt: Date;
  readonly effectiveAt: Date | null;
  readonly mode: AttendanceMode | null;
  readonly workLocationId: string | null;
  readonly reviewStatus: ReviewStatus;
  readonly adjustmentId: string | null;
  readonly previousCheckInAt: Date | null;
  readonly previousCheckOutAt: Date | null;
  readonly adjustedCheckInAt: Date | null;
  readonly adjustedCheckOutAt: Date | null;
}

/** An approved (RECORDED) attendance effect covering the record's date. */
export interface ActiveEffect {
  readonly mode: EffectMode;
  readonly requestId: string;
  /** SHORT_LEAVE window in local minutes; null = the whole day. */
  readonly startsAtMinute: number | null;
  readonly endsAtMinute: number | null;
}

export interface DerivationInput {
  readonly workDate: string;
  readonly timeZone: string;
  /** Today's local date in the record's zone (future days are never absent). */
  readonly today: string;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  readonly lateGraceMinutes: number | null;
  readonly earlyLeaveGraceMinutes: number | null;
  /** Ordered by recorded time, then id. */
  readonly events: readonly DerivationEvent[];
  readonly effects: readonly ActiveEffect[];
}

export interface DerivedRecord {
  readonly status: RecordStatus;
  readonly mode: AttendanceMode | null;
  readonly checkInAt: Date | null;
  readonly checkOutAt: Date | null;
  readonly checkInLocationId: string | null;
  readonly checkOutLocationId: string | null;
  readonly lateMinutes: number;
  readonly earlyLeaveMinutes: number;
  readonly workedMinutes: number | null;
  readonly needsReview: boolean;
  readonly adjusted: boolean;
  readonly missingCheckoutAt: Date | null;
  readonly sourceRequestId: string | null;
}

const MINUTE_MS = 60_000;

/** Effect precedence for the record's mode and source request. */
const EFFECT_ORDER: readonly EffectMode[] = ['LEAVE', 'BUSINESS_MISSION', 'REMOTE', 'SHORT_LEAVE'];

export function primaryEffect(effects: readonly ActiveEffect[]): ActiveEffect | null {
  for (const mode of EFFECT_ORDER) {
    const match = effects
      .filter((effect) => effect.mode === mode)
      .sort((left, right) => (left.requestId < right.requestId ? -1 : 1))[0];
    if (match !== undefined) return match;
  }
  return null;
}

interface AdjustmentTrace {
  readonly setIn: boolean;
  readonly setOut: boolean;
  readonly previousIn: Date | null;
  readonly previousOut: Date | null;
}

export function deriveRecord(input: DerivationInput): DerivedRecord {
  let checkInAt: Date | null = null;
  let checkOutAt: Date | null = null;
  let checkInLocationId: string | null = null;
  let checkOutLocationId: string | null = null;
  let presenceMode: AttendanceMode | null = null;
  let adjusted = false;
  let missingCheckoutAt: Date | null = null;
  let rejectedReview = false;
  let pendingReview = false;
  const adjustments = new Map<string, AdjustmentTrace>();

  for (const event of input.events) {
    if (event.reviewStatus === 'PENDING_REVIEW') pendingReview = true;
    if (event.reviewStatus === 'REJECTED') rejectedReview = true;
    switch (event.kind) {
      case 'CHECK_IN':
        checkInAt = event.effectiveAt ?? event.recordedAt;
        checkInLocationId = event.workLocationId;
        presenceMode = event.mode;
        break;
      case 'CHECK_OUT':
        checkOutAt = event.effectiveAt ?? event.recordedAt;
        checkOutLocationId = event.workLocationId;
        break;
      case 'ADJUSTED':
        if (event.adjustmentId !== null) {
          adjustments.set(event.adjustmentId, {
            setIn: event.adjustedCheckInAt !== null,
            setOut: event.adjustedCheckOutAt !== null,
            previousIn: event.previousCheckInAt,
            previousOut: event.previousCheckOutAt,
          });
        }
        if (event.adjustedCheckInAt !== null) checkInAt = event.adjustedCheckInAt;
        if (event.adjustedCheckOutAt !== null) checkOutAt = event.adjustedCheckOutAt;
        presenceMode ??= event.mode;
        adjusted = true;
        // A correction supersedes a rejected review: the evidence was re-decided by an approver/admin.
        rejectedReview = false;
        break;
      case 'ADJUSTMENT_REVERTED': {
        const trace = event.adjustmentId === null ? undefined : adjustments.get(event.adjustmentId);
        if (trace !== undefined) {
          if (trace.setIn) checkInAt = trace.previousIn;
          if (trace.setOut) checkOutAt = trace.previousOut;
        }
        break;
      }
      case 'SYSTEM_MISSING_CHECKOUT':
        missingCheckoutAt ??= event.recordedAt;
        break;
      case 'EFFECT_APPLIED':
      case 'EFFECT_REVOKED':
        break;
    }
  }
  if (checkInAt === null) {
    checkOutAt = null;
    checkOutLocationId = null;
  } else if (checkOutAt !== null && checkOutAt.getTime() < checkInAt.getTime()) {
    checkOutAt = null;
    checkOutLocationId = null;
  }

  const effect = primaryEffect(input.effects);
  const fullDayLeave = input.effects.some((item) => item.mode === 'LEAVE');
  const mission = input.effects.some((item) => item.mode === 'BUSINESS_MISSION');

  let status: RecordStatus;
  if (checkInAt !== null && checkOutAt !== null) status = 'COMPLETE';
  else if (checkInAt !== null) status = missingCheckoutAt === null ? 'OPEN' : 'MISSING_CHECKOUT';
  else if (fullDayLeave || mission) status = 'EXCUSED';
  else status = input.workDate < input.today ? 'ABSENT' : 'SCHEDULED';

  let mode: AttendanceMode | null = presenceMode;
  if (mode === null && effect !== null && effect.mode !== 'SHORT_LEAVE') {
    mode = effect.mode;
  }

  const { lateMinutes, earlyLeaveMinutes } = lateness(input, checkInAt, checkOutAt, fullDayLeave);
  const workedMinutes =
    checkInAt !== null && checkOutAt !== null
      ? Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / MINUTE_MS)
      : null;

  return {
    status,
    mode,
    checkInAt,
    checkOutAt,
    checkInLocationId,
    checkOutLocationId,
    lateMinutes,
    earlyLeaveMinutes,
    workedMinutes,
    needsReview: pendingReview || rejectedReview,
    adjusted,
    missingCheckoutAt: checkOutAt === null ? missingCheckoutAt : null,
    sourceRequestId: effect?.requestId ?? null,
  };
}

/**
 * Late and early-leave minutes against the snapshot only (never the current shift). A short permission
 * window that starts at or before the late threshold moves it to the window end; one that ends at or
 * after the early threshold moves it to the window start. A short permission without a window, or a
 * full-day leave, excuses both.
 */
export function lateness(
  input: Pick<
    DerivationInput,
    | 'workDate'
    | 'timeZone'
    | 'scheduledStartAt'
    | 'scheduledEndAt'
    | 'lateGraceMinutes'
    | 'earlyLeaveGraceMinutes'
    | 'effects'
  >,
  checkInAt: Date | null,
  checkOutAt: Date | null,
  fullDayLeave: boolean,
): { lateMinutes: number; earlyLeaveMinutes: number } {
  if (input.scheduledStartAt === null || input.scheduledEndAt === null || fullDayLeave) {
    return { lateMinutes: 0, earlyLeaveMinutes: 0 };
  }
  const shortLeaves = input.effects.filter((effect) => effect.mode === 'SHORT_LEAVE');
  if (shortLeaves.some((effect) => effect.startsAtMinute === null || effect.endsAtMinute === null)) {
    return { lateMinutes: 0, earlyLeaveMinutes: 0 };
  }
  const windows = shortLeaves.map((effect) => ({
    start: zonedInstant(input.workDate, effect.startsAtMinute ?? 0, input.timeZone).getTime(),
    end: zonedInstant(input.workDate, effect.endsAtMinute ?? 0, input.timeZone).getTime(),
  }));

  let lateThreshold = input.scheduledStartAt.getTime() + (input.lateGraceMinutes ?? 0) * MINUTE_MS;
  for (const window of windows) {
    if (window.start <= lateThreshold) lateThreshold = Math.max(lateThreshold, window.end);
  }
  let earlyThreshold = input.scheduledEndAt.getTime() - (input.earlyLeaveGraceMinutes ?? 0) * MINUTE_MS;
  for (const window of windows) {
    if (window.end >= earlyThreshold) earlyThreshold = Math.min(earlyThreshold, window.start);
  }
  const lateMinutes =
    checkInAt === null ? 0 : Math.max(0, Math.floor((checkInAt.getTime() - lateThreshold) / MINUTE_MS));
  const earlyLeaveMinutes =
    checkOutAt === null ? 0 : Math.max(0, Math.floor((earlyThreshold - checkOutAt.getTime()) / MINUTE_MS));
  return { lateMinutes, earlyLeaveMinutes };
}

// ---- Day status (views) ----

export type DayStatus =
  | 'CHECKED_IN'
  | 'COMPLETE'
  | 'MISSING_CHECKOUT'
  | 'ABSENT'
  | 'NOT_STARTED'
  | 'ON_LEAVE'
  | 'ON_MISSION'
  | 'OFF_DAY'
  | 'NO_SCHEDULE'
  | 'UPCOMING';

export interface DayStatusInput {
  readonly date: string;
  readonly today: string;
  readonly now: Date;
  readonly record: { readonly status: RecordStatus } | null;
  readonly effects: readonly ActiveEffect[];
  /** Null when no assignment covers the date. */
  readonly shift: { readonly runsThatDay: boolean; readonly scheduledEnd: Date | null } | null;
}

/**
 * The status shown for one employee and day, with or without a stored record. Future days are
 * `UPCOMING` and never absent; today is `NOT_STARTED` until the scheduled end has passed.
 */
export function dayStatus(input: DayStatusInput): DayStatus {
  const record = input.record;
  if (record !== null) {
    if (record.status === 'OPEN') return 'CHECKED_IN';
    if (record.status === 'COMPLETE') return 'COMPLETE';
    if (record.status === 'MISSING_CHECKOUT') return 'MISSING_CHECKOUT';
  }
  if (input.effects.some((effect) => effect.mode === 'LEAVE')) return 'ON_LEAVE';
  if (input.effects.some((effect) => effect.mode === 'BUSINESS_MISSION')) return 'ON_MISSION';
  if (input.date > input.today) return 'UPCOMING';
  if (input.shift === null) return 'NO_SCHEDULE';
  if (!input.shift.runsThatDay) return 'OFF_DAY';
  if (input.date === input.today) {
    const end = input.shift.scheduledEnd;
    if (end === null || input.now.getTime() < end.getTime()) return 'NOT_STARTED';
  }
  return 'ABSENT';
}

/** Dashboard attendance buckets (ADR-0023). */
export type DayBucket =
  'PRESENT' | 'REMOTE' | 'ON_LEAVE' | 'ON_MISSION' | 'LATE' | 'NOT_CHECKED_IN' | 'MISSING_CHECKOUT';

export const DAY_BUCKETS: readonly DayBucket[] = [
  'PRESENT',
  'REMOTE',
  'ON_LEAVE',
  'ON_MISSION',
  'LATE',
  'NOT_CHECKED_IN',
  'MISSING_CHECKOUT',
];

/**
 * The buckets one employee-day counts in. Present = a check-in exists (open, complete or missing
 * check-out); remote and late are subsets of present; not checked in = scheduled to work and
 * neither present, on leave nor on a mission (before or after the shift end).
 */
export function dayBuckets(
  status: DayStatus,
  record: { readonly mode: AttendanceMode | null; readonly lateMinutes: number } | null,
): DayBucket[] {
  switch (status) {
    case 'CHECKED_IN':
    case 'COMPLETE':
    case 'MISSING_CHECKOUT': {
      const buckets: DayBucket[] = ['PRESENT'];
      if (record?.mode === 'REMOTE') buckets.push('REMOTE');
      if ((record?.lateMinutes ?? 0) > 0) buckets.push('LATE');
      if (status === 'MISSING_CHECKOUT') buckets.push('MISSING_CHECKOUT');
      return buckets;
    }
    case 'ON_LEAVE':
      return ['ON_LEAVE'];
    case 'ON_MISSION':
      return ['ON_MISSION'];
    case 'NOT_STARTED':
    case 'ABSENT':
      return ['NOT_CHECKED_IN'];
    case 'OFF_DAY':
    case 'NO_SCHEDULE':
    case 'UPCOMING':
      return [];
  }
}
