import { zonedInstant } from '../../attendance/engine/time.js';
import { addDays, localToday } from '../../projects/business-date.js';

/** Bounded trend ranges (ADR-0023); there are no free-form ranges. */
export type TrendRange = 'today' | '7d' | '30d' | '90d';

export const RANGE_DAYS: Readonly<Record<TrendRange, number>> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

/** Local dates of a range ending today, oldest first. */
export function rangeDates(range: TrendRange, today: string): string[] {
  const days = RANGE_DAYS[range];
  return Array.from({ length: days }, (_, index) => addDays(today, index - days + 1));
}

/** The instants `[start, end)` of one local calendar date (DST-safe: a 23 h or 25 h day stays one bucket). */
export function localDayWindow(date: string, timeZone: string): { readonly start: Date; readonly end: Date } {
  return { start: zonedInstant(date, 0, timeZone), end: zonedInstant(addDays(date, 1), 0, timeZone) };
}

export interface RangeWindow {
  readonly dates: readonly string[];
  readonly start: Date;
  readonly end: Date;
}

/** A range's local dates plus the instants that cover them, in the given zone. */
export function rangeWindow(range: TrendRange, now: Date, timeZone: string): RangeWindow {
  const dates = rangeDates(range, localToday(now, timeZone));
  const first = dates[0] ?? localToday(now, timeZone);
  const last = dates.at(-1) ?? first;
  return { dates, start: localDayWindow(first, timeZone).start, end: localDayWindow(last, timeZone).end };
}

/** Counts instants per local date of `dates` (zero-filled); instants outside the dates are ignored. */
export function bucketInstants(instants: readonly Date[], dates: readonly string[], timeZone: string): number[] {
  return bucketDates(
    instants.map((instant) => localToday(instant, timeZone)),
    dates,
  );
}

/** Counts `YYYY-MM-DD` values per date of `dates` (zero-filled). */
export function bucketDates(values: readonly string[], dates: readonly string[]): number[] {
  const index = new Map(dates.map((date, position) => [date, position]));
  const counts = dates.map(() => 0);
  for (const value of values) {
    const position = index.get(value);
    if (position !== undefined) {
      counts[position] = (counts[position] ?? 0) + 1;
    }
  }
  return counts;
}
