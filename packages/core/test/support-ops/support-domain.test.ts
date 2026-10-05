import { describe, expect, it } from 'vitest';

import type { TicketStatus } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

import { escapeHtml, renderNotificationEmail } from '../../src/modules/notifications/email-templates.js';
import {
  addClockSeconds,
  clockSecondsBetween,
  WALL_CLOCK,
  zonedTimeToUtc,
} from '../../src/modules/support/sla-clock.js';
import type { BusinessCalendarSpec, SlaClock } from '../../src/modules/support/sla-clock.js';
import {
  matchesTicket,
  parseEscalationNotify,
  parseTicketMatch,
  parseWorkingHours,
  policyClock,
} from '../../src/modules/support/sla-config.js';
import type { SlaPolicyClock } from '../../src/modules/support/sla-config.js';
import {
  applyStatusChange,
  dueDates,
  escalationTriggered,
  evaluateSla,
} from '../../src/modules/support/sla-evaluator.js';
import type { SlaSnapshot } from '../../src/modules/support/sla-evaluator.js';
import {
  mayTransition,
  nextStatuses,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  transitionEventType,
  transitionRule,
} from '../../src/modules/support/ticket-state-machine.js';

const at = (iso: string): Date => new Date(iso);

describe('ticket state machine', () => {
  it('keeps resolve, verify and close distinct: nothing reaches CLOSED or VERIFIED without its own step', () => {
    for (const from of TICKET_STATUSES) {
      if (from !== 'RESOLVED' && from !== 'VERIFIED') {
        expect(transitionRule(from, 'CLOSED')).toBeNull();
      }
      if (from !== 'RESOLVED') {
        expect(transitionRule(from, 'VERIFIED')).toBeNull();
      }
    }
    expect(transitionRule('RESOLVED', 'VERIFIED')?.kind).toBe('VERIFY');
    expect(transitionRule('RESOLVED', 'CLOSED')?.kind).toBe('CLOSE');
    expect(transitionRule('VERIFIED', 'CLOSED')?.kind).toBe('CLOSE');
  });

  it('makes CANCELLED terminal and lets closed tickets only be reopened', () => {
    expect(nextStatuses('CANCELLED')).toEqual([]);
    expect(nextStatuses('CLOSED')).toEqual(['IN_PROGRESS']);
    expect(transitionRule('CLOSED', 'IN_PROGRESS')?.kind).toBe('REOPEN');
  });

  it('requires notes for resolve, escalate, cancel and reopen', () => {
    expect(transitionRule('IN_PROGRESS', 'RESOLVED')?.noteRequired).toBe(true);
    expect(transitionRule('IN_PROGRESS', 'ESCALATED')?.noteRequired).toBe(true);
    expect(transitionRule('IN_PROGRESS', 'CANCELLED')?.noteRequired).toBe(true);
    expect(transitionRule('RESOLVED', 'IN_PROGRESS')?.noteRequired).toBe(true);
    expect(transitionRule('NEW', 'TRIAGED')?.noteRequired).toBe(false);
  });

  it('never transitions to the same status and only to known statuses', () => {
    for (const [from, targets] of Object.entries(TICKET_TRANSITIONS) as [TicketStatus, object][]) {
      for (const to of Object.keys(targets)) {
        expect(to).not.toBe(from);
        expect(TICKET_STATUSES).toContain(to);
      }
    }
  });

  it('treats WAITING_FOR_DEVELOPMENT as a plain status reachable by escalators (no Jira implied)', () => {
    const rule = transitionRule('IN_PROGRESS', 'WAITING_FOR_DEVELOPMENT');
    expect(rule?.permissions).toEqual(['support.escalate']);
    expect(rule && transitionEventType(rule, 'WAITING_FOR_DEVELOPMENT')).toBe('STATUS_CHANGED');
    expect(transitionRule('NEW', 'WAITING_FOR_DEVELOPMENT')).toBeNull();
  });

  it('lets the reporter cancel only their NEW ticket without permissions', () => {
    const reporter = { isReporter: true, holds: () => false };
    const newCancel = transitionRule('NEW', 'CANCELLED');
    const triagedCancel = transitionRule('TRIAGED', 'CANCELLED');
    expect(newCancel && mayTransition(newCancel, reporter)).toBe(true);
    expect(triagedCancel && mayTransition(triagedCancel, reporter)).toBe(false);
    const verify = transitionRule('RESOLVED', 'VERIFIED');
    expect(verify && mayTransition(verify, reporter)).toBe(false);
    const holder = { isReporter: false, holds: (p: PermissionKey) => p === 'support.verify' };
    expect(verify && mayTransition(verify, holder)).toBe(true);
  });

  it('maps transitions to history event types', () => {
    const cases: [TicketStatus, TicketStatus, string][] = [
      ['NEW', 'TRIAGED', 'TRIAGED'],
      ['NEW', 'IN_PROGRESS', 'STATUS_CHANGED'],
      ['IN_PROGRESS', 'ESCALATED', 'ESCALATED'],
      ['IN_PROGRESS', 'RESOLVED', 'RESOLVED'],
      ['RESOLVED', 'VERIFIED', 'VERIFIED'],
      ['VERIFIED', 'CLOSED', 'CLOSED'],
      ['CLOSED', 'IN_PROGRESS', 'REOPENED'],
      ['TRIAGED', 'CANCELLED', 'CANCELLED'],
    ];
    for (const [from, to, type] of cases) {
      const rule = transitionRule(from, to);
      expect(rule && transitionEventType(rule, to)).toBe(type);
    }
  });
});

/** Monday to Friday, 09:00-17:00, Europe/London (BST = UTC+1 until 25 Oct 2026, then GMT). */
const london = (holidays: string[] = []): SlaClock => ({
  kind: 'business',
  calendar: {
    timeZone: 'Europe/London',
    windows: new Map([1, 2, 3, 4, 5].map((day) => [day, { start: 540, end: 1020 }])),
    holidays: new Set(holidays),
  },
});

describe('SLA clock', () => {
  it('converts local wall time with daylight-saving gaps and overlaps', () => {
    expect(zonedTimeToUtc('2026-07-01', 9 * 60, 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', 9 * 60, 'Europe/London').toISOString()).toBe('2026-12-01T09:00:00.000Z');
    // 01:30 does not exist on 29 Mar 2026 (clocks jump 01:00 -> 02:00): moved forward by the gap.
    expect(zonedTimeToUtc('2026-03-29', 90, 'Europe/London').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 01:30 happens twice on 25 Oct 2026: the earlier instant (BST) is used.
    expect(zonedTimeToUtc('2026-10-25', 90, 'Europe/London').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('advances a wall clock continuously', () => {
    expect(addClockSeconds(at('2026-10-03T10:00:00Z'), 3600, WALL_CLOCK).toISOString()).toBe(
      '2026-10-03T11:00:00.000Z',
    );
    expect(clockSecondsBetween(at('2026-10-03T10:00:00Z'), at('2026-10-03T09:00:00Z'), WALL_CLOCK)).toBe(0);
  });

  it('skips nights and weekends on a business clock', () => {
    // Friday 16:00 BST + 2 business hours = Monday 10:00 BST.
    expect(addClockSeconds(at('2026-10-02T15:00:00Z'), 7200, london()).toISOString()).toBe('2026-10-05T09:00:00.000Z');
    // Created on Saturday: the clock starts Monday 09:00 BST.
    expect(addClockSeconds(at('2026-10-03T12:00:00Z'), 1800, london()).toISOString()).toBe('2026-10-05T08:30:00.000Z');
    expect(clockSecondsBetween(at('2026-10-02T15:00:00Z'), at('2026-10-05T09:00:00Z'), london())).toBe(7200);
    expect(clockSecondsBetween(at('2026-10-03T08:00:00Z'), at('2026-10-04T20:00:00Z'), london())).toBe(0);
  });

  it('skips holidays', () => {
    // Monday 5 Oct is a holiday: Friday 16:00 + 2h = Tuesday 10:00 BST.
    expect(addClockSeconds(at('2026-10-02T15:00:00Z'), 7200, london(['2026-10-05'])).toISOString()).toBe(
      '2026-10-06T09:00:00.000Z',
    );
  });

  it('follows the local clock across the autumn daylight-saving change', () => {
    // Friday 23 Oct 16:30 BST + 1h = 30 min Friday + Monday 26 Oct 09:30 GMT.
    expect(addClockSeconds(at('2026-10-23T15:30:00Z'), 3600, london()).toISOString()).toBe('2026-10-26T09:30:00.000Z');
  });

  it('counts the real length of a working day on a daylight-saving day', () => {
    const allDay: BusinessCalendarSpec = {
      timeZone: 'Europe/London',
      windows: new Map([[7, { start: 0, end: 1440 }]]),
      holidays: new Set(),
    };
    const clock: SlaClock = { kind: 'business', calendar: allDay };
    // Sunday 29 Mar 2026 has 23 hours in London.
    expect(clockSecondsBetween(at('2026-03-28T12:00:00Z'), at('2026-03-30T12:00:00Z'), clock)).toBe(23 * 3600);
  });

  it('refuses a business clock without working hours', () => {
    const closed: SlaClock = {
      kind: 'business',
      calendar: { timeZone: 'UTC', windows: new Map(), holidays: new Set() },
    };
    expect(() => addClockSeconds(at('2026-10-03T00:00:00Z'), 60, closed)).toThrow(RangeError);
  });
});

const policy = (clock: SlaClock = WALL_CLOCK): SlaPolicyClock => ({
  id: 'p',
  firstResponseMinutes: 60,
  resolutionMinutes: 240,
  atRiskThresholdPercent: 75,
  pauseStatuses: ['WAITING_FOR_CUSTOMER'],
  clock,
});

const START = at('2026-10-05T08:00:00Z');
const minutesLater = (minutes: number): Date => new Date(START.getTime() + minutes * 60_000);

const snapshot = (overrides: Partial<SlaSnapshot> = {}): SlaSnapshot => ({
  status: 'IN_PROGRESS',
  startedAt: START,
  firstRespondedAt: null,
  resolvedAt: null,
  pausedSince: null,
  pausedSeconds: 0,
  firstResponseState: null,
  resolutionState: null,
  ...overrides,
});

describe('SLA evaluation', () => {
  it('moves from on track to at risk to breached and reports each condition once reached', () => {
    expect(evaluateSla(policy(), snapshot(), minutesLater(10))).toEqual({
      firstResponseState: 'ON_TRACK',
      resolutionState: 'ON_TRACK',
      reached: [],
    });
    expect(evaluateSla(policy(), snapshot(), minutesLater(46))).toMatchObject({
      firstResponseState: 'AT_RISK',
      reached: ['FIRST_RESPONSE_AT_RISK'],
    });
    expect(evaluateSla(policy(), snapshot(), minutesLater(61))).toMatchObject({
      firstResponseState: 'BREACHED',
      reached: ['FIRST_RESPONSE_BREACHED'],
    });
    expect(evaluateSla(policy(), snapshot(), minutesLater(241)).reached).toEqual([
      'FIRST_RESPONSE_BREACHED',
      'RESOLUTION_BREACHED',
    ]);
  });

  it('keeps an already breached target breached, even after a late response or a policy change', () => {
    const breached = snapshot({ firstResponseState: 'BREACHED', firstRespondedAt: minutesLater(5) });
    expect(evaluateSla(policy(), breached, minutesLater(6)).firstResponseState).toBe('BREACHED');
    expect(evaluateSla(policy(), snapshot({ resolutionState: 'BREACHED' }), minutesLater(1)).resolutionState).toBe(
      'BREACHED',
    );
  });

  it('settles already resolved tickets as met or breached by the resolution time', () => {
    const inTime = snapshot({ status: 'RESOLVED', resolvedAt: minutesLater(200), firstRespondedAt: minutesLater(30) });
    expect(evaluateSla(policy(), inTime, minutesLater(10_000))).toEqual({
      firstResponseState: 'MET',
      resolutionState: 'MET',
      reached: [],
    });
    const late = snapshot({ status: 'CLOSED', resolvedAt: minutesLater(300), firstRespondedAt: minutesLater(30) });
    expect(evaluateSla(policy(), late, minutesLater(10_000)).resolutionState).toBe('BREACHED');
  });

  it('reports paused targets without breaching them while the clock is stopped', () => {
    const paused = snapshot({ status: 'WAITING_FOR_CUSTOMER', pausedSince: minutesLater(30) });
    expect(evaluateSla(policy(), paused, minutesLater(1000))).toEqual({
      firstResponseState: 'PAUSED',
      resolutionState: 'PAUSED',
      reached: [],
    });
  });

  it('pushes due dates out by the stopped time', () => {
    const plain = dueDates(policy(), START, 0);
    const shifted = dueDates(policy(), START, 1800);
    expect(shifted.resolutionDueAt.getTime() - plain.resolutionDueAt.getTime()).toBe(1_800_000);
    expect(plain.firstResponseDueAt.toISOString()).toBe('2026-10-05T09:00:00.000Z');
  });

  it('computes business-hours due dates over a weekend', () => {
    const friday = at('2026-10-02T15:00:00Z');
    const due = dueDates(policy(london()), friday, 0);
    expect(due.firstResponseDueAt.toISOString()).toBe('2026-10-02T16:00:00.000Z');
    // 240 business minutes: 1h Friday + 3h Monday.
    expect(due.resolutionDueAt.toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });

  it('pauses on waiting-for-customer and resumes with the stopped time accumulated', () => {
    const pause = applyStatusChange(policy(), snapshot(), 'WAITING_FOR_CUSTOMER', minutesLater(20));
    expect(pause).toEqual({ pausedSince: minutesLater(20), pausedSeconds: 0, event: 'PAUSED' });
    const resume = applyStatusChange(
      policy(),
      snapshot({ status: 'WAITING_FOR_CUSTOMER', pausedSince: minutesLater(20) }),
      'IN_PROGRESS',
      minutesLater(50),
    );
    expect(resume).toEqual({ pausedSince: null, pausedSeconds: 1800, event: 'RESUMED' });
    // Resolving stops the clock without a pause event.
    expect(applyStatusChange(policy(), snapshot(), 'RESOLVED', minutesLater(5)).event).toBeNull();
  });

  it('fires escalation triggers only for open tickets', () => {
    const half = { trigger: 'RESOLUTION_ELAPSED_PERCENT' as const, threshold: 50 };
    expect(escalationTriggered(half, policy(), snapshot(), minutesLater(119))).toBe(false);
    expect(escalationTriggered(half, policy(), snapshot(), minutesLater(120))).toBe(true);
    expect(escalationTriggered(half, null, snapshot(), minutesLater(1000))).toBe(false);
    const unresolved = { trigger: 'UNRESOLVED_AFTER_MINUTES' as const, threshold: 30 };
    expect(escalationTriggered(unresolved, null, snapshot(), minutesLater(30))).toBe(true);
    const firstResponse = { trigger: 'FIRST_RESPONSE_BREACHED' as const, threshold: 0 };
    expect(escalationTriggered(firstResponse, policy(), snapshot({ firstResponseState: 'BREACHED' }), START)).toBe(
      true,
    );
    expect(
      escalationTriggered(unresolved, policy(), snapshot({ status: 'RESOLVED', resolvedAt: START }), minutesLater(99)),
    ).toBe(false);
  });
});

describe('SLA configuration parsing', () => {
  it('drops unknown or malformed match entries instead of widening the match', () => {
    const match = parseTicketMatch({ severities: ['HIGH', 'URGENT', 3], projectIds: ['not-a-uuid'], extra: true });
    expect(match).toEqual({ severities: ['HIGH'], priorities: [], projectIds: [], categoryIds: [] });
    const ticket = { severity: 'HIGH' as const, priority: 'P2' as const, projectId: null, categoryId: null };
    expect(matchesTicket(match, ticket)).toBe(true);
    expect(matchesTicket(match, { ...ticket, severity: 'LOW' })).toBe(false);
    expect(matchesTicket(parseTicketMatch(null), ticket)).toBe(true);
  });

  it('parses escalation recipients and working hours defensively', () => {
    expect(parseEscalationNotify({ roles: ['PROJECT_MANAGER', 'lower'], projectRoles: ['QA', 'BOSS'] })).toEqual({
      roles: ['PROJECT_MANAGER'],
      projectRoles: ['QA'],
      memberIds: [],
    });
    expect(
      parseWorkingHours([
        { weekday: 1, start: '09:00', end: '17:00' },
        { weekday: 2, start: '17:00', end: '09:00' },
        { weekday: 8, start: '09:00', end: '10:00' },
        { weekday: 3, start: '9:00', end: '10:00' },
      ]),
    ).toEqual([{ weekday: 1, start: '09:00', end: '17:00' }]);
  });

  it('falls back to the wall clock for a business-hours policy without working hours', () => {
    const row = {
      id: 'p',
      name: 'P',
      firstResponseMinutes: 60,
      resolutionMinutes: 120,
      atRiskThresholdPercent: 75,
      businessHoursOnly: true,
      pauseStatuses: [] as TicketStatus[],
    };
    expect(
      policyClock({ ...row, businessCalendar: { timeZone: null, workingHours: [], holidays: [] } }, 'UTC').clock,
    ).toBe(WALL_CLOCK);
    const clock = policyClock(
      {
        ...row,
        businessCalendar: {
          timeZone: null,
          workingHours: [{ weekday: 1, start: '09:00', end: '17:00' }],
          holidays: [],
        },
      },
      'Africa/Cairo',
    ).clock;
    expect(clock.kind === 'business' ? clock.calendar.timeZone : null).toBe('Africa/Cairo');
  });
});

describe('notification emails', () => {
  it('renders only the ticket key and title, escaped, with a single-line subject', () => {
    const email = renderNotificationEmail({
      type: 'SUPPORT_TICKET_ASSIGNED',
      params: { ticketNumber: 'SUP-7', title: '<script>x</script>\nBcc: evil@example.test' },
      language: 'en',
      link: 'https://ops.example.test/support/tickets/1',
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain('SUP-7');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('https://ops.example.test/support/tickets/1');
  });

  it('renders Arabic right-to-left and falls back for unknown types', () => {
    const arabic = renderNotificationEmail({
      type: 'SUPPORT_TICKET_RESOLVED',
      params: { ticketNumber: 'SUP-1', title: 'x' },
      language: 'ar',
      link: 'https://ops.example.test/x',
    });
    expect(arabic.html).toContain('dir="rtl"');
    const fallback = renderNotificationEmail({ type: 'UNKNOWN', params: {}, language: 'en', link: 'https://x.test' });
    expect(fallback.subject).toBe('New notification');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});
