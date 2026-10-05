import type { Prisma } from '@company-ops/db';
import type { CommercialReport, CommercialReportQuery } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { toCsv } from '../../platform/csv.js';
import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { Principal } from '../authorization/policy.js';
import { addDays, daysBetween } from '../projects/business-date.js';
import { fullContractWhere, fullTenderWhere } from './commercial-access.js';
import { dateOnly, iso, isoOrNull, memberRefSelect, organizationToday, toPersonRef } from './commercial-support.js';
import { renewalRequiredWhere } from './contract.service.js';
import { amendmentKey, contractKey, LIVE_CONTRACT_STATUSES } from './engine/contract-state.js';
import { formatAmount, totalsByCurrency } from './engine/money.js';
import { readinessPercent } from './engine/readiness.js';
import { ACTIVE_TENDER_STATUSES, PREPARATION_STATUSES, tenderKey } from './engine/tender-state.js';

/** Hard cap per export (the reports are operational lists, not a data warehouse). */
export const REPORT_ROW_LIMIT = 5000;
const DEFAULT_WITHIN_DAYS = 90;

type Cell = string | number | null;

export interface CommercialReportResult {
  readonly filename: string;
  readonly csv: string;
  readonly rows: number;
  readonly truncated: boolean;
}

interface Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}

const OPEN_REQUIREMENT: Prisma.EnumTenderRequirementStatusFilter<'TenderRequirement'> = {
  notIn: ['APPROVED', 'NOT_APPLICABLE'],
};
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const money = (amount: Prisma.Decimal | null): Cell => (amount === null ? null : formatAmount(amount));
const person = (row: Parameters<typeof toPersonRef>[0] | null): Cell => (row === null ? null : toPersonRef(row).name);

/**
 * Commercial CSV reports (spec §53). Only records the caller sees at FULL level are listed; money
 * columns exist only for callers holding the financial permission and are blank on rows outside its
 * scope; `contracts-by-value` requires the financial permission outright. Cells are guarded against
 * spreadsheet formula injection, exports are bounded and audited.
 */
export class CommercialReportService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async export(
    action: ActionContext,
    report: CommercialReport,
    query: CommercialReportQuery,
  ): Promise<CommercialReportResult> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const within = query.withinDays ?? DEFAULT_WITHIN_DAYS;
    const range: Prisma.DateTimeFilter | undefined =
      query.from === undefined && query.to === undefined
        ? undefined
        : {
            ...(query.from === undefined ? {} : { gte: day(query.from) }),
            ...(query.to === undefined ? {} : { lt: day(addDays(query.to, 1)) }),
          };
    const context: ReportContext = { organizationId, principal: action.principal, today, within, range };
    const table = await this.build(report, context);
    const truncated = table.rows.length > REPORT_ROW_LIMIT;
    const rows = truncated ? table.rows.slice(0, REPORT_ROW_LIMIT) : table.rows;
    await recordAudit(this.db, organizationId, {
      action: 'commercial.report_exported',
      entityType: 'commercial_report',
      entityId: null,
      actor: userActor(action),
      metadata: {
        report,
        rows: rows.length,
        truncated,
        from: query.from ?? null,
        to: query.to ?? null,
        withinDays: query.withinDays ?? null,
      },
      context: action.request,
    });
    return { filename: `${report}-${today}.csv`, csv: toCsv(table.header, rows), rows: rows.length, truncated };
  }

  private build(report: CommercialReport, c: ReportContext): Promise<Table> {
    switch (report) {
      case 'tender-pipeline':
        return this.tenderPipeline(c);
      case 'tender-win-loss':
        return this.tenderWinLoss(c);
      case 'tender-bid-decisions':
        return this.tenderBidDecisions(c);
      case 'tender-deadlines':
        return this.tenderDeadlines(c);
      case 'tender-readiness':
        return this.tenderReadiness(c);
      case 'tender-loss-reasons':
        return this.tenderLossReasons(c);
      case 'tender-workload':
        return this.tenderWorkload(c);
      case 'contracts-active':
        return this.contractsActive(c);
      case 'contracts-by-customer':
        return this.contractsByCustomer(c);
      case 'contracts-by-value':
        return this.contractsByValue(c);
      case 'contracts-expiring':
        return this.contractsExpiring(c);
      case 'contracts-renewal':
        return this.contractsRenewal(c);
      case 'obligations-overdue':
        return this.obligationsOverdue(c);
      case 'milestones-upcoming':
        return this.milestonesUpcoming(c);
      case 'guarantees-expiring':
        return this.guaranteesExpiring(c);
      case 'amendment-history':
        return this.amendmentHistory(c);
    }
  }

  // ---- scope helpers ----

  private tenderWhere(c: ReportContext): Prisma.TenderWhereInput {
    const where = fullTenderWhere(c.principal);
    if (where === null) throw new ForbiddenError();
    return { AND: [{ organizationId: c.organizationId }, where] };
  }

  private contractWhere(c: ReportContext): Prisma.ContractWhereInput {
    const where = fullContractWhere(c.principal);
    if (where === null) throw new ForbiddenError();
    return { AND: [{ organizationId: c.organizationId }, where] };
  }

  /** Ids (of `ids`) whose tender money the caller may see; null when the caller holds no financial scope. */
  private async tenderFinancialIds(c: ReportContext, ids: readonly string[]): Promise<Set<string> | null> {
    const where = fullTenderWhere(c.principal, 'tender.financial.view');
    if (where === null) return null;
    if (ids.length === 0) return new Set();
    const rows = await this.db.tender.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [{ organizationId: c.organizationId, id: { in: [...ids] } }, where],
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  private async contractFinancialIds(c: ReportContext, ids: readonly string[]): Promise<Set<string> | null> {
    const where = fullContractWhere(c.principal, 'contract.financial.view');
    if (where === null) return null;
    if (ids.length === 0) return new Set();
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [{ organizationId: c.organizationId, id: { in: [...ids] } }, where],
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  // ---- tender reports ----

  private async tenderPipeline(c: ReportContext): Promise<Table> {
    const rows = await this.db.tender.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [
          this.tenderWhere(c),
          { status: { in: [...ACTIVE_TENDER_STATUSES] } },
          ...(c.range ? [{ createdAt: c.range }] : []),
        ],
      },
      orderBy: [{ submissionDeadlineAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        id: true,
        number: true,
        year: true,
        title: true,
        status: true,
        priority: true,
        bidDecision: true,
        submissionDeadlineAt: true,
        estimatedValue: true,
        currency: true,
        customer: { select: { name: true } },
        counterpartyName: true,
        owner: { select: memberRefSelect },
      },
    });
    const financial = await this.tenderFinancialIds(
      c,
      rows.map((row) => row.id),
    );
    const header = ['key', 'title', 'customer', 'status', 'bid_decision', 'priority', 'owner', 'submission_deadline'];
    if (financial !== null) header.push('estimated_value', 'currency');
    return {
      header,
      rows: rows.map((row) => {
        const cells: Cell[] = [
          tenderKey(row.year, row.number),
          row.title,
          row.customer?.name ?? row.counterpartyName,
          row.status,
          row.bidDecision,
          row.priority,
          person(row.owner),
          isoOrNull(row.submissionDeadlineAt),
        ];
        if (financial !== null) {
          const visible = financial.has(row.id);
          cells.push(visible ? money(row.estimatedValue) : null, visible ? row.currency : null);
        }
        return cells;
      }),
    };
  }

  private async tenderWinLoss(c: ReportContext): Promise<Table> {
    const rows = await this.db.tender.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [
          this.tenderWhere(c),
          { status: { in: ['AWARDED', 'LOST'] } },
          ...(c.range ? [{ updatedAt: c.range }] : []),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        id: true,
        number: true,
        year: true,
        title: true,
        status: true,
        awardDate: true,
        awardValue: true,
        awardCurrency: true,
        currency: true,
        lossReason: true,
        winningCompany: true,
        winningValue: true,
        ourSubmittedValue: true,
        customer: { select: { name: true } },
        counterpartyName: true,
      },
    });
    const financial = await this.tenderFinancialIds(
      c,
      rows.map((row) => row.id),
    );
    const header = ['key', 'title', 'customer', 'result', 'award_date', 'loss_reason', 'winning_company'];
    if (financial !== null)
      header.push('award_value', 'award_currency', 'our_submitted_value', 'winning_value', 'currency');
    return {
      header,
      rows: rows.map((row) => {
        const cells: Cell[] = [
          tenderKey(row.year, row.number),
          row.title,
          row.customer?.name ?? row.counterpartyName,
          row.status,
          dateOnly(row.awardDate),
          row.lossReason,
          row.winningCompany,
        ];
        if (financial !== null) {
          const visible = financial.has(row.id);
          cells.push(
            visible ? money(row.awardValue) : null,
            visible ? row.awardCurrency : null,
            visible ? money(row.ourSubmittedValue) : null,
            visible ? money(row.winningValue) : null,
            visible ? row.currency : null,
          );
        }
        return cells;
      }),
    };
  }

  private async tenderBidDecisions(c: ReportContext): Promise<Table> {
    const rows = await this.db.tenderBidDecisionRecord.findMany({
      where: {
        organizationId: c.organizationId,
        tender: this.tenderWhere(c),
        ...(c.range ? { decidedAt: c.range } : {}),
      },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        decision: true,
        noBidReason: true,
        decidedAt: true,
        decidedBy: { select: memberRefSelect },
        tender: { select: { number: true, year: true, title: true } },
      },
    });
    return {
      header: ['key', 'title', 'decision', 'no_bid_reason', 'decided_by', 'decided_at'],
      rows: rows.map((row) => [
        tenderKey(row.tender.year, row.tender.number),
        row.tender.title,
        row.decision,
        row.noBidReason,
        person(row.decidedBy),
        iso(row.decidedAt),
      ]),
    };
  }

  private async tenderDeadlines(c: ReportContext): Promise<Table> {
    const until = day(addDays(c.today, c.within + 1));
    const rows = await this.db.tender.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [
          this.tenderWhere(c),
          { status: { in: [...ACTIVE_TENDER_STATUSES] } },
          { submissionDeadlineAt: { gte: this.clock(), lt: until } },
        ],
      },
      orderBy: [{ submissionDeadlineAt: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        number: true,
        year: true,
        title: true,
        status: true,
        submissionDeadlineAt: true,
        submissionDeadlineTimeZone: true,
        mandatoryApplicable: true,
        mandatoryApproved: true,
        owner: { select: memberRefSelect },
      },
    });
    return {
      header: ['key', 'title', 'status', 'submission_deadline', 'deadline_time_zone', 'readiness_percent', 'owner'],
      rows: rows.map((row) => [
        tenderKey(row.year, row.number),
        row.title,
        row.status,
        isoOrNull(row.submissionDeadlineAt),
        row.submissionDeadlineTimeZone,
        readinessPercent(row),
        person(row.owner),
      ]),
    };
  }

  private async tenderReadiness(c: ReportContext): Promise<Table> {
    const rows = await this.db.tender.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [this.tenderWhere(c), { status: { in: [...PREPARATION_STATUSES] } }],
      },
      orderBy: [{ submissionDeadlineAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        number: true,
        year: true,
        title: true,
        status: true,
        submissionDeadlineAt: true,
        requirementsTotal: true,
        mandatoryApplicable: true,
        mandatoryApproved: true,
        optionalApplicable: true,
        optionalApproved: true,
        blockedRequirements: true,
        unassignedRequirements: true,
      },
    });
    return {
      header: [
        'key',
        'title',
        'status',
        'submission_deadline',
        'requirements',
        'mandatory_approved',
        'mandatory_applicable',
        'optional_approved',
        'optional_applicable',
        'blocked',
        'unassigned',
        'readiness_percent',
      ],
      rows: rows.map((row) => [
        tenderKey(row.year, row.number),
        row.title,
        row.status,
        isoOrNull(row.submissionDeadlineAt),
        row.requirementsTotal,
        row.mandatoryApproved,
        row.mandatoryApplicable,
        row.optionalApproved,
        row.optionalApplicable,
        row.blockedRequirements,
        row.unassignedRequirements,
        readinessPercent(row),
      ]),
    };
  }

  private async tenderLossReasons(c: ReportContext): Promise<Table> {
    const groups = await this.db.tender.groupBy({
      by: ['lossReason'],
      where: {
        organizationId: c.organizationId,
        AND: [this.tenderWhere(c), { status: 'LOST' }, ...(c.range ? [{ updatedAt: c.range }] : [])],
      },
      _count: { _all: true },
      orderBy: { lossReason: 'asc' },
    });
    return {
      header: ['loss_reason', 'tenders'],
      rows: groups
        .map((group): Cell[] => [group.lossReason ?? 'UNSPECIFIED', group._count._all])
        .sort((a, b) => Number(b[1]) - Number(a[1])),
    };
  }

  private async tenderWorkload(c: ReportContext): Promise<Table> {
    const tenderWhere = this.tenderWhere(c);
    const [tenders, requirements, overdue] = await Promise.all([
      this.db.tender.groupBy({
        by: ['ownerMemberId'],
        where: {
          organizationId: c.organizationId,
          AND: [tenderWhere, { status: { in: [...ACTIVE_TENDER_STATUSES] } }],
        },
        _count: { _all: true },
        orderBy: { ownerMemberId: 'asc' },
      }),
      this.db.tenderRequirement.groupBy({
        by: ['ownerMemberId'],
        where: {
          organizationId: c.organizationId,
          ownerMemberId: { not: null },
          status: OPEN_REQUIREMENT,
          tender: { AND: [tenderWhere, { status: { in: [...ACTIVE_TENDER_STATUSES] } }] },
        },
        _count: { _all: true },
        orderBy: { ownerMemberId: 'asc' },
      }),
      this.db.tenderRequirement.groupBy({
        by: ['ownerMemberId'],
        where: {
          organizationId: c.organizationId,
          ownerMemberId: { not: null },
          status: OPEN_REQUIREMENT,
          dueDate: { lt: day(c.today) },
          tender: { AND: [tenderWhere, { status: { in: [...ACTIVE_TENDER_STATUSES] } }] },
        },
        _count: { _all: true },
        orderBy: { ownerMemberId: 'asc' },
      }),
    ]);
    const counts = new Map<string, [number, number, number]>();
    const bump = (memberId: string | null, index: 0 | 1 | 2, value: number): void => {
      if (memberId === null) return;
      const entry = counts.get(memberId) ?? [0, 0, 0];
      entry[index] = value;
      counts.set(memberId, entry);
    };
    for (const group of tenders) bump(group.ownerMemberId, 0, group._count._all);
    for (const group of requirements) bump(group.ownerMemberId, 1, group._count._all);
    for (const group of overdue) bump(group.ownerMemberId, 2, group._count._all);
    const members = await this.db.organizationMember.findMany({
      where: { organizationId: c.organizationId, id: { in: [...counts.keys()] } },
      select: memberRefSelect,
    });
    const names = new Map(members.map((member) => [member.id, toPersonRef(member).name]));
    return {
      header: ['owner', 'active_tenders_owned', 'open_requirements', 'overdue_requirements'],
      rows: [...counts.entries()]
        .map(([memberId, [owned, open, late]]): Cell[] => [names.get(memberId) ?? null, owned, open, late])
        .sort((a, b) => Number(b[2]) - Number(a[2]) || Number(b[1]) - Number(a[1])),
    };
  }

  // ---- contract reports ----

  private readonly contractRowSelect = {
    id: true,
    number: true,
    year: true,
    title: true,
    status: true,
    health: true,
    contractType: true,
    startDate: true,
    currentExpiryDate: true,
    renewalType: true,
    renewalNoticeDeadline: true,
    renewalDecision: true,
    currentValue: true,
    currency: true,
    customer: { select: { name: true } },
    counterpartyName: true,
    owner: { select: memberRefSelect },
  } satisfies Prisma.ContractSelect;

  private async contractsActive(c: ReportContext): Promise<Table> {
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [this.contractWhere(c), { status: { in: [...LIVE_CONTRACT_STATUSES] } }],
      },
      orderBy: [{ currentExpiryDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: this.contractRowSelect,
    });
    const financial = await this.contractFinancialIds(
      c,
      rows.map((row) => row.id),
    );
    const header = ['key', 'title', 'customer', 'type', 'status', 'health', 'start_date', 'expiry_date', 'owner'];
    if (financial !== null) header.push('current_value', 'currency');
    return {
      header,
      rows: rows.map((row) => {
        const cells: Cell[] = [
          contractKey(row.year, row.number),
          row.title,
          row.customer?.name ?? row.counterpartyName,
          row.contractType,
          row.status,
          row.health,
          dateOnly(row.startDate),
          dateOnly(row.currentExpiryDate),
          person(row.owner),
        ];
        if (financial !== null) {
          const visible = financial.has(row.id);
          cells.push(visible ? money(row.currentValue) : null, visible ? row.currency : null);
        }
        return cells;
      }),
    };
  }

  private async contractsByCustomer(c: ReportContext): Promise<Table> {
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [this.contractWhere(c), { status: { in: [...LIVE_CONTRACT_STATUSES] } }],
      },
      take: REPORT_ROW_LIMIT + 1,
      select: {
        id: true,
        currentValue: true,
        currency: true,
        customer: { select: { name: true } },
        counterpartyName: true,
      },
    });
    const financial = await this.contractFinancialIds(
      c,
      rows.map((row) => row.id),
    );
    const groups = new Map<string, { count: number; values: { amount: Prisma.Decimal; currency: string }[] }>();
    for (const row of rows) {
      const name = row.customer?.name ?? row.counterpartyName ?? '—';
      const group = groups.get(name) ?? { count: 0, values: [] };
      group.count += 1;
      if (financial?.has(row.id) === true) group.values.push({ amount: row.currentValue, currency: row.currency });
      groups.set(name, group);
    }
    const header = ['customer', 'live_contracts'];
    if (financial !== null) header.push('visible_value_by_currency');
    return {
      header,
      rows: [...groups.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([name, group]) => {
          const cells: Cell[] = [name, group.count];
          if (financial !== null) {
            cells.push(
              totalsByCurrency(group.values)
                .map((total) => `${total.amount} ${total.currency}`)
                .join('; '),
            );
          }
          return cells;
        }),
    };
  }

  private async contractsByValue(c: ReportContext): Promise<Table> {
    const financialWhere = fullContractWhere(c.principal, 'contract.financial.view');
    if (financialWhere === null) throw new ForbiddenError('This report needs the contract financial permission.');
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [this.contractWhere(c), financialWhere, { status: { in: [...LIVE_CONTRACT_STATUSES] } }],
      },
      orderBy: [{ currency: 'asc' }, { currentValue: 'desc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: this.contractRowSelect,
    });
    return {
      header: ['key', 'title', 'customer', 'status', 'current_value', 'currency', 'expiry_date', 'owner'],
      rows: rows.map((row) => [
        contractKey(row.year, row.number),
        row.title,
        row.customer?.name ?? row.counterpartyName,
        row.status,
        money(row.currentValue),
        row.currency,
        dateOnly(row.currentExpiryDate),
        person(row.owner),
      ]),
    };
  }

  private async contractsExpiring(c: ReportContext): Promise<Table> {
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [
          this.contractWhere(c),
          { status: { in: [...LIVE_CONTRACT_STATUSES] } },
          { currentExpiryDate: { gte: day(c.today), lte: day(addDays(c.today, c.within)) } },
        ],
      },
      orderBy: [{ currentExpiryDate: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: this.contractRowSelect,
    });
    return {
      header: [
        'key',
        'title',
        'customer',
        'status',
        'expiry_date',
        'days_left',
        'renewal_type',
        'notice_deadline',
        'renewal_decision',
        'owner',
      ],
      rows: rows.map((row) => {
        const expiry = dateOnly(row.currentExpiryDate);
        return [
          contractKey(row.year, row.number),
          row.title,
          row.customer?.name ?? row.counterpartyName,
          row.status,
          expiry,
          expiry === null ? null : daysBetween(c.today, expiry),
          row.renewalType,
          dateOnly(row.renewalNoticeDeadline),
          row.renewalDecision,
          person(row.owner),
        ];
      }),
    };
  }

  private async contractsRenewal(c: ReportContext): Promise<Table> {
    const rows = await this.db.contract.findMany({
      where: {
        organizationId: c.organizationId,
        AND: [this.contractWhere(c), { OR: [renewalRequiredWhere(c.today), { status: 'RENEWAL_REVIEW' }] }],
      },
      orderBy: [{ renewalNoticeDeadline: { sort: 'asc', nulls: 'last' } }, { currentExpiryDate: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: this.contractRowSelect,
    });
    return {
      header: [
        'key',
        'title',
        'customer',
        'status',
        'renewal_type',
        'expiry_date',
        'notice_deadline',
        'renewal_decision',
        'owner',
      ],
      rows: rows.map((row) => [
        contractKey(row.year, row.number),
        row.title,
        row.customer?.name ?? row.counterpartyName,
        row.status,
        row.renewalType,
        dateOnly(row.currentExpiryDate),
        dateOnly(row.renewalNoticeDeadline),
        row.renewalDecision,
        person(row.owner),
      ]),
    };
  }

  private async obligationsOverdue(c: ReportContext): Promise<Table> {
    const rows = await this.db.contractObligationOccurrence.findMany({
      where: {
        organizationId: c.organizationId,
        status: { in: ['UPCOMING', 'IN_PROGRESS'] },
        dueDate: { lt: day(c.today) },
        contract: this.contractWhere(c),
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        dueDate: true,
        status: true,
        owner: { select: memberRefSelect },
        obligation: { select: { title: true, category: true, criticality: true } },
        contract: { select: { number: true, year: true, title: true } },
      },
    });
    return {
      header: [
        'contract',
        'contract_title',
        'obligation',
        'category',
        'criticality',
        'due_date',
        'days_overdue',
        'status',
        'owner',
      ],
      rows: rows.map((row) => {
        const due = dateOnly(row.dueDate) ?? c.today;
        return [
          contractKey(row.contract.year, row.contract.number),
          row.contract.title,
          row.obligation.title,
          row.obligation.category,
          row.obligation.criticality,
          due,
          daysBetween(due, c.today),
          row.status,
          person(row.owner),
        ];
      }),
    };
  }

  private async milestonesUpcoming(c: ReportContext): Promise<Table> {
    const rows = await this.db.contractMilestone.findMany({
      where: {
        organizationId: c.organizationId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        dueDate: { lte: day(addDays(c.today, c.within)) },
        contract: this.contractWhere(c),
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        title: true,
        dueDate: true,
        status: true,
        approvalRequired: true,
        owner: { select: memberRefSelect },
        contract: { select: { number: true, year: true, title: true } },
      },
    });
    return {
      header: ['contract', 'contract_title', 'milestone', 'due_date', 'status', 'approval_required', 'owner'],
      rows: rows.map((row) => {
        const due = dateOnly(row.dueDate);
        return [
          contractKey(row.contract.year, row.contract.number),
          row.contract.title,
          row.title,
          due,
          due !== null && due < c.today ? 'OVERDUE' : row.status,
          row.approvalRequired ? 'yes' : 'no',
          person(row.owner),
        ];
      }),
    };
  }

  private async guaranteesExpiring(c: ReportContext): Promise<Table> {
    const tenderWhere = fullTenderWhere(c.principal);
    const contractWhere = fullContractWhere(c.principal);
    const parents: Prisma.GuaranteeWhereInput[] = [];
    if (tenderWhere !== null) parents.push({ tender: { AND: [{ organizationId: c.organizationId }, tenderWhere] } });
    if (contractWhere !== null)
      parents.push({ contract: { AND: [{ organizationId: c.organizationId }, contractWhere] } });
    if (parents.length === 0) throw new ForbiddenError();
    const rows = await this.db.guarantee.findMany({
      where: {
        organizationId: c.organizationId,
        status: { in: ['ACTIVE', 'EXPIRED'] },
        expiryDate: { lte: day(addDays(c.today, c.within)) },
        OR: parents,
      },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        type: true,
        referenceNumber: true,
        issuer: true,
        expiryDate: true,
        status: true,
        amount: true,
        currency: true,
        tenderId: true,
        contractId: true,
        owner: { select: memberRefSelect },
        tender: { select: { number: true, year: true } },
        contract: { select: { number: true, year: true } },
      },
    });
    const tenderMoney = await this.tenderFinancialIds(
      c,
      rows.flatMap((row) => (row.tenderId === null ? [] : [row.tenderId])),
    );
    const contractMoney = await this.contractFinancialIds(
      c,
      rows.flatMap((row) => (row.contractId === null ? [] : [row.contractId])),
    );
    const anyMoney = tenderMoney !== null || contractMoney !== null;
    const header = ['parent', 'type', 'reference', 'issuer', 'expiry_date', 'days_left', 'status', 'owner'];
    if (anyMoney) header.push('amount', 'currency');
    return {
      header,
      rows: rows.map((row) => {
        const expiry = dateOnly(row.expiryDate) ?? c.today;
        const cells: Cell[] = [
          row.tender !== null
            ? tenderKey(row.tender.year, row.tender.number)
            : row.contract !== null
              ? contractKey(row.contract.year, row.contract.number)
              : null,
          row.type,
          row.referenceNumber,
          row.issuer,
          expiry,
          daysBetween(c.today, expiry),
          row.status === 'ACTIVE' && expiry < c.today ? 'EXPIRED' : row.status,
          person(row.owner),
        ];
        if (anyMoney) {
          const visible =
            (row.tenderId !== null && tenderMoney?.has(row.tenderId) === true) ||
            (row.contractId !== null && contractMoney?.has(row.contractId) === true);
          cells.push(visible ? money(row.amount) : null, visible ? row.currency : null);
        }
        return cells;
      }),
    };
  }

  private async amendmentHistory(c: ReportContext): Promise<Table> {
    const rows = await this.db.contractAmendment.findMany({
      where: {
        organizationId: c.organizationId,
        contract: this.contractWhere(c),
        ...(c.range ? { createdAt: c.range } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REPORT_ROW_LIMIT + 1,
      select: {
        contractId: true,
        number: true,
        type: true,
        title: true,
        status: true,
        effectiveDate: true,
        valueDelta: true,
        currency: true,
        newExpiryDate: true,
        approvedAt: true,
        activatedAt: true,
        createdAt: true,
        contract: { select: { number: true, year: true, title: true } },
      },
    });
    const financial = await this.contractFinancialIds(c, [...new Set(rows.map((row) => row.contractId))]);
    const header = [
      'contract',
      'amendment',
      'type',
      'title',
      'status',
      'effective_date',
      'new_expiry_date',
      'approved_at',
      'activated_at',
      'created_at',
    ];
    if (financial !== null) header.push('value_delta', 'currency');
    return {
      header,
      rows: rows.map((row) => {
        const cells: Cell[] = [
          contractKey(row.contract.year, row.contract.number),
          amendmentKey(row.contract.year, row.contract.number, row.number),
          row.type,
          row.title,
          row.status,
          dateOnly(row.effectiveDate),
          dateOnly(row.newExpiryDate),
          isoOrNull(row.approvedAt),
          isoOrNull(row.activatedAt),
          iso(row.createdAt),
        ];
        if (financial !== null) {
          const visible = financial.has(row.contractId);
          cells.push(visible ? money(row.valueDelta) : null, visible ? row.currency : null);
        }
        return cells;
      }),
    };
  }
}

interface ReportContext {
  readonly organizationId: string;
  readonly principal: Principal;
  readonly today: string;
  readonly within: number;
  readonly range: Prisma.DateTimeFilter | undefined;
}
