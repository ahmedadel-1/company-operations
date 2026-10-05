import type { TicketStatus } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

/**
 * Support ticket lifecycle (DATA_MODEL §5, ADR-0018). Pure and exhaustively unit-tested; the ticket
 * service is the only caller and every transition is re-checked against the ticket's scope.
 *
 * - RESOLVED, VERIFIED and CLOSED are distinct steps: resolving never closes a ticket. A resolved
 *   ticket is verified (reporter or verifier) and then closed, or closed without verification by
 *   someone holding `support.close`.
 * - "Reopen" moves RESOLVED, VERIFIED or CLOSED back to IN_PROGRESS and clears the closure
 *   timestamps; CANCELLED is terminal.
 * - WAITING_FOR_DEVELOPMENT is a waiting state only; it does not imply that any Jira issue exists.
 */
export const TICKET_STATUSES: readonly TicketStatus[] = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
];

/** Statuses in which work is still expected (the SLA sweep and "open" filters use these). */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
];

/** The resolution clock is stopped in these statuses (in addition to the policy's pause statuses). */
export const CLOCK_STOPPED_STATUSES: readonly TicketStatus[] = ['RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED'];

/** Comments and attachments are locked once a ticket is closed or cancelled (reopen first). */
export const LOCKED_TICKET_STATUSES: readonly TicketStatus[] = ['CLOSED', 'CANCELLED'];

export const isOpenStatus = (status: TicketStatus): boolean => OPEN_TICKET_STATUSES.includes(status);

/** What a transition records in the ticket history besides the status change itself. */
export type TransitionKind = 'TRIAGE' | 'WORK' | 'ESCALATE' | 'RESOLVE' | 'VERIFY' | 'CLOSE' | 'REOPEN' | 'CANCEL';

export interface TransitionRule {
  readonly kind: TransitionKind;
  /** Holding ANY of these permissions on the ticket allows the transition. */
  readonly permissions: readonly PermissionKey[];
  /** The request must carry a note (reason, resolution summary). */
  readonly noteRequired: boolean;
  /** The reporter may perform it on their own ticket without the permissions above. */
  readonly reporterMay: boolean;
}

const WORK: readonly PermissionKey[] = ['support.resolve', 'support.triage', 'support.escalate'];

const rule = (
  kind: TransitionKind,
  permissions: readonly PermissionKey[],
  options: { noteRequired?: boolean; reporterMay?: boolean } = {},
): TransitionRule => ({
  kind,
  permissions,
  noteRequired: options.noteRequired ?? false,
  reporterMay: options.reporterMay ?? false,
});

const triage = rule('TRIAGE', ['support.triage']);
const work = rule('WORK', WORK);
const escalate = rule('ESCALATE', ['support.escalate'], { noteRequired: true });
const waitForDevelopment = rule('ESCALATE', ['support.escalate']);
const resolve = rule('RESOLVE', ['support.resolve'], { noteRequired: true });
const cancel = rule('CANCEL', ['support.close'], { noteRequired: true });
const cancelByReporter = rule('CANCEL', ['support.close'], { noteRequired: true, reporterMay: true });
const verify = rule('VERIFY', ['support.verify']);
const close = rule('CLOSE', ['support.close']);
const rejectResolution = rule('REOPEN', ['support.verify', 'support.close'], { noteRequired: true });
const reopen = rule('REOPEN', ['support.close'], { noteRequired: true });

export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, Partial<Record<TicketStatus, TransitionRule>>>> = {
  NEW: {
    TRIAGED: triage,
    IN_PROGRESS: work,
    ESCALATED: escalate,
    WAITING_FOR_CUSTOMER: work,
    RESOLVED: resolve,
    CANCELLED: cancelByReporter,
  },
  TRIAGED: {
    IN_PROGRESS: work,
    ESCALATED: escalate,
    WAITING_FOR_DEVELOPMENT: waitForDevelopment,
    WAITING_FOR_CUSTOMER: work,
    RESOLVED: resolve,
    CANCELLED: cancel,
  },
  IN_PROGRESS: {
    ESCALATED: escalate,
    WAITING_FOR_DEVELOPMENT: waitForDevelopment,
    WAITING_FOR_CUSTOMER: work,
    RESOLVED: resolve,
    CANCELLED: cancel,
  },
  ESCALATED: {
    IN_PROGRESS: work,
    WAITING_FOR_DEVELOPMENT: waitForDevelopment,
    WAITING_FOR_CUSTOMER: work,
    RESOLVED: resolve,
    CANCELLED: cancel,
  },
  WAITING_FOR_DEVELOPMENT: {
    IN_PROGRESS: work,
    ESCALATED: escalate,
    RESOLVED: resolve,
    CANCELLED: cancel,
  },
  WAITING_FOR_CUSTOMER: {
    IN_PROGRESS: work,
    RESOLVED: resolve,
    CANCELLED: cancel,
  },
  RESOLVED: {
    VERIFIED: verify,
    CLOSED: close,
    IN_PROGRESS: rejectResolution,
  },
  VERIFIED: {
    CLOSED: close,
    IN_PROGRESS: reopen,
  },
  CLOSED: {
    IN_PROGRESS: reopen,
  },
  CANCELLED: {},
};

export function transitionRule(from: TicketStatus, to: TicketStatus): TransitionRule | null {
  return TICKET_TRANSITIONS[from][to] ?? null;
}

export function nextStatuses(from: TicketStatus): TicketStatus[] {
  return TICKET_STATUSES.filter((status) => TICKET_TRANSITIONS[from][status] !== undefined);
}

/**
 * Whether an actor may perform the transition: `holds` answers "does the actor hold this permission
 * on this ticket (in scope)". The reporter exception only applies where the rule allows it.
 */
export function mayTransition(
  rule: TransitionRule,
  actor: { readonly isReporter: boolean; readonly holds: (permission: PermissionKey) => boolean },
): boolean {
  return (rule.reporterMay && actor.isReporter) || rule.permissions.some((permission) => actor.holds(permission));
}

/** History event type recorded for a transition (in addition to the status values). */
export function transitionEventType(
  rule: TransitionRule,
  to: TicketStatus,
): 'TRIAGED' | 'ESCALATED' | 'STATUS_CHANGED' | 'RESOLVED' | 'VERIFIED' | 'CLOSED' | 'REOPENED' | 'CANCELLED' {
  switch (rule.kind) {
    case 'TRIAGE':
      return 'TRIAGED';
    case 'ESCALATE':
      return to === 'ESCALATED' ? 'ESCALATED' : 'STATUS_CHANGED';
    case 'RESOLVE':
      return 'RESOLVED';
    case 'VERIFY':
      return 'VERIFIED';
    case 'CLOSE':
      return 'CLOSED';
    case 'REOPEN':
      return 'REOPENED';
    case 'CANCEL':
      return 'CANCELLED';
    case 'WORK':
      return 'STATUS_CHANGED';
  }
}
