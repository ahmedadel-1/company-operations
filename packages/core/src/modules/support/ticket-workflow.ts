import type { Prisma, TicketStatus } from '@company-ops/db';

import { VersionConflictError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import type { LoadedTicket } from './ticket-access.js';
import { ticketKey } from './ticket-access.js';
import { recordTicketEvent } from './ticket-history.js';
import { announceTicketChange, notifyTicketAudience, projectManagerIds, watcherMemberIds } from './ticket-notify.js';
import { recordSlaConditions, recordSlaPause, SlaContext, slaColumns, snapshotOf } from './ticket-sla.js';
import { applyStatusChange } from './sla-evaluator.js';
import type { TransitionRule } from './ticket-state-machine.js';
import { transitionEventType } from './ticket-state-machine.js';

export const MAX_ESCALATION_LEVEL = 5;

/**
 * Applies the version-checked ticket update `data` (incrementing the version); a stale version is
 * `409 VERSION_CONFLICT` and changes nothing.
 */
export async function bumpTicket(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
  expectedVersion: number,
  data: Prisma.SupportTicketUncheckedUpdateManyInput,
): Promise<number> {
  const result = await db.supportTicket.updateMany({
    where: { organizationId, id: ticketId, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new VersionConflictError('The ticket');
  }
  return expectedVersion + 1;
}

const ACTIVITY_TYPES: Partial<Record<TicketStatus, string>> = {
  RESOLVED: 'support.ticket_resolved',
  CLOSED: 'support.ticket_closed',
  CANCELLED: 'support.ticket_cancelled',
};

export interface TransitionInput {
  readonly to: TicketStatus;
  readonly rule: TransitionRule;
  readonly note: string | null;
  readonly actorMemberId: string;
  readonly expectedVersion: number;
  /** Why the system moved the ticket (e.g. `reporter_replied`); absent for user transitions. */
  readonly reason?: string;
}

/**
 * Applies an authorized lifecycle transition inside the caller's transaction: status and closure
 * timestamps, SLA stop/start bookkeeping and re-evaluation, history, notifications, the project
 * timeline and the live-update hint. Authorization is the caller's job.
 */
export async function applyTransition(
  db: TenantDb,
  organizationId: string,
  ticket: LoadedTicket,
  input: TransitionInput,
  now: Date,
): Promise<void> {
  const { row } = ticket;
  const from = row.status;
  const { rule, to } = input;
  const data: Prisma.SupportTicketUncheckedUpdateManyInput = { status: to };
  let firstRespondedAt = row.firstRespondedAt;
  let resolvedAt = row.resolvedAt;
  let escalationLevel = row.escalationLevel;
  switch (rule.kind) {
    case 'RESOLVE':
      resolvedAt = now;
      firstRespondedAt ??= now;
      data.resolvedAt = now;
      data.firstRespondedAt = firstRespondedAt;
      data.resolutionNote = input.note;
      break;
    case 'VERIFY':
      data.verifiedAt = now;
      break;
    case 'CLOSE':
      data.closedAt = now;
      break;
    case 'REOPEN':
      resolvedAt = null;
      data.resolvedAt = null;
      data.verifiedAt = null;
      data.closedAt = null;
      data.resolutionNote = null;
      break;
    case 'CANCEL':
      data.cancelledAt = now;
      break;
    case 'ESCALATE':
      if (to === 'ESCALATED') {
        escalationLevel = Math.min(MAX_ESCALATION_LEVEL, row.escalationLevel + 1);
        data.escalationLevel = escalationLevel;
      }
      break;
    case 'TRIAGE':
    case 'WORK':
      break;
  }

  const sla = new SlaContext(db, organizationId);
  const policy = await sla.policyOf(row, row.project?.timeZone ?? null);
  let pauseEvent: 'PAUSED' | 'RESUMED' | null = null;
  let reached: Awaited<ReturnType<typeof slaColumns>>['reached'] = [];
  if (policy !== null) {
    const before = snapshotOf(row);
    const pause = applyStatusChange(policy, before, to, now);
    pauseEvent = pause.event;
    const evaluated = slaColumns(
      policy,
      {
        ...before,
        status: to,
        firstRespondedAt,
        resolvedAt,
        pausedSince: pause.pausedSince,
        pausedSeconds: pause.pausedSeconds,
      },
      now,
    );
    reached = evaluated.reached;
    Object.assign(data, evaluated.columns, {
      slaPausedSince: pause.pausedSince,
      slaPausedTotalSeconds: pause.pausedSeconds,
    });
  }
  await bumpTicket(db, organizationId, row.id, input.expectedVersion, data);

  const eventId = await recordTicketEvent(db, organizationId, row.id, {
    type: transitionEventType(rule, to),
    actorMemberId: input.actorMemberId,
    from: { status: from },
    to: { status: to },
    metadata: {
      ...(input.note === null ? {} : { note: input.note.slice(0, 1000) }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(escalationLevel === row.escalationLevel ? {} : { escalationLevel }),
      ...(rule.kind === 'CLOSE' ? { verified: from === 'VERIFIED' } : {}),
    },
  });
  if (pauseEvent !== null) {
    await recordSlaPause(
      db,
      organizationId,
      row.id,
      pauseEvent,
      input.actorMemberId,
      pauseEvent === 'PAUSED' ? to : from,
    );
  }
  if (reached.length > 0) {
    await recordSlaConditions(db, organizationId, ticket, reached);
  }

  const watchers = await watcherMemberIds(db, organizationId, row.id);
  const updated: LoadedTicket = { ...ticket, row: { ...row, status: to } };
  if (rule.kind === 'RESOLVE') {
    await notifyTicketAudience(
      db,
      organizationId,
      updated,
      [row.reporterMemberId],
      { type: 'SUPPORT_TICKET_RESOLVED', severity: 'INFO', email: true, causeId: eventId },
      input.actorMemberId,
    );
  } else if (rule.kind === 'VERIFY') {
    await notifyTicketAudience(
      db,
      organizationId,
      updated,
      [row.assigneeMemberId],
      { type: 'SUPPORT_TICKET_VERIFIED', severity: 'INFO', email: true, causeId: eventId },
      input.actorMemberId,
    );
  } else if (to === 'ESCALATED') {
    await notifyTicketAudience(
      db,
      organizationId,
      updated,
      [row.assigneeMemberId, ...projectManagerIds(ticket), ...watchers],
      {
        type: 'SUPPORT_TICKET_ESCALATED',
        severity: 'WARNING',
        email: true,
        causeId: eventId,
        params: { level: escalationLevel },
      },
      input.actorMemberId,
    );
  }
  await notifyTicketAudience(
    db,
    organizationId,
    updated,
    [row.reporterMemberId, row.assigneeMemberId, ...watchers],
    { type: 'SUPPORT_TICKET_STATUS_CHANGED', severity: 'INFO', email: false, causeId: eventId, params: { status: to } },
    input.actorMemberId,
  );

  const activityType = rule.kind === 'REOPEN' ? 'support.ticket_reopened' : ACTIVITY_TYPES[to];
  if (row.projectId !== null && activityType !== undefined) {
    await recordProjectActivity(db, organizationId, row.projectId, input.actorMemberId, {
      source: 'SUPPORT',
      type: activityType,
      entityType: 'support_ticket',
      entityId: row.id,
      summaryParams: { ticketNumber: ticketKey(row.number), status: to },
    });
  }
  await announceTicketChange(db, organizationId, row.id, row.severity === 'CRITICAL' || to === 'ESCALATED');
}
