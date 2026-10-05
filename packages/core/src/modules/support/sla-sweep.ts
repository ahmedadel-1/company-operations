import type { Prisma, SlaEventKind } from '@company-ops/db';

import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { ticketAccessSelect, ticketFacts } from './ticket-access.js';
import type { LoadedTicket, TicketAccessRow } from './ticket-access.js';
import { recordTicketEvent } from './ticket-history.js';
import { announceTicketChange, notifyTicketAudience, projectManagerIds } from './ticket-notify.js';
import { recordSlaConditions, SlaContext, slaColumns, snapshotOf } from './ticket-sla.js';
import type { SlaColumns } from './ticket-sla.js';
import { matchesTicket, parseEscalationNotify, parseTicketMatch } from './sla-config.js';
import type { SlaPolicyClock } from './sla-config.js';
import { escalationTriggered } from './sla-evaluator.js';
import { CLOCK_STOPPED_STATUSES } from './ticket-state-machine.js';
import { MAX_ESCALATION_LEVEL } from './ticket-workflow.js';

export const SLA_SWEEP_BATCH_SIZE = 200;

export interface SlaSweepResult {
  readonly tickets: number;
  readonly updated: number;
  readonly conditions: number;
  readonly escalations: number;
}

const ruleSelect = {
  id: true,
  slaPolicyId: true,
  match: true,
  level: true,
  trigger: true,
  threshold: true,
  notify: true,
} satisfies Prisma.EscalationRuleSelect;

type RuleRow = Prisma.EscalationRuleGetPayload<{ select: typeof ruleSelect }>;

/**
 * Scheduled SLA evaluation (`sla.sweep`, `sla` queue) for the organization of the active system
 * tenant context. Walks open tickets in keyset batches; for each it refreshes the SLA columns
 * (due dates follow policy edits; states follow the clock), records newly reached at-risk/breach
 * conditions and fires escalation rules. Everything is idempotent: conditions and escalations are
 * recorded once per ticket, kind and level by the unique `sla_events` key, so retries and overlapping
 * runs never notify twice. Updates are conditioned on the ticket version read, so a concurrent user
 * change wins and the ticket is simply re-evaluated on the next run.
 */
export class SlaSweep {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async run(now: Date): Promise<SlaSweepResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const rules = await this.db.escalationRule.findMany({
      where: { organizationId, active: true },
      orderBy: [{ level: 'asc' }, { id: 'asc' }],
      select: ruleSelect,
    });
    const sla = new SlaContext(this.db, organizationId);
    let tickets = 0;
    let updated = 0;
    let conditions = 0;
    let escalations = 0;
    let after: string | null = null;
    for (;;) {
      const rows: TicketAccessRow[] = await this.db.supportTicket.findMany({
        where: {
          organizationId,
          status: { notIn: [...CLOCK_STOPPED_STATUSES] },
          ...(after === null ? {} : { id: { gt: after } }),
        },
        orderBy: { id: 'asc' },
        take: SLA_SWEEP_BATCH_SIZE,
        select: ticketAccessSelect,
      });
      for (const row of rows) {
        tickets += 1;
        const outcome = await this.db.$transaction((tx) => this.evaluate(tx, organizationId, sla, rules, row, now));
        updated += outcome.updated ? 1 : 0;
        conditions += outcome.conditions;
        escalations += outcome.escalations;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < SLA_SWEEP_BATCH_SIZE) {
        break;
      }
      after = last.id;
    }
    return { tickets, updated, conditions, escalations };
  }

  private async evaluate(
    tx: TenantDb,
    organizationId: string,
    sla: SlaContext,
    rules: readonly RuleRow[],
    row: TicketAccessRow,
    now: Date,
  ): Promise<{ updated: boolean; conditions: number; escalations: number }> {
    const ticket: LoadedTicket = { row, facts: ticketFacts(organizationId, row) };
    const policy = await sla.policyOf(row, row.project?.timeZone ?? null);
    let changed = false;
    let conditions = 0;
    let snapshot = snapshotOf(row);
    if (policy !== null) {
      const evaluated = slaColumns(policy, snapshot, now);
      if (differs(row, evaluated.columns)) {
        const result = await tx.supportTicket.updateMany({
          where: { organizationId, id: row.id, version: row.version },
          data: {
            firstResponseDueAt: evaluated.columns.firstResponseDueAt,
            resolutionDueAt: evaluated.columns.resolutionDueAt,
            firstResponseSlaState: evaluated.columns.firstResponseSlaState,
            resolutionSlaState: evaluated.columns.resolutionSlaState,
          },
        });
        if (result.count === 0) {
          return { updated: false, conditions: 0, escalations: 0 };
        }
        changed = true;
      }
      conditions = (await recordSlaConditions(tx, organizationId, ticket, evaluated.reached)).length;
      snapshot = {
        ...snapshot,
        firstResponseState: evaluated.columns.firstResponseSlaState,
        resolutionState: evaluated.columns.resolutionSlaState,
      };
    }
    let escalations = 0;
    let level = row.escalationLevel;
    for (const rule of rules) {
      if (
        (rule.slaPolicyId !== null && rule.slaPolicyId !== policy?.id) ||
        !matchesTicket(parseTicketMatch(rule.match), row) ||
        !escalationTriggered(rule, policy, snapshot, now)
      ) {
        continue;
      }
      if (await this.escalate(tx, organizationId, ticket, policy, rule, level)) {
        escalations += 1;
        level = Math.max(level, rule.level);
      }
    }
    if (changed || conditions > 0 || escalations > 0) {
      await announceTicketChange(tx, organizationId, row.id, escalations > 0);
    }
    return { updated: changed, conditions, escalations };
  }

  /** Records the rule's level once per ticket and notifies its recipients. */
  private async escalate(
    tx: TenantDb,
    organizationId: string,
    ticket: LoadedTicket,
    policy: SlaPolicyClock | null,
    rule: RuleRow,
    currentLevel: number,
  ): Promise<boolean> {
    const kind: SlaEventKind = 'ESCALATED';
    const inserted = await tx.slaEvent.createMany({
      data: [
        {
          organizationId,
          ticketId: ticket.row.id,
          kind,
          level: rule.level,
          escalationRuleId: rule.id,
          metadata: { trigger: rule.trigger, threshold: rule.threshold, slaPolicyId: policy?.id ?? null },
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      return false;
    }
    const level = Math.min(MAX_ESCALATION_LEVEL, Math.max(currentLevel, rule.level));
    if (level !== currentLevel) {
      await tx.supportTicket.updateMany({
        where: { organizationId, id: ticket.row.id, escalationLevel: { lt: level } },
        data: { escalationLevel: level },
      });
    }
    const eventId = await recordTicketEvent(tx, organizationId, ticket.row.id, {
      type: 'SLA_ESCALATED',
      actorMemberId: null,
      from: { escalationLevel: currentLevel },
      to: { escalationLevel: level },
      metadata: { ruleId: rule.id, trigger: rule.trigger, level: rule.level },
    });
    const recipients = await escalationRecipients(tx, organizationId, ticket, rule);
    await notifyTicketAudience(
      tx,
      organizationId,
      ticket,
      recipients,
      {
        type: 'SUPPORT_TICKET_ESCALATED',
        severity: 'WARNING',
        email: true,
        causeId: eventId,
        params: { level: rule.level },
      },
      null,
    );
    return true;
  }
}

function differs(row: TicketAccessRow, columns: SlaColumns): boolean {
  return (
    row.firstResponseDueAt?.getTime() !== columns.firstResponseDueAt?.getTime() ||
    row.resolutionDueAt?.getTime() !== columns.resolutionDueAt?.getTime() ||
    row.firstResponseSlaState !== columns.firstResponseSlaState ||
    row.resolutionSlaState !== columns.resolutionSlaState
  );
}

/**
 * The assignee, plus the rule's recipients: holders of the listed organization roles, members with
 * the listed roles on the ticket's project (and its PM/TM for the manager roles) and explicit
 * members. Each recipient is still filtered by their own ticket scope when notified.
 */
async function escalationRecipients(
  db: TenantDb,
  organizationId: string,
  ticket: LoadedTicket,
  rule: RuleRow,
): Promise<string[]> {
  const notify = parseEscalationNotify(rule.notify);
  const recipients: string[] = [...notify.memberIds];
  if (ticket.row.assigneeMemberId !== null) {
    recipients.push(ticket.row.assigneeMemberId);
  }
  if (notify.roles.length > 0) {
    const holders = await db.memberRole.findMany({
      where: { organizationId, role: { key: { in: [...notify.roles] } }, member: { status: 'ACTIVE' } },
      select: { memberId: true },
      take: 200,
    });
    recipients.push(...holders.map((holder) => holder.memberId));
  }
  if (notify.projectRoles.length > 0 && ticket.row.projectId !== null) {
    const members = await db.projectMember.findMany({
      where: { organizationId, projectId: ticket.row.projectId, projectRole: { in: [...notify.projectRoles] } },
      select: { profile: { select: { memberId: true } } },
      take: 200,
    });
    recipients.push(...members.map((member) => member.profile.memberId));
    if (notify.projectRoles.includes('PROJECT_MANAGER') || notify.projectRoles.includes('TECHNICAL_MANAGER')) {
      recipients.push(...projectManagerIds(ticket));
    }
  }
  return recipients;
}
