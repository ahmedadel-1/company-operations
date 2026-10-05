import { zonedInstant } from '../../attendance/engine/time.js';
import { addDays, daysBetween } from '../../projects/business-date.js';

/**
 * Commercial date rules (ADR-0026). Legal dates are `YYYY-MM-DD` strings compared with the
 * organization's local "today"; reminder instants are 09:00 local time in the organization's zone
 * (DST-safe through `zonedInstant`). Host-local time is never used.
 */

/** Look-ahead windows of the derived EXPIRING states and the dashboard metrics. */
export const CONTRACT_EXPIRING_DAYS = 90;
export const DOCUMENT_EXPIRING_DAYS = 30;
export const GUARANTEE_EXPIRING_DAYS = 30;
export const NOTICE_APPROACHING_DAYS = 30;
export const RENEWAL_DECISION_WINDOW_DAYS = 90;
export const REMINDER_LOCAL_MINUTE = 9 * 60;

export const DEFAULT_REMINDER_DAYS = {
  documentReminderDays: [180, 90, 60, 30, 14, 7, 1],
  contractReminderDays: [180, 90, 60, 30, 14, 7],
  guaranteeReminderDays: [90, 60, 30, 14, 7, 1],
  obligationReminderDays: [7, 1, 0],
  tenderReminderDays: [14, 7, 3, 1],
} as const satisfies Record<string, readonly number[]>;

export type ReminderSetting = keyof typeof DEFAULT_REMINDER_DAYS;

/**
 * Renewal notice deadline = current expiry minus the notice period in calendar days
 * (31 Dec 2027 - 90 days = 2 Oct 2027). Null without an expiry or a notice period.
 */
export function noticeDeadline(expiryDate: string | null, noticePeriodDays: number | null): string | null {
  if (expiryDate === null || noticePeriodDays === null) return null;
  return addDays(expiryDate, -noticePeriodDays);
}

export type DocumentValidity = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NO_EXPIRY' | 'NO_VERSION';

export function documentValidity(currentVersion: number, expiryDate: string | null, today: string): DocumentValidity {
  if (currentVersion === 0) return 'NO_VERSION';
  if (expiryDate === null) return 'NO_EXPIRY';
  if (expiryDate < today) return 'EXPIRED';
  return daysBetween(today, expiryDate) <= DOCUMENT_EXPIRING_DAYS ? 'EXPIRING' : 'VALID';
}

/** Whether a version is valid on a calendar date (null when it has no expiry or no date is known). */
export function validOn(
  version: { readonly validFrom: string | null; readonly expiryDate: string | null },
  date: string | null,
): boolean | null {
  if (date === null || version.expiryDate === null) return null;
  if (version.validFrom !== null && version.validFrom > date) return false;
  return version.expiryDate >= date;
}

/** Derived guarantee status: ACTIVE inside the window becomes EXPIRING; a passed expiry is EXPIRED. */
export function guaranteeStatus(
  status: 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'CANCELLED',
  expiryDate: string,
  today: string,
): 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'RELEASED' | 'CANCELLED' {
  if (status !== 'ACTIVE') return status;
  if (expiryDate < today) return 'EXPIRED';
  return daysBetween(today, expiryDate) <= GUARANTEE_EXPIRING_DAYS ? 'EXPIRING' : 'ACTIVE';
}

/**
 * The reminder threshold that is due now for a dated subject, or null. A threshold `t` is due from
 * 09:00 local time on `date - t` days; the smallest due threshold wins, so a monitor that was down
 * for days sends one reminder, not every threshold it missed. Past the date nothing is due here
 * (overdue/expired notices are separate kinds with threshold 0).
 */
export function dueReminderThreshold(
  date: string,
  thresholds: readonly number[],
  now: Date,
  timeZone: string,
): number | null {
  const sorted = [...new Set(thresholds)].sort((a, b) => a - b);
  for (const threshold of sorted) {
    const at = zonedInstant(addDays(date, -threshold), REMINDER_LOCAL_MINUTE, timeZone);
    if (now.getTime() >= at.getTime()) {
      const end = zonedInstant(addDays(date, 1), 0, timeZone);
      return now.getTime() < end.getTime() ? threshold : null;
    }
  }
  return null;
}

/** The instant a tender deadline reminder threshold (days before the deadline instant) is due. */
export function deadlineReminderThreshold(deadline: Date, thresholds: readonly number[], now: Date): number | null {
  if (now.getTime() >= deadline.getTime()) return null;
  const sorted = [...new Set(thresholds)].sort((a, b) => a - b);
  for (const threshold of sorted) {
    if (deadline.getTime() - now.getTime() <= threshold * 86_400_000) return threshold;
  }
  return null;
}
