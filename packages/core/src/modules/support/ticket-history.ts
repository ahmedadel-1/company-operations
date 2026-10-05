import type { Prisma } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';

/**
 * History event types (DATA_MODEL §5 `support_ticket_events`). Rows are append-only (trigger and
 * grants); the current state stays on the ticket. `INTERNAL_NOTE_ADDED` / `INTERNAL_NOTE_EDITED`
 * are only returned to members who may read internal notes. Metadata carries identifiers, enum
 * values and short transition notes, never comment bodies.
 */
export const TICKET_EVENT_TYPES = [
  'CREATED',
  'DETAILS_EDITED',
  'TRIAGED',
  'STATUS_CHANGED',
  'SEVERITY_CHANGED',
  'PRIORITY_CHANGED',
  'IMPACT_CHANGED',
  'SOURCE_CHANGED',
  'CATEGORY_CHANGED',
  'COMPONENT_CHANGED',
  'PROJECT_CHANGED',
  'TEAM_CHANGED',
  'ASSIGNED',
  'UNASSIGNED',
  'ESCALATED',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
  'COMMENTED',
  'COMMENT_EDITED',
  'INTERNAL_NOTE_ADDED',
  'INTERNAL_NOTE_EDITED',
  'WATCHER_ADDED',
  'WATCHER_REMOVED',
  'ATTACHMENT_ADDED',
  'ATTACHMENT_REMOVED',
  'SLA_POLICY_CHANGED',
  'SLA_PAUSED',
  'SLA_RESUMED',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'SLA_ESCALATED',
  'JIRA_LINKED',
  'JIRA_UNLINKED',
  'JIRA_CREATED',
  'JIRA_STATUS_SYNCED',
] as const;

export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

/** Event types hidden from members without `support.internal_note` on the ticket. */
export const INTERNAL_EVENT_TYPES: readonly TicketEventType[] = ['INTERNAL_NOTE_ADDED', 'INTERNAL_NOTE_EDITED'];
/** Development-tracking events; shown only to members who may see Jira information (jira.view). */
export const JIRA_EVENT_TYPES: readonly TicketEventType[] = [
  'JIRA_LINKED',
  'JIRA_UNLINKED',
  'JIRA_CREATED',
  'JIRA_STATUS_SYNCED',
];

export type EventValue = Prisma.InputJsonValue | null;

export interface TicketEventInput {
  readonly type: TicketEventType;
  readonly actorMemberId: string | null;
  readonly from?: EventValue;
  readonly to?: EventValue;
  readonly metadata?: Prisma.InputJsonObject;
}

export async function recordTicketEvent(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
  event: TicketEventInput,
): Promise<string> {
  const row = await db.supportTicketEvent.create({
    data: {
      organizationId,
      ticketId,
      actorMemberId: event.actorMemberId,
      type: event.type,
      ...(event.from === undefined || event.from === null ? {} : { fromValue: event.from }),
      ...(event.to === undefined || event.to === null ? {} : { toValue: event.to }),
      metadata: event.metadata ?? {},
    },
    select: { id: true },
  });
  return row.id;
}
