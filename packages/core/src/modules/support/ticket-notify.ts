import type { PermissionKey } from '@company-ops/shared';

import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { NotificationRequestedPayload } from '../../platform/outbox/outbox.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import type { LoadedTicket } from './ticket-access.js';
import { holdsOnTicket, loadTicketForAccess, ticketKey } from './ticket-access.js';

export interface TicketNotification {
  readonly type: string;
  readonly severity: NotificationRequestedPayload['severity'];
  readonly email: boolean;
  /** Id of the history/SLA event that caused it: one notification per recipient and cause. */
  readonly causeId: string;
  /** Recipients must also hold this permission on the ticket (e.g. internal-note notifications). */
  readonly requires?: PermissionKey;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Queues ticket notifications (in the caller's transaction, through the outbox). Every recipient is
 * re-checked against their own `support.view` scope on the ticket (plus `requires`), so nobody is
 * told about a ticket they cannot open and internal-note activity never reaches reporters. The
 * acting member is never notified about their own change. Parameters are the ticket key and title
 * only; comment text is never included. Returns the number of notifications queued.
 */
export async function notifyTicketAudience(
  db: TenantDb,
  organizationId: string,
  ticket: LoadedTicket,
  recipientMemberIds: readonly (string | null | undefined)[],
  notification: TicketNotification,
  actorMemberId: string | null,
): Promise<number> {
  const candidates = [
    ...new Set(recipientMemberIds.filter((id): id is string => typeof id === 'string' && id !== actorMemberId)),
  ];
  if (candidates.length === 0) {
    return 0;
  }
  const access = await loadMemberAccess(db, organizationId, candidates);
  let queued = 0;
  for (const memberId of candidates.sort()) {
    const member = access.get(memberId);
    if (
      member === undefined ||
      !holdsOnTicket(member.principal, 'support.view', ticket) ||
      (notification.requires !== undefined && !holdsOnTicket(member.principal, notification.requires, ticket))
    ) {
      continue;
    }
    await enqueueOutboxEvent(db, organizationId, {
      eventType: 'notification.requested',
      aggregateType: 'support_ticket',
      aggregateId: ticket.row.id,
      payload: {
        recipientMemberId: memberId,
        type: notification.type,
        severity: notification.severity,
        entityType: 'support_ticket',
        entityId: ticket.row.id,
        params: { ticketNumber: ticketKey(ticket.row.number), title: ticket.row.title, ...notification.params },
        dedupeKey: `${notification.type.toLowerCase()}:${ticket.row.id}:${notification.causeId}`,
        ...(notification.email ? { email: true } : {}),
      },
    });
    queued += 1;
  }
  return queued;
}

/** Announces a ticket change for live views (identifiers only; recipients re-fetch via the API). */
export async function announceTicketChange(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
  broadcast: boolean,
): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'support.ticket.changed',
    aggregateType: 'support_ticket',
    aggregateId: ticketId,
    payload: { ticketId, broadcast },
  });
}

export async function watcherMemberIds(db: TenantDb, organizationId: string, ticketId: string): Promise<string[]> {
  const rows = await db.supportTicketWatcher.findMany({
    where: { organizationId, ticketId },
    select: { memberId: true },
  });
  return rows.map((row) => row.memberId);
}

export async function teamMemberIds(db: TenantDb, organizationId: string, teamId: string | null): Promise<string[]> {
  if (teamId === null) {
    return [];
  }
  const rows = await db.teamMember.findMany({
    where: { organizationId, teamId, team: { archivedAt: null } },
    select: { profile: { select: { memberId: true } } },
  });
  return rows.map((row) => row.profile.memberId);
}

/**
 * Users to hint about a ticket change over SSE: its reporter, assignee, watchers, team members and
 * project managers who can still view it (re-checked like notifications). Empty for a missing ticket.
 */
export async function ticketRealtimeAudience(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
): Promise<string[]> {
  const ticket = await loadTicketForAccess(db, organizationId, ticketId);
  if (ticket === null) {
    return [];
  }
  const candidates = [
    ticket.row.reporterMemberId,
    ticket.row.assigneeMemberId,
    ...(await watcherMemberIds(db, organizationId, ticketId)),
    ...(await teamMemberIds(db, organizationId, ticket.row.assignedTeamId)),
    ...projectManagerIds(ticket),
  ].filter((id): id is string => id !== null);
  const access = await loadMemberAccess(db, organizationId, candidates);
  return [...access.values()]
    .filter((member) => holdsOnTicket(member.principal, 'support.view', ticket))
    .map((member) => member.userId)
    .sort();
}

/** The project's manager and technical manager (escalation and critical-ticket audience). */
export function projectManagerIds(ticket: LoadedTicket): string[] {
  const project = ticket.row.project;
  if (project === null) {
    return [];
  }
  return [project.projectManager?.memberId, project.technicalManager?.memberId].filter(
    (id): id is string => typeof id === 'string',
  );
}
