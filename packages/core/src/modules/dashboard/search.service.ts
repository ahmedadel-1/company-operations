import type { Prisma } from '@company-ops/db';

import { escapeLike } from '../../platform/db/like.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { isEmptyListScope, listScope } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { fullContractWhere, fullTenderWhere } from '../commercial/commercial-access.js';
import { organizationToday } from '../commercial/commercial-support.js';
import { contractListWhere } from '../commercial/contract.service.js';
import { corporateDocumentListWhere } from '../commercial/corporate-document.service.js';
import { contractKey } from '../commercial/engine/contract-state.js';
import { tenderKey } from '../commercial/engine/tender-state.js';
import { tenderListWhere } from '../commercial/tender.service.js';
import { employeeScopeWhere, employeeTextMatch } from '../people/employee.service.js';
import { projectScopeWhere } from '../projects/project-access.js';
import { projectListWhere } from '../projects/project.service.js';
import { requestScopeWhere } from '../requests/request-access.js';
import { ticketKey } from '../support/ticket-access.js';
import { ticketListWhere } from '../support/ticket.service.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  normalizeSearchQuery,
  rankResults,
  requestNumberOf,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_OFFSET,
  ticketNumberOf,
} from './engine/search.js';
import type { Rankable } from './engine/search.js';
import { dashboardLink, projectLink } from './links.js';
import type { DashboardLink } from './links.js';

export const SEARCH_TYPES = [
  'projects',
  'employees',
  'tickets',
  'requests',
  'jira',
  'tenders',
  'contracts',
  'documents',
  'guarantees',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchResult {
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  readonly subtitle: string | null;
  readonly link: DashboardLink;
}

export interface SearchGroup {
  readonly type: SearchType;
  readonly items: readonly SearchResult[];
  readonly nextCursor: string | null;
}

export interface SearchResponse {
  readonly query: string;
  readonly groups: readonly SearchGroup[];
}

export interface SearchInput {
  readonly q: string;
  readonly types?: readonly SearchType[] | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly locale?: 'en' | 'ar' | undefined;
}

type Candidate = Rankable & { readonly subtitle: string | null; readonly link: DashboardLink };

/** Candidates read per type: everything "more" pagination can reach, plus one to know there is more. */
const CANDIDATES = SEARCH_MAX_OFFSET + 1;

const localized = (value: unknown, locale: 'en' | 'ar'): string => {
  if (typeof value !== 'object' || value === null) return '';
  const names = value as Record<string, unknown>;
  const preferred = names[locale];
  const fallback = names.en;
  return typeof preferred === 'string' && preferred !== '' ? preferred : typeof fallback === 'string' ? fallback : '';
};

/**
 * Global search (P8-6, ADR-0023). PostgreSQL only; every entity query carries the same scope `where` as
 * the entity's list, so a result is returned only when the caller could open it. Bounded: normalized
 * 2–100 character text, escaped `ILIKE` patterns, at most 51 candidates per type, deterministic ranking.
 */
export class SearchService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async search(action: ActionContext, input: SearchInput): Promise<SearchResponse> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const query = normalizeSearchQuery(input.q);
    const types = input.types === undefined || input.types.length === 0 ? SEARCH_TYPES : [...new Set(input.types)];
    const limit = Math.min(Math.max(input.limit ?? SEARCH_DEFAULT_LIMIT, 1), 10);
    const offset = input.cursor === undefined ? 0 : decodeSearchCursor(input.cursor, query);
    const locale = input.locale ?? 'en';
    const groups: SearchGroup[] = [];
    // Sequential: the tenant client is one transaction connection.
    for (const type of types) {
      const candidates = await this.candidates(type, action.principal, organizationId, query, locale);
      const ranked = rankResults(query, candidates);
      const page = ranked.slice(offset, offset + limit);
      const next = offset + limit;
      groups.push({
        type,
        items: page.map((item) => ({
          id: item.id,
          key: item.key,
          title: item.title,
          subtitle: item.subtitle,
          link: item.link,
        })),
        nextCursor: ranked.length > next && next < SEARCH_MAX_OFFSET ? encodeSearchCursor(next, query) : null,
      });
    }
    return { query, groups };
  }

  private candidates(
    type: SearchType,
    principal: Principal,
    organizationId: string,
    query: string,
    locale: 'en' | 'ar',
  ): Promise<Candidate[]> {
    switch (type) {
      case 'projects':
        return this.projects(principal, organizationId, query);
      case 'employees':
        return this.employees(principal, organizationId, query);
      case 'tickets':
        return this.tickets(principal, organizationId, query);
      case 'requests':
        return this.requests(principal, organizationId, query, locale);
      case 'jira':
        return this.jira(principal, organizationId, query);
      case 'tenders':
        return this.tenders(principal, organizationId, query);
      case 'contracts':
        return this.contracts(principal, organizationId, query);
      case 'documents':
        return this.documents(principal, organizationId, query);
      case 'guarantees':
        return this.guarantees(principal, organizationId, query);
    }
  }

  private async tenders(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const now = new Date();
    const { timeZone } = await organizationToday(this.db, organizationId, now);
    const and = tenderListWhere(this.db, principal, { q: query, includeArchived: true }, now, timeZone);
    if (and === null) return [];
    const rows = await this.db.tender.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATES,
      select: { id: true, year: true, number: true, title: true, status: true },
    });
    return rows.map((row) => ({
      id: row.id,
      key: tenderKey(row.year, row.number),
      title: row.title,
      texts: [],
      subtitle: row.status,
      link: dashboardLink(`/tenders/${row.id}`),
    }));
  }

  private async contracts(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const { today } = await organizationToday(this.db, organizationId, new Date());
    const and = contractListWhere(principal, { q: query }, today);
    if (and === null) return [];
    const rows = await this.db.contract.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATES,
      select: { id: true, year: true, number: true, title: true, status: true },
    });
    return rows.map((row) => ({
      id: row.id,
      key: contractKey(row.year, row.number),
      title: row.title,
      texts: [],
      subtitle: row.status,
      link: dashboardLink(`/contracts/${row.id}`),
    }));
  }

  private async documents(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const { today } = await organizationToday(this.db, organizationId, new Date());
    const and = corporateDocumentListWhere(principal, { q: query, status: ['ACTIVE', 'ARCHIVED'] }, today);
    if (and === null) return [];
    const rows = await this.db.corporateDocument.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: CANDIDATES,
      select: { id: true, title: true, documentNumber: true, documentType: true },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.documentNumber,
      title: row.title,
      texts: [],
      subtitle: row.documentType,
      link: dashboardLink('/documents', { open: row.id }),
    }));
  }

  /** Guarantees whose parent the caller fully sees, or that the caller owns; the link opens the parent's tab. */
  private async guarantees(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const tenderWhere = fullTenderWhere(principal);
    const contractWhere = fullContractWhere(principal);
    const parents: Prisma.GuaranteeWhereInput[] = [{ ownerMemberId: principal.memberId }];
    if (tenderWhere !== null) parents.push({ tender: { is: tenderWhere } });
    if (contractWhere !== null) parents.push({ contract: { is: contractWhere } });
    const pattern = escapeLike(query);
    const rows = await this.db.guarantee.findMany({
      where: {
        organizationId,
        AND: [
          { OR: parents },
          {
            OR: [
              { referenceNumber: { contains: pattern, mode: 'insensitive' } },
              { issuer: { contains: pattern, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
      take: CANDIDATES,
      select: {
        id: true,
        type: true,
        referenceNumber: true,
        issuer: true,
        status: true,
        tender: { select: { id: true, year: true, number: true } },
        contract: { select: { id: true, year: true, number: true } },
      },
    });
    return rows.flatMap((row) => {
      const parent =
        row.tender !== null
          ? {
              key: tenderKey(row.tender.year, row.tender.number),
              link: dashboardLink(`/tenders/${row.tender.id}`, {}, 'guarantees'),
            }
          : row.contract !== null
            ? {
                key: contractKey(row.contract.year, row.contract.number),
                link: dashboardLink(`/contracts/${row.contract.id}`, {}, 'guarantees'),
              }
            : null;
      if (parent === null) return [];
      return [
        {
          id: row.id,
          key: row.referenceNumber,
          title: `${row.issuer} · ${row.type}`,
          texts: [row.issuer],
          subtitle: `${parent.key} · ${row.status}`,
          link: parent.link,
        },
      ];
    });
  }

  private async projects(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const and = projectListWhere(principal, { q: query, includeArchived: true });
    if (and === 'none') return [];
    const rows = await this.db.project.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: CANDIDATES,
      select: { id: true, code: true, name: true, status: true },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.code,
      title: row.name,
      texts: [],
      subtitle: row.status,
      link: projectLink(row.id),
    }));
  }

  private async employees(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const scope = listScope(principal, 'employee.view');
    if (isEmptyListScope(scope)) return [];
    const scopeWhere = employeeScopeWhere(scope);
    const rows = await this.db.employeeProfile.findMany({
      where: {
        organizationId,
        AND: [...(scopeWhere === null ? [] : [scopeWhere]), { OR: employeeTextMatch(principal, query) }],
      },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: CANDIDATES,
      select: { id: true, fullName: true, employeeNumber: true, department: { select: { name: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.employeeNumber,
      title: row.fullName,
      texts: [],
      subtitle: row.department?.name ?? null,
      link: dashboardLink(`/people/${row.id}`),
    }));
  }

  private async tickets(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    const and = ticketListWhere(principal, organizationId, { q: query });
    if (and === 'none') return [];
    const select = { id: true, number: true, title: true, status: true } as const;
    const exactNumber = ticketNumberOf(query);
    const exact =
      exactNumber === null
        ? []
        : await this.db.supportTicket.findMany({
            where: { organizationId, AND: [...and, { number: exactNumber }] },
            take: 1,
            select,
          });
    const rows = await this.db.supportTicket.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATES,
      select,
    });
    const unique = new Map([...exact, ...rows].map((row) => [row.id, row]));
    return [...unique.values()].map((row) => ({
      id: row.id,
      key: ticketKey(row.number),
      title: row.title,
      texts: [],
      subtitle: row.status,
      link: dashboardLink(`/support/tickets/${row.id}`),
    }));
  }

  private async requests(
    principal: Principal,
    organizationId: string,
    query: string,
    locale: 'en' | 'ar',
  ): Promise<Candidate[]> {
    const number = requestNumberOf(query);
    const pattern = escapeLike(query);
    const match: Prisma.RequestInstanceWhereInput[] = [
      { requestType: { key: { contains: pattern, mode: 'insensitive' } } },
      ...(number === null ? [] : [{ number }]),
    ];
    const scope = hasPermission(principal.permissions, 'request.view')
      ? requestScopeWhere(listScope(principal, 'request.view'), principal.memberId)
      : { requesterMemberId: principal.memberId };
    const rows = await this.db.requestInstance.findMany({
      where: { organizationId, AND: [scope, { OR: match }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATES,
      select: { id: true, number: true, status: true, requestType: { select: { key: true, name: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      key: `REQ-${String(row.number)}`,
      title: localized(row.requestType.name, locale) || row.requestType.key,
      texts: [row.requestType.key],
      subtitle: row.status,
      link: dashboardLink(`/requests/${row.id}`),
    }));
  }

  private async jira(principal: Principal, organizationId: string, query: string): Promise<Candidate[]> {
    if (!hasPermission(principal.permissions, 'jira.view')) return [];
    const scope = listScope(principal, 'jira.view');
    const projectWhere = isEmptyListScope(scope) ? 'none' : projectScopeWhere(scope);
    if (projectWhere === 'none') return [];
    const pattern = escapeLike(query);
    const rows = await this.db.jiraIssue.findMany({
      where: {
        organizationId,
        deletedInJiraAt: null,
        mapping: {
          is: {
            removedAt: null,
            connection: { status: { not: 'DISCONNECTED' } },
            ...(projectWhere === null ? {} : { project: projectWhere }),
          },
        },
        OR: [
          { issueKey: { contains: pattern, mode: 'insensitive' } },
          { summary: { contains: pattern, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ jiraUpdatedAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATES,
      select: {
        id: true,
        issueKey: true,
        summary: true,
        statusName: true,
        mapping: { select: { project: { select: { id: true, code: true } } } },
      },
    });
    return rows.flatMap((row) =>
      row.mapping === null
        ? []
        : [
            {
              id: row.id,
              key: row.issueKey,
              title: row.summary,
              texts: [],
              subtitle: `${row.mapping.project.code} · ${row.statusName}`,
              link: projectLink(row.mapping.project.id, 'jira'),
            },
          ],
    );
  }
}
