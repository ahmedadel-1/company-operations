/**
 * Business dates (ARCHITECTURE §16): calendar dates are computed in the organization's or project's
 * IANA time zone from UTC instants, never from the server's local zone. Dates are `YYYY-MM-DD`
 * strings; arithmetic on them is done in UTC, where every day has exactly 24 hours.
 */

export interface LocalMoment {
  /** Calendar date in the zone (`YYYY-MM-DD`). */
  readonly date: string;
  /** Minutes since local midnight (0-1439). */
  readonly minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date and wall-clock minute of `instant` in `timeZone`. */
export function localMoment(instant: Date, timeZone: string): LocalMoment {
  const parts = new Map(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.get('hour'));
  const minute = Number(parts.get('minute'));
  return {
    date: `${String(parts.get('year'))}-${String(parts.get('month'))}-${String(parts.get('day'))}`,
    minutes: hour * 60 + minute,
  };
}

/** Today's date in `timeZone`. */
export function localToday(now: Date, timeZone: string): string {
  return localMoment(now, timeZone).date;
}

const toUtcDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

export function addDays(date: string, days: number): string {
  const value = toUtcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = toUtcDate(date).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000);
}

/** `HH:MM` (24 h) as minutes since midnight. */
export function minutesOf(localTime: string): number {
  const [hours = '0', minutes = '0'] = localTime.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export const toDateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export const fromDateOnly = (value: string): Date => toUtcDate(value);
