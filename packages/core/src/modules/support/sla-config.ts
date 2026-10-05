import type { ProjectRole, TicketPriority, TicketSeverity, TicketStatus } from '@company-ops/db';

import { minutesOf } from '../projects/business-date.js';
import { PROJECT_ROLES } from '../projects/daily-report-policy.js';
import type { BusinessCalendarSpec, SlaClock, WorkingWindow } from './sla-clock.js';
import { WALL_CLOCK } from './sla-clock.js';

/**
 * Parsers for the JSON columns of SLA policies, escalation rules and business calendars. Values are
 * validated by the API before they are stored; parsing again here keeps a tampered or legacy row
 * from widening a match or crashing the SLA worker (unknown entries are dropped).
 */

export const TICKET_SEVERITIES: readonly TicketSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ['P1', 'P2', 'P3', 'P4'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function listOf<T extends string>(value: unknown, allowed: (item: string) => item is T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === 'string').filter(allowed))];
}

const isSeverity = (value: string): value is TicketSeverity => (TICKET_SEVERITIES as readonly string[]).includes(value);
const isPriority = (value: string): value is TicketPriority => (TICKET_PRIORITIES as readonly string[]).includes(value);
const isUuid = (value: string): value is string => UUID.test(value);
const isProjectRole = (value: string): value is ProjectRole => (PROJECT_ROLES as readonly string[]).includes(value);
const isRoleKey = (value: string): value is string => /^[A-Z][A-Z0-9_]{1,63}$/.test(value);

/** `{ severities?, priorities?, projectIds?, categoryIds? }`; an empty list matches anything. */
export interface TicketMatch {
  readonly severities: readonly TicketSeverity[];
  readonly priorities: readonly TicketPriority[];
  readonly projectIds: readonly string[];
  readonly categoryIds: readonly string[];
}

export function parseTicketMatch(value: unknown): TicketMatch {
  const record = isRecord(value) ? value : {};
  return {
    severities: listOf(record.severities, isSeverity),
    priorities: listOf(record.priorities, isPriority),
    projectIds: listOf(record.projectIds, isUuid),
    categoryIds: listOf(record.categoryIds, isUuid),
  };
}

export interface MatchableTicket {
  readonly severity: TicketSeverity;
  readonly priority: TicketPriority;
  readonly projectId: string | null;
  readonly categoryId: string | null;
}

const fits = <T>(allowed: readonly T[], value: T | null): boolean =>
  allowed.length === 0 || (value !== null && allowed.includes(value));

export function matchesTicket(match: TicketMatch, ticket: MatchableTicket): boolean {
  return (
    fits(match.severities, ticket.severity) &&
    fits(match.priorities, ticket.priority) &&
    fits(match.projectIds, ticket.projectId) &&
    fits(match.categoryIds, ticket.categoryId)
  );
}

export function ticketMatchJson(match: TicketMatch): Record<string, string[]> {
  return {
    severities: [...match.severities],
    priorities: [...match.priorities],
    projectIds: [...match.projectIds],
    categoryIds: [...match.categoryIds],
  };
}

/** Escalation recipients: system role keys, project roles of the ticket's project, explicit members. */
export interface EscalationNotify {
  readonly roles: readonly string[];
  readonly projectRoles: readonly ProjectRole[];
  readonly memberIds: readonly string[];
}

export function parseEscalationNotify(value: unknown): EscalationNotify {
  const record = isRecord(value) ? value : {};
  return {
    roles: listOf(record.roles, isRoleKey),
    projectRoles: listOf(record.projectRoles, isProjectRole),
    memberIds: listOf(record.memberIds, isUuid),
  };
}

export interface WorkingHoursEntry {
  readonly weekday: number;
  readonly start: string;
  readonly end: string;
}

export function parseWorkingHours(value: unknown): WorkingHoursEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byDay = new Map<number, WorkingHoursEntry>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { weekday, start, end } = entry;
    if (
      typeof weekday === 'number' &&
      Number.isInteger(weekday) &&
      weekday >= 1 &&
      weekday <= 7 &&
      typeof start === 'string' &&
      typeof end === 'string' &&
      LOCAL_TIME.test(start) &&
      LOCAL_TIME.test(end) &&
      minutesOf(end) > minutesOf(start)
    ) {
      byDay.set(weekday, { weekday, start, end });
    }
  }
  return [...byDay.values()].sort((a, b) => a.weekday - b.weekday);
}

export function parseHolidays(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && LOCAL_DATE.test(item)))].sort();
}

export function calendarSpec(
  row: { readonly workingHours: unknown; readonly holidays: unknown },
  timeZone: string,
): BusinessCalendarSpec {
  const windows = new Map<number, WorkingWindow>();
  for (const entry of parseWorkingHours(row.workingHours)) {
    windows.set(entry.weekday, { start: minutesOf(entry.start), end: minutesOf(entry.end) });
  }
  return { timeZone, windows, holidays: new Set(parseHolidays(row.holidays)) };
}

/** The policy fields the SLA clock needs, loaded with its calendar. */
export interface SlaPolicyRow {
  readonly id: string;
  readonly name: string;
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
  readonly atRiskThresholdPercent: number;
  readonly businessHoursOnly: boolean;
  readonly pauseStatuses: readonly TicketStatus[];
  readonly businessCalendar: {
    readonly timeZone: string | null;
    readonly workingHours: unknown;
    readonly holidays: unknown;
  } | null;
}

export interface SlaPolicyClock {
  readonly id: string;
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
  readonly atRiskThresholdPercent: number;
  readonly pauseStatuses: readonly TicketStatus[];
  readonly clock: SlaClock;
}

/**
 * Builds the policy clock. A business calendar without its own zone uses `fallbackTimeZone` (the
 * ticket's project zone, else the organization's). A business-hours policy whose calendar has no
 * working hours falls back to the wall clock rather than never becoming due.
 */
export function policyClock(policy: SlaPolicyRow, fallbackTimeZone: string): SlaPolicyClock {
  let clock: SlaClock = WALL_CLOCK;
  if (policy.businessHoursOnly && policy.businessCalendar !== null) {
    const spec = calendarSpec(policy.businessCalendar, policy.businessCalendar.timeZone ?? fallbackTimeZone);
    if (spec.windows.size > 0) {
      clock = { kind: 'business', calendar: spec };
    }
  }
  return {
    id: policy.id,
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    atRiskThresholdPercent: policy.atRiskThresholdPercent,
    pauseStatuses: policy.pauseStatuses,
    clock,
  };
}
