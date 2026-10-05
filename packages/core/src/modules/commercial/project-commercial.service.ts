import type { TenderStatus } from '@company-ops/db';

import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { addDays } from '../projects/business-date.js';
import { loadVisibleProject } from '../projects/project-access.js';
import { fullContractWhere, fullTenderWhere } from './commercial-access.js';
import { isoOrNull, organizationToday } from './commercial-support.js';
import type { ContractWorkService, MilestoneView, OccurrenceView } from './contract-work.service.js';
import { contractRowFinancialVisible, contractSummarySelect, toContractSummary } from './contract-views.js';
import type { ContractSummaryView } from './contract-views.js';
import { CLOSED_CONTRACT_STATUSES } from './engine/contract-state.js';
import { tenderKey } from './engine/tender-state.js';
import type { GuaranteeService, GuaranteeView } from './guarantee.service.js';

export interface ProjectCommercialView {
  readonly tenders: readonly {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly status: TenderStatus;
    readonly submissionDeadlineAt: string | null;
  }[];
  readonly contracts: readonly ContractSummaryView[];
  readonly upcomingObligations: readonly OccurrenceView[];
  readonly milestones: readonly MilestoneView[];
  readonly guarantees: readonly GuaranteeView[];
}

/** Contracts whose work items are aggregated into the tab (the rest stay one click away). */
const CONTRACTS_LIMIT = 20;
const ITEMS_LIMIT = 50;
const UPCOMING_DAYS = 30;

/**
 * The project's Commercial tab (spec §49): originating tenders, linked contracts with health and
 * expiry, and their open obligations, milestones and guarantees. Needs `project.view`; every record
 * is still filtered by its own rule (FULL tender/contract visibility), money follows
 * `*.financial.view` per record, and nothing is copied: the tab only reads the canonical rows.
 */
export class ProjectCommercialService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly work: ContractWorkService,
    private readonly guarantees: GuaranteeService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async forProject(action: ActionContext, projectId: string): Promise<ProjectCommercialView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await loadVisibleProject(this.db, action, organizationId, projectId);
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const contractWhere = fullContractWhere(action.principal);
    const tenderWhere = fullTenderWhere(action.principal);

    const contractRows =
      contractWhere === null
        ? []
        : await this.db.contract.findMany({
            where: { organizationId, AND: [{ organizationId, projectId }, contractWhere] },
            orderBy: [{ status: 'asc' }, { currentExpiryDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            take: CONTRACTS_LIMIT,
            select: { ...contractSummarySelect, sourceTenderId: true },
          });
    const sourceTenderIds = contractRows.flatMap((row) => (row.sourceTenderId === null ? [] : [row.sourceTenderId]));
    const tenders =
      tenderWhere === null
        ? []
        : await this.db.tender.findMany({
            where: {
              organizationId,
              AND: [
                { organizationId },
                {
                  OR: [
                    { relatedProjectId: projectId },
                    ...(sourceTenderIds.length > 0 ? [{ id: { in: sourceTenderIds } }] : []),
                  ],
                },
                tenderWhere,
              ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: ITEMS_LIMIT,
            select: { id: true, number: true, year: true, title: true, status: true, submissionDeadlineAt: true },
          });

    const contracts = contractRows.map((row) =>
      toContractSummary(row, contractRowFinancialVisible(action.principal, organizationId, row), today),
    );
    const horizon = addDays(today, UPCOMING_DAYS);
    const occurrences: OccurrenceView[] = [];
    const milestones: MilestoneView[] = [];
    const guarantees: GuaranteeView[] = [];
    for (const row of contractRows) {
      if (CLOSED_CONTRACT_STATUSES.includes(row.status)) continue;
      const [open, contractMilestones, contractGuarantees] = await Promise.all([
        this.work.listOccurrences(action, row.id, { status: ['UPCOMING', 'IN_PROGRESS', 'OVERDUE'] }),
        this.work.listMilestones(action, row.id),
        this.guarantees.listForContract(action, row.id),
      ]);
      occurrences.push(...open.filter((occurrence) => occurrence.dueDate <= horizon));
      milestones.push(
        ...contractMilestones.filter(
          (milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED',
        ),
      );
      guarantees.push(
        ...contractGuarantees.filter(
          (guarantee) => guarantee.status !== 'RELEASED' && guarantee.status !== 'CANCELLED',
        ),
      );
    }
    const byDue = <T extends { readonly dueDate: string }>(a: T, b: T): number => a.dueDate.localeCompare(b.dueDate);
    return {
      tenders: tenders.map((row) => ({
        id: row.id,
        key: tenderKey(row.year, row.number),
        title: row.title,
        status: row.status,
        submissionDeadlineAt: isoOrNull(row.submissionDeadlineAt),
      })),
      contracts,
      upcomingObligations: occurrences.sort(byDue).slice(0, ITEMS_LIMIT),
      milestones: milestones.sort(byDue).slice(0, ITEMS_LIMIT),
      guarantees: guarantees.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)).slice(0, ITEMS_LIMIT),
    };
  }
}
