import type { ProjectRole } from '@company-ops/db';

/**
 * A project's daily-report policy (`projects.daily_report_policy`, DATA_MODEL §4). Input is
 * validated by the API schema; stored values are re-checked here so a malformed row never makes
 * reports "required" by accident.
 */
export interface DailyReportPolicy {
  readonly required: boolean;
  /** ISO weekdays reports are expected on; empty = the organization's work week. */
  readonly weekdays: readonly number[];
  /** Local time (`HH:MM`, project zone) after which today's report counts as missing. */
  readonly dueLocalTime: string;
  /** Project roles whose members must report. */
  readonly reporterRoles: readonly ProjectRole[];
}

export const PROJECT_ROLES: readonly ProjectRole[] = [
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'DEVELOPER',
  'SUPPORT',
  'FIELD',
  'QA',
  'OBSERVER',
];

export const DEFAULT_DAILY_REPORT_POLICY: DailyReportPolicy = Object.freeze({
  required: false,
  weekdays: [],
  dueLocalTime: '18:00',
  reporterRoles: ['FIELD'] satisfies ProjectRole[],
});

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isProjectRole = (value: unknown): value is ProjectRole =>
  typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);

/** Parses a stored policy; anything malformed falls back to "not required". */
export function parseDailyReportPolicy(value: unknown): DailyReportPolicy {
  if (!isRecord(value)) {
    return DEFAULT_DAILY_REPORT_POLICY;
  }
  const { required, weekdays, dueLocalTime, reporterRoles } = value;
  if (
    typeof required !== 'boolean' ||
    !Array.isArray(weekdays) ||
    !weekdays.every((day): day is number => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7) ||
    typeof dueLocalTime !== 'string' ||
    !LOCAL_TIME.test(dueLocalTime) ||
    !Array.isArray(reporterRoles) ||
    !reporterRoles.every(isProjectRole)
  ) {
    return DEFAULT_DAILY_REPORT_POLICY;
  }
  return {
    required,
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    dueLocalTime,
    reporterRoles: [...new Set(reporterRoles)],
  };
}

/** The weekdays reports are expected on, falling back to the organization's work week. */
export function effectiveWeekdays(policy: DailyReportPolicy, workWeek: readonly number[]): ReadonlySet<number> {
  return new Set(policy.weekdays.length > 0 ? policy.weekdays : workWeek);
}
