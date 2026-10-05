import { addDays, isoWeekday, localMoment } from '../projects/business-date.js';

/**
 * SLA clocks (DATA_MODEL §5, ADR-0018). All inputs and outputs are UTC instants; local wall time is
 * derived from an IANA zone with `Intl` (never the server's zone). A business clock only advances
 * inside the calendar's working windows; a wall clock always advances. Working windows are converted
 * to instants per local date, so a window on a daylight-saving transition day is correspondingly
 * shorter or longer in real time.
 */

export interface WorkingWindow {
  /** Minutes since local midnight; `end` may be 1440 (24:00). */
  readonly start: number;
  readonly end: number;
}

export interface BusinessCalendarSpec {
  readonly timeZone: string;
  /** ISO weekday (1 = Monday ... 7 = Sunday) -> window; weekdays without an entry are closed. */
  readonly windows: ReadonlyMap<number, WorkingWindow>;
  /** Local dates (`YYYY-MM-DD`) without working hours. */
  readonly holidays: ReadonlySet<string>;
}

export type SlaClock =
  { readonly kind: 'wall' } | { readonly kind: 'business'; readonly calendar: BusinessCalendarSpec };

export const WALL_CLOCK: SlaClock = Object.freeze({ kind: 'wall' });

/** Upper bound on the days a business-clock computation walks (about 30 years). */
const MAX_DAYS = 11_000;
const DAY_MS = 86_400_000;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (local = UTC + offset). */
function offsetMs(instant: number, timeZone: string): number {
  const local = localMoment(new Date(instant), timeZone);
  const localAsUtc = Date.parse(`${local.date}T00:00:00.000Z`) + local.minutes * 60_000;
  // Minute precision: drop the seconds of `instant` so the difference is a whole number of minutes.
  return localAsUtc - (instant - (instant % 60_000));
}

/**
 * The UTC instant of a local wall time. In an overlap (clocks set back) the earlier instant is
 * returned; in a gap (clocks set forward) the wall time does not exist and the instant is moved
 * forward by the gap (e.g. 02:30 becomes 03:30).
 */
export function zonedTimeToUtc(date: string, minutes: number, timeZone: string): Date {
  const wall = Date.parse(`${date}T00:00:00.000Z`) + minutes * 60_000;
  const offsets = [...new Set([offsetMs(wall - DAY_MS, timeZone), offsetMs(wall + DAY_MS, timeZone)])];
  const valid = offsets
    .map((offset) => wall - offset)
    .filter((instant) => wall - instant === offsetMs(instant, timeZone));
  if (valid.length > 0) {
    return new Date(Math.min(...valid));
  }
  return new Date(wall - Math.min(...offsets));
}

function windowOn(calendar: BusinessCalendarSpec, date: string): { start: number; end: number } | null {
  if (calendar.holidays.has(date)) {
    return null;
  }
  const window = calendar.windows.get(isoWeekday(date));
  if (window === undefined || window.end <= window.start) {
    return null;
  }
  return {
    start: zonedTimeToUtc(date, window.start, calendar.timeZone).getTime(),
    end: zonedTimeToUtc(date, window.end, calendar.timeZone).getTime(),
  };
}

/** True when the calendar has at least one working window (otherwise a business clock never moves). */
export function hasWorkingTime(calendar: BusinessCalendarSpec): boolean {
  return [...calendar.windows.values()].some((window) => window.end > window.start);
}

/** The instant at which `seconds` of clock time have elapsed after `start`. */
export function addClockSeconds(start: Date, seconds: number, clock: SlaClock): Date {
  const wanted = Math.max(0, Math.round(seconds * 1000));
  if (clock.kind === 'wall') {
    return new Date(start.getTime() + wanted);
  }
  const { calendar } = clock;
  if (!hasWorkingTime(calendar)) {
    throw new RangeError('The business calendar has no working hours.');
  }
  let remaining = wanted;
  let cursor = start.getTime();
  // Start one local day earlier: a window of the previous local date can end after `start`.
  let date = addDays(localMoment(start, calendar.timeZone).date, -1);
  for (let day = 0; day < MAX_DAYS; day += 1) {
    const window = windowOn(calendar, date);
    if (window !== null && window.end > cursor) {
      const from = Math.max(window.start, cursor);
      const available = window.end - from;
      if (remaining <= available) {
        return new Date(from + remaining);
      }
      remaining -= available;
      cursor = window.end;
    }
    date = addDays(date, 1);
  }
  return new Date(cursor + remaining);
}

/** Clock time (whole seconds) elapsed between two instants; 0 when `to` is not after `from`. */
export function clockSecondsBetween(from: Date, to: Date, clock: SlaClock): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) {
    return 0;
  }
  if (clock.kind === 'wall') {
    return Math.floor((end - start) / 1000);
  }
  const { calendar } = clock;
  let total = 0;
  let date = addDays(localMoment(from, calendar.timeZone).date, -1);
  const last = addDays(localMoment(to, calendar.timeZone).date, 1);
  for (let day = 0; day < MAX_DAYS && date <= last; day += 1) {
    const window = windowOn(calendar, date);
    if (window !== null) {
      const overlap = Math.min(window.end, end) - Math.max(window.start, start);
      if (overlap > 0) {
        total += overlap;
      }
    }
    date = addDays(date, 1);
  }
  return Math.floor(total / 1000);
}
