import type { ProjectRole, ProjectStatus } from '@company-ops/db';

import { addDays, isoWeekday, localMoment, minutesOf } from './business-date.js';
import { effectiveWeekdays } from './daily-report-policy.js';
import type { DailyReportPolicy } from './daily-report-policy.js';

/** Statuses in which a project expects daily reports (and accepts new ones). */
export const REPORTING_STATUSES: readonly ProjectStatus[] = ['ACTIVE', 'MAINTENANCE'];

export interface ExpectedReporter {
  readonly profileId: string;
  readonly memberId: string;
  readonly fullName: string;
  readonly projectRole: ProjectRole;
  /** Membership dates (`YYYY-MM-DD`). */
  readonly startDate: string;
  readonly endDate: string | null;
  /** Active membership and employment; disabled, invited, on-leave or terminated people are not expected. */
  readonly active: boolean;
}

export interface MissingReportInput {
  readonly status: ProjectStatus;
  readonly projectStartDate: string | null;
  readonly policy: DailyReportPolicy;
  readonly workWeek: readonly number[];
  readonly timeZone: string;
  readonly now: Date;
  readonly reporters: readonly ExpectedReporter[];
  /** Submitted reports as `${profileId}|${reportDate}`. */
  readonly submitted: ReadonlySet<string>;
  /** Inclusive date range (`YYYY-MM-DD`) in the project's zone; dates after today are ignored. */
  readonly from: string;
  readonly to: string;
}

export interface MissingReport {
  readonly date: string;
  readonly reporter: ExpectedReporter;
}

export interface MissingReportResult {
  /** Today's date in the project's zone. */
  readonly today: string;
  /** Expected reports that were not submitted: past dates, and today once the due time has passed. */
  readonly missing: readonly MissingReport[];
  /** Today's expected reports that are not submitted yet but not due yet either. */
  readonly pendingToday: readonly MissingReport[];
}

export const submittedKey = (profileId: string, date: string): string => `${profileId}|${date}`;

/**
 * Derives missing daily reports (DATA_MODEL §4: computed, never stored). A report is expected for
 * every reporter whose project role is listed in the policy, on every policy weekday, from the later
 * of the project start and the membership start until the membership end, while the project is in a
 * reporting status. The project's current status applies to the whole range (status history is not
 * kept). Pure function: no I/O, no clock other than `now`.
 */
export function computeMissingReports(input: MissingReportInput): MissingReportResult {
  const { date: today, minutes: nowMinutes } = localMoment(input.now, input.timeZone);
  const empty = { today, missing: [], pendingToday: [] };
  if (!input.policy.required || !REPORTING_STATUSES.includes(input.status)) {
    return empty;
  }
  const weekdays = effectiveWeekdays(input.policy, input.workWeek);
  const roles = new Set(input.policy.reporterRoles);
  const reporters = input.reporters.filter((reporter) => reporter.active && roles.has(reporter.projectRole));
  if (reporters.length === 0 || weekdays.size === 0) {
    return empty;
  }
  const start =
    input.projectStartDate !== null && input.projectStartDate > input.from ? input.projectStartDate : input.from;
  const end = input.to < today ? input.to : today;
  const dueMinutes = minutesOf(input.policy.dueLocalTime);
  const missing: MissingReport[] = [];
  const pendingToday: MissingReport[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (!weekdays.has(isoWeekday(date))) {
      continue;
    }
    for (const reporter of reporters) {
      if (reporter.startDate > date || (reporter.endDate !== null && reporter.endDate < date)) {
        continue;
      }
      if (input.submitted.has(submittedKey(reporter.profileId, date))) {
        continue;
      }
      if (date < today || nowMinutes >= dueMinutes) {
        missing.push({ date, reporter });
      } else {
        pendingToday.push({ date, reporter });
      }
    }
  }
  missing.sort((a, b) =>
    a.date === b.date ? a.reporter.fullName.localeCompare(b.reporter.fullName) : a.date < b.date ? 1 : -1,
  );
  return { today, missing, pendingToday };
}
