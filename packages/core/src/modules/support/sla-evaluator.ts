import type { EscalationTrigger, SlaEventKind, SlaState, TicketStatus } from '@company-ops/db';

import { addClockSeconds, clockSecondsBetween, WALL_CLOCK } from './sla-clock.js';
import type { SlaClock } from './sla-clock.js';
import type { SlaPolicyClock } from './sla-config.js';
import { CLOCK_STOPPED_STATUSES, isOpenStatus } from './ticket-state-machine.js';

/**
 * Pure SLA evaluation (ADR-0018). Both targets run on one clock that starts at ticket creation and
 * stops while the ticket is in one of the policy's pause statuses or in RESOLVED/VERIFIED/CLOSED/
 * CANCELLED. Stopped time accumulates in `pausedSeconds` (measured on the policy's clock) and pushes
 * both due dates out. BREACHED is sticky; MET is final once the target was reached in time.
 */

export interface SlaSnapshot {
  readonly status: TicketStatus;
  readonly startedAt: Date;
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly pausedSince: Date | null;
  readonly pausedSeconds: number;
  readonly firstResponseState: SlaState | null;
  readonly resolutionState: SlaState | null;
}

export interface SlaDueDates {
  readonly firstResponseDueAt: Date;
  readonly resolutionDueAt: Date;
}

export interface SlaEvaluation {
  readonly firstResponseState: SlaState;
  readonly resolutionState: SlaState;
  /** Conditions reached now; recorded once each by the unique `sla_events` key. */
  readonly reached: readonly SlaEventKind[];
}

export function isClockStopped(status: TicketStatus, policy: SlaPolicyClock): boolean {
  return CLOCK_STOPPED_STATUSES.includes(status) || policy.pauseStatuses.includes(status);
}

/** True when the status is one of the policy's pause statuses (reported as PAUSED/RESUMED events). */
export function isPauseStatus(status: TicketStatus, policy: SlaPolicyClock): boolean {
  return policy.pauseStatuses.includes(status) && !CLOCK_STOPPED_STATUSES.includes(status);
}

export function dueDates(policy: SlaPolicyClock, startedAt: Date, pausedSeconds: number): SlaDueDates {
  return {
    firstResponseDueAt: addClockSeconds(startedAt, policy.firstResponseMinutes * 60 + pausedSeconds, policy.clock),
    resolutionDueAt: addClockSeconds(startedAt, policy.resolutionMinutes * 60 + pausedSeconds, policy.clock),
  };
}

function atRiskAt(policy: SlaPolicyClock, startedAt: Date, targetMinutes: number, pausedSeconds: number): Date {
  const riskSeconds = Math.floor((targetMinutes * 60 * policy.atRiskThresholdPercent) / 100);
  return addClockSeconds(startedAt, riskSeconds + pausedSeconds, policy.clock);
}

/** Clock seconds the ticket has been running, excluding stopped time (including a current stop). */
export function elapsedSeconds(clock: SlaClock, snapshot: SlaSnapshot, now: Date): number {
  const until = snapshot.pausedSince ?? now;
  return Math.max(0, clockSecondsBetween(snapshot.startedAt, until, clock) - snapshot.pausedSeconds);
}

export function evaluateSla(policy: SlaPolicyClock, snapshot: SlaSnapshot, now: Date): SlaEvaluation {
  const due = dueDates(policy, snapshot.startedAt, snapshot.pausedSeconds);
  const reached: SlaEventKind[] = [];
  const stopped = snapshot.pausedSince !== null;

  let firstResponseState: SlaState;
  if (snapshot.firstRespondedAt !== null) {
    firstResponseState =
      snapshot.firstResponseState === 'BREACHED' || snapshot.firstRespondedAt > due.firstResponseDueAt
        ? 'BREACHED'
        : 'MET';
  } else if (snapshot.firstResponseState === 'BREACHED') {
    firstResponseState = 'BREACHED';
  } else if (!isOpenStatus(snapshot.status)) {
    firstResponseState = snapshot.firstResponseState ?? 'ON_TRACK';
  } else if (stopped) {
    firstResponseState = 'PAUSED';
  } else if (now >= due.firstResponseDueAt) {
    firstResponseState = 'BREACHED';
    reached.push('FIRST_RESPONSE_BREACHED');
  } else if (now >= atRiskAt(policy, snapshot.startedAt, policy.firstResponseMinutes, snapshot.pausedSeconds)) {
    firstResponseState = 'AT_RISK';
    reached.push('FIRST_RESPONSE_AT_RISK');
  } else {
    firstResponseState = 'ON_TRACK';
  }

  let resolutionState: SlaState;
  if (snapshot.status === 'CANCELLED') {
    resolutionState = snapshot.resolutionState ?? 'ON_TRACK';
  } else if (snapshot.resolvedAt !== null && !isOpenStatus(snapshot.status)) {
    resolutionState =
      snapshot.resolutionState === 'BREACHED' || snapshot.resolvedAt > due.resolutionDueAt ? 'BREACHED' : 'MET';
  } else if (snapshot.resolutionState === 'BREACHED') {
    resolutionState = 'BREACHED';
  } else if (stopped) {
    resolutionState = 'PAUSED';
  } else if (now >= due.resolutionDueAt) {
    resolutionState = 'BREACHED';
    reached.push('RESOLUTION_BREACHED');
  } else if (now >= atRiskAt(policy, snapshot.startedAt, policy.resolutionMinutes, snapshot.pausedSeconds)) {
    resolutionState = 'AT_RISK';
    reached.push('RESOLUTION_AT_RISK');
  } else {
    resolutionState = 'ON_TRACK';
  }

  return { firstResponseState, resolutionState, reached };
}

/**
 * The stop/start bookkeeping for a status change: entering a stopped status records `pausedSince`;
 * leaving one adds the stopped clock time to `pausedSeconds`.
 */
export function applyStatusChange(
  policy: SlaPolicyClock,
  snapshot: SlaSnapshot,
  to: TicketStatus,
  now: Date,
): { pausedSince: Date | null; pausedSeconds: number; event: 'PAUSED' | 'RESUMED' | null } {
  const { pausedSince } = snapshot;
  const nowStopped = isClockStopped(to, policy);
  if (pausedSince === null && nowStopped) {
    return {
      pausedSince: now,
      pausedSeconds: snapshot.pausedSeconds,
      event: isPauseStatus(to, policy) ? 'PAUSED' : null,
    };
  }
  if (pausedSince !== null && !nowStopped) {
    return {
      pausedSince: null,
      pausedSeconds: snapshot.pausedSeconds + clockSecondsBetween(pausedSince, now, policy.clock),
      event: isPauseStatus(snapshot.status, policy) ? 'RESUMED' : null,
    };
  }
  return { pausedSince: snapshot.pausedSince, pausedSeconds: snapshot.pausedSeconds, event: null };
}

export interface EscalationRuleSpec {
  readonly trigger: EscalationTrigger;
  readonly threshold: number;
}

/**
 * Whether an escalation rule's trigger condition holds for an open ticket now. Without an SLA
 * policy only UNRESOLVED_AFTER_MINUTES can fire, on the wall clock since creation.
 */
export function escalationTriggered(
  rule: EscalationRuleSpec,
  policy: SlaPolicyClock | null,
  snapshot: SlaSnapshot,
  now: Date,
): boolean {
  if (!isOpenStatus(snapshot.status)) {
    return false;
  }
  switch (rule.trigger) {
    case 'FIRST_RESPONSE_BREACHED':
      return snapshot.firstResponseState === 'BREACHED';
    case 'RESOLUTION_ELAPSED_PERCENT':
      if (policy === null) {
        return false;
      }
      return elapsedSeconds(policy.clock, snapshot, now) * 100 >= rule.threshold * policy.resolutionMinutes * 60;
    case 'UNRESOLVED_AFTER_MINUTES':
      return elapsedSeconds(policy?.clock ?? WALL_CLOCK, snapshot, now) >= rule.threshold * 60;
  }
}
