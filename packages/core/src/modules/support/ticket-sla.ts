import type { Prisma, SlaEventKind, SlaState, TicketStatus } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { LoadedTicket, TicketAccessRow } from './ticket-access.js';
import { recordTicketEvent } from './ticket-history.js';
import { notifyTicketAudience, projectManagerIds, teamMemberIds } from './ticket-notify.js';
import { matchesTicket, parseTicketMatch, policyClock } from './sla-config.js';
import type { MatchableTicket, SlaPolicyClock } from './sla-config.js';
import { dueDates, evaluateSla } from './sla-evaluator.js';
import type { SlaSnapshot } from './sla-evaluator.js';

export const slaPolicySelect = {
  id: true,
  name: true,
  priority: true,
  match: true,
  firstResponseMinutes: true,
  resolutionMinutes: true,
  atRiskThresholdPercent: true,
  businessHoursOnly: true,
  pauseStatuses: true,
  businessCalendar: { select: { timeZone: true, workingHours: true, holidays: true } },
} satisfies Prisma.SlaPolicySelect;

export type SlaPolicyRecord = Prisma.SlaPolicyGetPayload<{ select: typeof slaPolicySelect }>;

/**
 * Per-organization SLA lookups, cached for the lifetime of one request or sweep run: the active
 * policies in match order and the organization's time zone.
 */
export class SlaContext {
  private policies: SlaPolicyRecord[] | null = null;
  private organizationTimeZone: string | null = null;

  constructor(
    private readonly db: TenantDb,
    readonly organizationId: string,
  ) {}

  async activePolicies(): Promise<SlaPolicyRecord[]> {
    this.policies ??= await this.db.slaPolicy.findMany({
      where: { organizationId: this.organizationId, active: true },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: slaPolicySelect,
    });
    return this.policies;
  }

  async timeZone(projectTimeZone: string | null): Promise<string> {
    if (projectTimeZone !== null) {
      return projectTimeZone;
    }
    if (this.organizationTimeZone === null) {
      const organization = await this.db.organization.findFirstOrThrow({
        where: { id: this.organizationId },
        select: { timeZone: true },
      });
      this.organizationTimeZone = organization.timeZone;
    }
    return this.organizationTimeZone;
  }

  /** First active policy (ascending priority) whose match fits the ticket. */
  async resolve(ticket: MatchableTicket, projectTimeZone: string | null): Promise<SlaPolicyClock | null> {
    const policy = (await this.activePolicies()).find((candidate) =>
      matchesTicket(parseTicketMatch(candidate.match), ticket),
    );
    return policy === undefined ? null : policyClock(policy, await this.timeZone(projectTimeZone));
  }

  /** The ticket's current policy (active or not: a deactivated policy keeps governing its tickets). */
  async policyOf(row: { readonly slaPolicyId: string | null }, projectTimeZone: string | null) {
    if (row.slaPolicyId === null) {
      return null;
    }
    const cached = this.policies?.find((policy) => policy.id === row.slaPolicyId);
    const policy =
      cached ??
      (await this.db.slaPolicy.findFirst({
        where: { organizationId: this.organizationId, id: row.slaPolicyId },
        select: slaPolicySelect,
      }));
    return policy === null ? null : policyClock(policy, await this.timeZone(projectTimeZone));
  }
}

export function snapshotOf(row: TicketAccessRow, status: TicketStatus = row.status): SlaSnapshot {
  return {
    status,
    startedAt: row.slaStartedAt,
    firstRespondedAt: row.firstRespondedAt,
    resolvedAt: row.resolvedAt,
    pausedSince: row.slaPausedSince,
    pausedSeconds: row.slaPausedTotalSeconds,
    firstResponseState: row.firstResponseSlaState,
    resolutionState: row.resolutionSlaState,
  };
}

/** SLA columns of a ticket governed by `policy` (or none), evaluated at `now`. */
export interface SlaColumns {
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstResponseSlaState: SlaState | null;
  resolutionSlaState: SlaState | null;
}

export function slaColumns(
  policy: SlaPolicyClock | null,
  snapshot: SlaSnapshot,
  now: Date,
): { columns: SlaColumns; reached: readonly SlaEventKind[] } {
  if (policy === null) {
    return {
      columns: {
        slaPolicyId: null,
        firstResponseDueAt: null,
        resolutionDueAt: null,
        firstResponseSlaState: null,
        resolutionSlaState: null,
      },
      reached: [],
    };
  }
  const due = dueDates(policy, snapshot.startedAt, snapshot.pausedSeconds);
  const evaluation = evaluateSla(policy, snapshot, now);
  return {
    columns: {
      slaPolicyId: policy.id,
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      firstResponseSlaState: evaluation.firstResponseState,
      resolutionSlaState: evaluation.resolutionState,
    },
    reached: evaluation.reached,
  };
}

const NOTIFIED_KINDS: Readonly<Partial<Record<SlaEventKind, { type: string; clock: string; breach: boolean }>>> = {
  FIRST_RESPONSE_AT_RISK: { type: 'SUPPORT_SLA_AT_RISK', clock: 'FIRST_RESPONSE', breach: false },
  RESOLUTION_AT_RISK: { type: 'SUPPORT_SLA_AT_RISK', clock: 'RESOLUTION', breach: false },
  FIRST_RESPONSE_BREACHED: { type: 'SUPPORT_SLA_BREACHED', clock: 'FIRST_RESPONSE', breach: true },
  RESOLUTION_BREACHED: { type: 'SUPPORT_SLA_BREACHED', clock: 'RESOLUTION', breach: true },
};

/**
 * Records reached SLA conditions exactly once: each `sla_events` insert is skipped when the unique
 * (ticket, kind, level) row already exists, and only a newly inserted row produces a history entry
 * and notifications (assignee, or the assigned team when unassigned; project managers on breach).
 * Re-running the evaluation is therefore harmless. Returns the kinds that were newly recorded.
 */
export async function recordSlaConditions(
  db: TenantDb,
  organizationId: string,
  ticket: LoadedTicket,
  reached: readonly SlaEventKind[],
): Promise<SlaEventKind[]> {
  const recorded: SlaEventKind[] = [];
  for (const kind of reached) {
    const inserted = await db.slaEvent.createMany({
      data: [{ organizationId, ticketId: ticket.row.id, kind, level: 0 }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      continue;
    }
    recorded.push(kind);
    const spec = NOTIFIED_KINDS[kind];
    if (spec === undefined) {
      continue;
    }
    const eventId = await recordTicketEvent(db, organizationId, ticket.row.id, {
      type: spec.breach ? 'SLA_BREACHED' : 'SLA_AT_RISK',
      actorMemberId: null,
      metadata: { clock: spec.clock },
    });
    const owners =
      ticket.row.assigneeMemberId === null
        ? await teamMemberIds(db, organizationId, ticket.row.assignedTeamId)
        : [ticket.row.assigneeMemberId];
    await notifyTicketAudience(
      db,
      organizationId,
      ticket,
      spec.breach ? [...owners, ...projectManagerIds(ticket)] : owners,
      {
        type: spec.type,
        severity: spec.breach ? 'CRITICAL' : 'WARNING',
        email: true,
        causeId: eventId,
        params: { clock: spec.clock },
      },
      null,
    );
  }
  return recorded;
}

/** Records a pause or resume of the SLA clock (these may repeat, so they are always inserted). */
export async function recordSlaPause(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
  kind: 'PAUSED' | 'RESUMED',
  actorMemberId: string | null,
  status: TicketStatus,
): Promise<void> {
  await db.slaEvent.create({
    data: { organizationId, ticketId, kind, level: 0, metadata: { status } },
    select: { id: true },
  });
  await recordTicketEvent(db, organizationId, ticketId, {
    type: kind === 'PAUSED' ? 'SLA_PAUSED' : 'SLA_RESUMED',
    actorMemberId,
    metadata: { status },
  });
}
