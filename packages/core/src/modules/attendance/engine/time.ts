import { addDays, isoWeekday, localMoment, localToday } from '../../projects/business-date.js';

/**
 * Wall-clock ↔ instant conversion for attendance (ADR-0022). Calendar dates are `YYYY-MM-DD` in an IANA
 * zone; times are minutes since local midnight.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Offset of `timeZone` from UTC at `instantMs`, in minutes (local − UTC). */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const local = localMoment(new Date(instantMs), timeZone);
  const asUtc = Date.parse(`${local.date}T00:00:00.000Z`) + local.minutes * MINUTE_MS;
  const truncated = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

function isWallTime(instantMs: number, date: string, minutes: number, timeZone: string): boolean {
  const local = localMoment(new Date(instantMs), timeZone);
  return local.date === date && local.minutes === minutes;
}

/**
 * The instant at which the wall clock in `timeZone` shows `minutes` on `date` (TC39 Temporal
 * `compatible` disambiguation): in a fall-back overlap the earlier instant; in a spring-forward gap the
 * time is shifted forward by the gap length (02:30 in a 02:00–03:00 gap → 03:30).
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const naive = Date.parse(`${date}T00:00:00.000Z`) + minutes * MINUTE_MS;
  const before = offsetMinutes(naive - DAY_MS, timeZone);
  const after = offsetMinutes(naive + DAY_MS, timeZone);
  const early = naive - before * MINUTE_MS;
  const late = naive - after * MINUTE_MS;
  const earlyValid = isWallTime(early, date, minutes, timeZone);
  const lateValid = isWallTime(late, date, minutes, timeZone);
  if (earlyValid && lateValid) return new Date(Math.min(early, late));
  if (earlyValid) return new Date(early);
  if (lateValid) return new Date(late);
  // Gap: the offset before the transition maps the wall time to the instant after the gap.
  return new Date(early);
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function parseLocalTime(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The shift context a record snapshots when it is created. */
export interface ShiftSnapshot {
  readonly shiftId: string | null;
  readonly name: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly crossesMidnight: boolean;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveGraceMinutes: number;
}

export interface ShiftDefinition extends ShiftSnapshot {
  readonly weekdays: readonly number[];
}

export interface Schedule {
  readonly start: Date;
  readonly end: Date;
}

/** Scheduled start and end instants of a shift on `workDate` (overnight shifts end the next local day). */
export function scheduleFor(snapshot: ShiftSnapshot, workDate: string, timeZone: string): Schedule {
  const start = zonedInstant(workDate, snapshot.startMinute, timeZone);
  const endDate = snapshot.crossesMidnight ? addDays(workDate, 1) : workDate;
  return { start, end: zonedInstant(endDate, snapshot.endMinute, timeZone) };
}

/** The shift that applies on a date: an assignment covers it and the shift runs on that weekday. */
export type ShiftLookup = (date: string) => ShiftDefinition | null;

export function shiftRunsOn(shift: ShiftDefinition, date: string): boolean {
  return shift.weekdays.includes(isoWeekday(date));
}

/** How long before the scheduled start a check-in already counts for that shift day. */
export const EARLY_CHECK_IN_MINUTES = 4 * 60;

/**
 * The work date a check-in at `now` belongs to. An overnight shift that started yesterday owns the
 * check-in while its window (scheduled end + `missingCheckoutAfterMinutes`) is open and today's shift
 * window has not started; otherwise the local calendar date.
 */
export function resolveWorkDate(
  now: Date,
  timeZone: string,
  shiftOn: ShiftLookup,
  missingCheckoutAfterMinutes: number,
): string {
  const today = localToday(now, timeZone);
  const yesterday = addDays(today, -1);
  const previous = shiftOn(yesterday);
  if (previous?.crossesMidnight === true) {
    const window = scheduleFor(previous, yesterday, timeZone);
    const closes = window.end.getTime() + missingCheckoutAfterMinutes * MINUTE_MS;
    const current = shiftOn(today);
    const todayOpens =
      current === null
        ? Number.POSITIVE_INFINITY
        : scheduleFor(current, today, timeZone).start.getTime() - EARLY_CHECK_IN_MINUTES * MINUTE_MS;
    if (now.getTime() < closes && now.getTime() < todayOpens) {
      return yesterday;
    }
  }
  return today;
}

/**
 * When an open record counts as missing its checkout: scheduled end + grace, or (without a shift) the
 * end of the local work day + grace. A check-in later than that base starts the grace from the
 * check-in, so a late check-in can always be checked out (the check-out and the sweep share this rule).
 */
export function missingCheckoutDeadline(
  workDate: string,
  timeZone: string,
  scheduledEnd: Date | null,
  missingCheckoutAfterMinutes: number,
  checkInAt: Date | null,
): Date {
  const end = (scheduledEnd ?? zonedInstant(addDays(workDate, 1), 0, timeZone)).getTime();
  const base = checkInAt === null ? end : Math.max(end, checkInAt.getTime());
  return new Date(base + missingCheckoutAfterMinutes * MINUTE_MS);
}

/**
 * A corrected local time on the work date (or the next day for overnight check-outs) as an instant.
 */
export function correctedInstant(workDate: string, localTime: string, nextDay: boolean, timeZone: string): Date {
  return zonedInstant(nextDay ? addDays(workDate, 1) : workDate, parseLocalTime(localTime), timeZone);
}
