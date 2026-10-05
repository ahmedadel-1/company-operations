import type { ContractListQuery, CorporateDocumentListQuery, TenderListQuery } from '@company-ops/validation';

import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import type { Principal } from '../authorization/policy.js';
import { dashboardLink, metric } from '../dashboard/links.js';
import type { DashboardMetric } from '../dashboard/links.js';
import { fullContractWhere } from './commercial-access.js';
import { organizationToday } from './commercial-support.js';
import { contractListWhere } from './contract.service.js';
import { corporateDocumentListWhere } from './corporate-document.service.js';
import { LIVE_CONTRACT_STATUSES } from './engine/contract-state.js';
import { formatAmount } from './engine/money.js';
import type { Money } from './engine/money.js';
import { ACTIVE_TENDER_STATUSES } from './engine/tender-state.js';
import { tenderListWhere } from './tender.service.js';

export interface TenderMetrics {
  readonly active: DashboardMetric;
  readonly closingIn7Days: DashboardMetric;
  readonly closingIn30Days: DashboardMetric;
  readonly notReady: DashboardMetric;
  readonly awaitingFinalApproval: DashboardMetric;
  readonly submittedThisMonth: DashboardMetric;
  readonly awardedYtd: DashboardMetric;
  readonly lostYtd: DashboardMetric;
}

export interface ContractMetrics {
  readonly active: DashboardMetric;
  readonly expiringIn90Days: DashboardMetric;
  readonly renewalRequired: DashboardMetric;
  readonly noticeApproaching: DashboardMetric;
  readonly withOverdueObligations: DashboardMetric;
  readonly withOverdueMilestones: DashboardMetric;
  readonly expiringGuarantees: DashboardMetric;
  readonly atRisk: DashboardMetric;
}

export interface CommercialSection {
  readonly tenders: TenderMetrics | null;
  readonly contracts: ContractMetrics | null;
  readonly activeContractValue: readonly Money[] | null;
  readonly documents: { readonly expiring: DashboardMetric; readonly expired: DashboardMetric } | null;
}

type TenderFilter = Omit<TenderListQuery, 'cursor' | 'limit' | 'sort'>;
type ContractFilter = Omit<ContractListQuery, 'cursor' | 'limit' | 'sort'>;
type DocumentFilter = Omit<CorporateDocumentListQuery, 'cursor' | 'limit'>;

/** Query string of a list filter (arrays as comma lists, booleans as `true`). */
function linkQuery(filter: Readonly<Record<string, unknown>>): Record<string, string | readonly string[] | undefined> {
  const out: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === 'string');
  }
  return out;
}

/** Permissions whose scope changes the commercial section (cache key input). */
export const COMMERCIAL_DASHBOARD_PERMISSIONS = [
  'tender.view',
  'contract.view',
  'contract.financial.view',
  'corporate_document.view',
  'corporate_document.restricted.view',
] as const;

export function holdsCommercialView(principal: Principal): boolean {
  return (
    hasPermission(principal.permissions, 'tender.view') ||
    hasPermission(principal.permissions, 'contract.view') ||
    hasPermission(principal.permissions, 'corporate_document.view')
  );
}

/**
 * Commercial numbers (spec §50, ADR-0026): every metric is counted with the list's own filter builder
 * in the caller's server-resolved visibility, and links to that list with the same filters. Each
 * group is null without its view permission; the active contract value is summed per currency (never
 * converted) only over contracts the caller may see the money of.
 */
export async function commercialSection(
  db: TenantScopedClient,
  principal: Principal,
  organizationId: string,
  now: Date,
): Promise<CommercialSection | null> {
  if (!holdsCommercialView(principal)) return null;
  const { today, timeZone } = await organizationToday(db, organizationId, now);
  const year = today.slice(0, 4);
  const monthStart = `${today.slice(0, 7)}-01`;

  const tenderMetric = async (filter: TenderFilter): Promise<DashboardMetric> => {
    const where = tenderListWhere(db, principal, filter, now, timeZone);
    const value = where === null ? 0 : await db.tender.count({ where: { organizationId, AND: where } });
    return metric(value, dashboardLink('/tenders', linkQuery(filter)));
  };
  const contractMetric = async (filter: ContractFilter): Promise<DashboardMetric> => {
    const where = contractListWhere(principal, filter, today);
    const value = where === null ? 0 : await db.contract.count({ where: { organizationId, AND: where } });
    return metric(value, dashboardLink('/contracts', linkQuery(filter)));
  };
  const documentMetric = async (filter: DocumentFilter): Promise<DashboardMetric> => {
    const where = corporateDocumentListWhere(principal, filter, today);
    const value = where === null ? 0 : await db.corporateDocument.count({ where: { organizationId, AND: where } });
    return metric(value, dashboardLink('/documents', linkQuery(filter)));
  };

  const tenders: TenderMetrics | null = hasPermission(principal.permissions, 'tender.view')
    ? {
        active: await tenderMetric({ status: [...ACTIVE_TENDER_STATUSES] }),
        closingIn7Days: await tenderMetric({ deadline: 'next7' }),
        closingIn30Days: await tenderMetric({ deadline: 'next30' }),
        notReady: await tenderMetric({ status: ['PREPARING', 'INTERNAL_REVIEW'], readiness: 'not_ready' }),
        awaitingFinalApproval: await tenderMetric({ stage: 'final_approval' }),
        submittedThisMonth: await tenderMetric({ submittedFrom: monthStart }),
        awardedYtd: await tenderMetric({ status: ['AWARDED'], awardedFrom: `${year}-01-01` }),
        lostYtd: await tenderMetric({ status: ['LOST'], closedFrom: `${year}-01-01` }),
      }
    : null;

  const contracts: ContractMetrics | null = hasPermission(principal.permissions, 'contract.view')
    ? {
        active: await contractMetric({ status: [...LIVE_CONTRACT_STATUSES] }),
        expiringIn90Days: await contractMetric({ expiringWithinDays: 90 }),
        renewalRequired: await contractMetric({ renewalRequired: true }),
        noticeApproaching: await contractMetric({ noticeApproaching: true }),
        withOverdueObligations: await contractMetric({ overdueObligations: true }),
        withOverdueMilestones: await contractMetric({ overdueMilestones: true }),
        expiringGuarantees: await contractMetric({ guaranteesExpiring: true }),
        atRisk: await contractMetric({ health: ['AT_RISK', 'CRITICAL'] }),
      }
    : null;

  let activeContractValue: Money[] | null = null;
  const viewWhere = fullContractWhere(principal);
  const moneyWhere = fullContractWhere(principal, 'contract.financial.view');
  if (hasPermission(principal.permissions, 'contract.financial.view') && viewWhere !== null && moneyWhere !== null) {
    const groups = await db.contract.groupBy({
      by: ['currency'],
      where: { organizationId, AND: [viewWhere, moneyWhere, { status: { in: [...LIVE_CONTRACT_STATUSES] } }] },
      _sum: { currentValue: true },
      orderBy: { currency: 'asc' },
    });
    activeContractValue = groups.flatMap((group) =>
      group._sum.currentValue === null
        ? []
        : [{ currency: group.currency, amount: formatAmount(group._sum.currentValue) }],
    );
  } else if (hasPermission(principal.permissions, 'contract.financial.view')) {
    activeContractValue = [];
  }

  const documents = hasPermission(principal.permissions, 'corporate_document.view')
    ? {
        expiring: await documentMetric({ validity: ['EXPIRING'] }),
        expired: await documentMetric({ validity: ['EXPIRED'] }),
      }
    : null;

  return { tenders, contracts, activeContractValue, documents };
}
