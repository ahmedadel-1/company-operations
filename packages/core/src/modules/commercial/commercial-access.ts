import type { CommercialDocumentCategory, DocumentClassification, Prisma } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

import { ForbiddenError, NotFoundError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource, listScope } from '../authorization/policy.js';
import type { ListScope, Principal, ResourceFacts } from '../authorization/policy.js';

/**
 * Contextual authorization of tenders and contracts (ADR-0026, spec §48).
 *
 * FULL: the record is inside the caller's `tender.view` / `contract.view` scope (owner and leads for
 * SELF/TEAM, the owner's department for DEPARTMENT, the linked project for PROJECT) or, for tenders,
 * the caller is an assigned reviewer (reviewers must see what they approve).
 * INVOLVED: the caller owns or reviews a requirement, owns an obligation/occurrence/milestone or a
 * guarantee of the record. INVOLVED callers see the header, GENERAL documents and their own items;
 * every mutation beyond their own items needs the specific permission in scope.
 * Anything else is 404. Financial values additionally need `tender.financial.view` /
 * `contract.financial.view` in scope; confidential documents need `commercial_document.view`.
 */
export type AccessLevel = 'FULL' | 'INVOLVED';

const ownerDepartment = {
  select: { profile: { select: { departmentId: true } } },
} satisfies Prisma.OrganizationMemberDefaultArgs;

export const tenderAccessSelect = {
  id: true,
  status: true,
  number: true,
  year: true,
  title: true,
  version: true,
  ownerMemberId: true,
  technicalLeadMemberId: true,
  commercialLeadMemberId: true,
  relatedProjectId: true,
  submissionDeadlineAt: true,
  owner: ownerDepartment,
} satisfies Prisma.TenderSelect;
export type TenderAccessRow = Prisma.TenderGetPayload<{ select: typeof tenderAccessSelect }>;

export const contractAccessSelect = {
  id: true,
  status: true,
  number: true,
  year: true,
  title: true,
  version: true,
  currency: true,
  ownerMemberId: true,
  projectId: true,
  owner: ownerDepartment,
} satisfies Prisma.ContractSelect;
export type ContractAccessRow = Prisma.ContractGetPayload<{ select: typeof contractAccessSelect }>;

interface OwnedRow {
  readonly owner: { readonly profile: { readonly departmentId: string | null } | null };
}

export function tenderFacts(
  organizationId: string,
  row: OwnedRow &
    Pick<TenderAccessRow, 'ownerMemberId' | 'technicalLeadMemberId' | 'commercialLeadMemberId' | 'relatedProjectId'>,
): ResourceFacts {
  const members = [row.ownerMemberId, row.technicalLeadMemberId, row.commercialLeadMemberId].filter(
    (id): id is string => id !== null,
  );
  const department = row.owner.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: members,
    subjectMemberIds: members,
    departmentIds: department === null ? [] : [department],
    projectIds: row.relatedProjectId === null ? [] : [row.relatedProjectId],
  };
}

export function contractFacts(
  organizationId: string,
  row: OwnedRow & Pick<ContractAccessRow, 'ownerMemberId' | 'projectId'>,
): ResourceFacts {
  const department = row.owner.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: [row.ownerMemberId],
    subjectMemberIds: [row.ownerMemberId],
    departmentIds: department === null ? [] : [department],
    projectIds: row.projectId === null ? [] : [row.projectId],
  };
}

export interface LoadedTender {
  readonly row: TenderAccessRow;
  readonly facts: ResourceFacts;
  readonly level: AccessLevel;
  readonly can: (permission: PermissionKey) => boolean;
}

export interface LoadedContract {
  readonly row: ContractAccessRow;
  readonly facts: ResourceFacts;
  readonly level: AccessLevel;
  readonly can: (permission: PermissionKey) => boolean;
}

/** Tender membership conditions that make a member INVOLVED (requirements, guarantees). */
function tenderInvolvement(memberId: string): Prisma.TenderWhereInput[] {
  return [
    { requirements: { some: { OR: [{ ownerMemberId: memberId }, { reviewerMemberId: memberId }] } } },
    { guarantees: { some: { ownerMemberId: memberId } } },
  ];
}

function contractInvolvement(memberId: string): Prisma.ContractWhereInput[] {
  return [
    { obligations: { some: { OR: [{ ownerMemberId: memberId }, { reviewerMemberId: memberId }] } } },
    { occurrences: { some: { ownerMemberId: memberId } } },
    { milestones: { some: { ownerMemberId: memberId } } },
    { guarantees: { some: { ownerMemberId: memberId } } },
  ];
}

export async function loadTenderForAccess(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  tenderId: string,
): Promise<LoadedTender | null> {
  const row = await db.tender.findFirst({ where: { organizationId, id: tenderId }, select: tenderAccessSelect });
  if (row === null) return null;
  const facts = tenderFacts(organizationId, row);
  const can = (permission: PermissionKey): boolean => canAccessResource(principal, permission, facts);
  if (can('tender.view')) return { row, facts, level: 'FULL', can };
  const memberId = principal.memberId;
  const reviewer = await db.tenderReview.findFirst({
    where: { organizationId, tenderId, reviewerMemberId: memberId },
    select: { id: true },
  });
  if (reviewer !== null) return { row, facts, level: 'FULL', can };
  const involved = await db.tender.findFirst({
    where: { organizationId, id: tenderId, OR: tenderInvolvement(memberId) },
    select: { id: true },
  });
  return involved === null ? null : { row, facts, level: 'INVOLVED', can };
}

export async function loadVisibleTender(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  tenderId: string,
): Promise<LoadedTender> {
  const tender = await loadTenderForAccess(db, action.principal, organizationId, tenderId);
  if (tender === null) throw new NotFoundError('Tender');
  return tender;
}

export async function loadContractForAccess(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  contractId: string,
): Promise<LoadedContract | null> {
  const row = await db.contract.findFirst({ where: { organizationId, id: contractId }, select: contractAccessSelect });
  if (row === null) return null;
  const facts = contractFacts(organizationId, row);
  const can = (permission: PermissionKey): boolean => canAccessResource(principal, permission, facts);
  if (can('contract.view')) return { row, facts, level: 'FULL', can };
  const involved = await db.contract.findFirst({
    where: { organizationId, id: contractId, OR: contractInvolvement(principal.memberId) },
    select: { id: true },
  });
  return involved === null ? null : { row, facts, level: 'INVOLVED', can };
}

export async function loadVisibleContract(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  contractId: string,
): Promise<LoadedContract> {
  const contract = await loadContractForAccess(db, action.principal, organizationId, contractId);
  if (contract === null) throw new NotFoundError('Contract');
  return contract;
}

/** Visible but not permitted is 403 (spec §48). */
export function assertCan(
  loaded: { readonly can: (permission: PermissionKey) => boolean },
  permission: PermissionKey,
): void {
  if (!loaded.can(permission)) throw new ForbiddenError();
}

export function canViewTenderFinancial(tender: LoadedTender): boolean {
  return tender.level === 'FULL' && tender.can('tender.financial.view');
}

export function canViewContractFinancial(contract: LoadedContract): boolean {
  return contract.level === 'FULL' && contract.can('contract.financial.view');
}

// ---- List scopes ----

/** `where` fragment of a tender permission's list scope (null = unrestricted, 'none' = nothing). */
export function tenderScopeWhere(scope: ListScope): Prisma.TenderWhereInput | null | 'none' {
  if (scope.all) return null;
  const or: Prisma.TenderWhereInput[] = [];
  if (scope.memberIds.length > 0) {
    const ids = [...scope.memberIds];
    or.push(
      { ownerMemberId: { in: ids } },
      { technicalLeadMemberId: { in: ids } },
      { commercialLeadMemberId: { in: ids } },
    );
  }
  if (scope.departmentIds.length > 0) {
    or.push({ owner: { profile: { departmentId: { in: [...scope.departmentIds] } } } });
  }
  if (scope.projectIds.length > 0) {
    or.push({ relatedProjectId: { in: [...scope.projectIds] } });
  }
  return or.length === 0 ? 'none' : { OR: or };
}

export function contractScopeWhere(scope: ListScope): Prisma.ContractWhereInput | null | 'none' {
  if (scope.all) return null;
  const or: Prisma.ContractWhereInput[] = [];
  if (scope.memberIds.length > 0) {
    or.push({ ownerMemberId: { in: [...scope.memberIds] } });
  }
  if (scope.departmentIds.length > 0) {
    or.push({ owner: { profile: { departmentId: { in: [...scope.departmentIds] } } } });
  }
  if (scope.projectIds.length > 0) {
    or.push({ projectId: { in: [...scope.projectIds] } });
  }
  return or.length === 0 ? 'none' : { OR: or };
}

/**
 * Tenders the caller may see at any level: `tender.view` scope, assigned reviews, involvement.
 * Returns null when no tender can match.
 */
export function visibleTenderWhere(principal: Principal): Prisma.TenderWhereInput | null {
  const scoped = tenderScopeWhere(listScope(principal, 'tender.view'));
  if (scoped === null) return {};
  const or: Prisma.TenderWhereInput[] = [
    { reviews: { some: { reviewerMemberId: principal.memberId } } },
    ...tenderInvolvement(principal.memberId),
  ];
  if (scoped !== 'none') or.push(scoped);
  return { OR: or };
}

/** Tenders visible at FULL level only (dashboards and reports count only these). */
export function fullTenderWhere(
  principal: Principal,
  permission: PermissionKey = 'tender.view',
): Prisma.TenderWhereInput | null {
  const scoped = tenderScopeWhere(listScope(principal, permission));
  if (scoped === 'none') return null;
  return scoped ?? {};
}

export function visibleContractWhere(principal: Principal): Prisma.ContractWhereInput | null {
  const scoped = contractScopeWhere(listScope(principal, 'contract.view'));
  if (scoped === null) return {};
  const or: Prisma.ContractWhereInput[] = [...contractInvolvement(principal.memberId)];
  if (scoped !== 'none') or.push(scoped);
  return { OR: or };
}

export function fullContractWhere(
  principal: Principal,
  permission: PermissionKey = 'contract.view',
): Prisma.ContractWhereInput | null {
  const scoped = contractScopeWhere(listScope(principal, permission));
  if (scoped === 'none') return null;
  return scoped ?? {};
}

// ---- Document classification ----

/** Minimum classification of a category: pricing is confidential, banking is restricted. */
export function minimumClassification(category: CommercialDocumentCategory): DocumentClassification {
  if (category === 'BANKING') return 'BANKING_RESTRICTED';
  if (category === 'COMMERCIAL_SUBMISSION' || category === 'COMMERCIAL_PROPOSAL') return 'COMMERCIAL_CONFIDENTIAL';
  return 'GENERAL';
}

const CLASSIFICATION_RANK: Readonly<Record<DocumentClassification, number>> = {
  GENERAL: 0,
  COMMERCIAL_CONFIDENTIAL: 1,
  LEGAL_RESTRICTED: 1,
  BANKING_RESTRICTED: 2,
};

export function satisfiesMinimum(
  classification: DocumentClassification,
  category: CommercialDocumentCategory,
): boolean {
  const minimum = minimumClassification(category);
  if (minimum === 'BANKING_RESTRICTED') return classification === 'BANKING_RESTRICTED';
  return CLASSIFICATION_RANK[classification] >= CLASSIFICATION_RANK[minimum];
}

/**
 * Whether the caller may see a tender/contract document of this classification. GENERAL follows the
 * parent (INVOLVED callers included); confidential and legal documents need
 * `commercial_document.view`; banking documents need the parent's financial permission as well.
 */
export function canViewCommercialDocument(
  parent: LoadedTender | LoadedContract,
  financialPermission: 'tender.financial.view' | 'contract.financial.view',
  classification: DocumentClassification,
): boolean {
  if (classification === 'GENERAL') return true;
  if (parent.level !== 'FULL' || !parent.can('commercial_document.view')) return false;
  return classification !== 'BANKING_RESTRICTED' || parent.can(financialPermission);
}

/** Classifications the caller may see, for list filters. */
export function visibleClassifications(
  parent: LoadedTender | LoadedContract,
  financialPermission: 'tender.financial.view' | 'contract.financial.view',
): DocumentClassification[] {
  return (['GENERAL', 'COMMERCIAL_CONFIDENTIAL', 'LEGAL_RESTRICTED', 'BANKING_RESTRICTED'] as const).filter((c) =>
    canViewCommercialDocument(parent, financialPermission, c),
  );
}

/** Document filter for version references: a version the caller may not see is "unknown", never "forbidden". */
export function visibleDocumentWhere(
  parent: LoadedTender | LoadedContract,
  financialPermission: 'tender.financial.view' | 'contract.financial.view',
): Prisma.CommercialDocumentWhereInput {
  return { classification: { in: visibleClassifications(parent, financialPermission) } };
}

/** A referenced document version id, or null when its document is hidden from the caller (existence included). */
export function visibleVersionId(
  parent: LoadedTender | LoadedContract,
  financialPermission: 'tender.financial.view' | 'contract.financial.view',
  version: { readonly id: string; readonly document: { readonly classification: DocumentClassification } } | null,
): string | null {
  if (version === null) return null;
  return canViewCommercialDocument(parent, financialPermission, version.document.classification) ? version.id : null;
}

/**
 * Timeline filter that drops the `document_added` / `document_version_added` events of documents hidden
 * from the caller. Scoped to those event types: a JSON path on events without `documentId` is SQL NULL,
 * and NOT (NULL) would drop them too.
 */
export async function hiddenDocumentEventsWhere(
  db: TenantDb,
  organizationId: string,
  parent:
    | { readonly type: 'TENDER'; readonly loaded: LoadedTender }
    | { readonly type: 'CONTRACT'; readonly loaded: LoadedContract },
): Promise<(Prisma.TenderEventWhereInput & Prisma.ContractEventWhereInput) | null> {
  const prefix = parent.type === 'TENDER' ? 'tender' : 'contract';
  const financial = parent.type === 'TENDER' ? 'tender.financial.view' : 'contract.financial.view';
  const hidden = await db.commercialDocument.findMany({
    where: {
      organizationId,
      ...(parent.type === 'TENDER' ? { tenderId: parent.loaded.row.id } : { contractId: parent.loaded.row.id }),
      classification: { notIn: visibleClassifications(parent.loaded, financial) },
    },
    select: { id: true },
  });
  if (hidden.length === 0) return null;
  return {
    NOT: {
      AND: [
        { type: { in: [`${prefix}.document_added`, `${prefix}.document_version_added`] } },
        { OR: hidden.map((row) => ({ metadata: { path: ['documentId'], equals: row.id } })) },
      ],
    },
  };
}

/** Select for `visibleVersionId`. */
export const versionClassificationSelect = {
  select: { id: true, document: { select: { classification: true } } },
} as const;

// ---- Corporate documents ----

export const corporateAccessSelect = {
  id: true,
  ownerMemberId: true,
  classification: true,
  status: true,
  owner: ownerDepartment,
} satisfies Prisma.CorporateDocumentSelect;
export type CorporateAccessRow = Prisma.CorporateDocumentGetPayload<{ select: typeof corporateAccessSelect }>;

export function corporateFacts(organizationId: string, row: CorporateAccessRow): ResourceFacts {
  const department = row.owner?.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: row.ownerMemberId === null ? [] : [row.ownerMemberId],
    subjectMemberIds: row.ownerMemberId === null ? [] : [row.ownerMemberId],
    departmentIds: department === null ? [] : [department],
  };
}

/** Corporate documents: `corporate_document.view`; anything but GENERAL also `restricted.view`. */
export function canViewCorporate(
  principal: Principal,
  facts: ResourceFacts,
  classification: DocumentClassification,
): boolean {
  if (!canAccessResource(principal, 'corporate_document.view', facts)) return false;
  return classification === 'GENERAL' || canAccessResource(principal, 'corporate_document.restricted.view', facts);
}

export function canManageCorporate(
  principal: Principal,
  facts: ResourceFacts,
  classification: DocumentClassification,
): boolean {
  return (
    canViewCorporate(principal, facts, classification) &&
    canAccessResource(principal, 'corporate_document.manage', facts)
  );
}

export function corporateScopeWhere(principal: Principal): Prisma.CorporateDocumentWhereInput | null {
  const view = listScope(principal, 'corporate_document.view');
  const restricted = listScope(principal, 'corporate_document.restricted.view');
  const scoped = (scope: ListScope): Prisma.CorporateDocumentWhereInput | null | 'none' => {
    if (scope.all) return null;
    const or: Prisma.CorporateDocumentWhereInput[] = [];
    if (scope.memberIds.length > 0) or.push({ ownerMemberId: { in: [...scope.memberIds] } });
    if (scope.departmentIds.length > 0)
      or.push({ owner: { profile: { departmentId: { in: [...scope.departmentIds] } } } });
    return or.length === 0 ? 'none' : { OR: or };
  };
  const viewWhere = scoped(view);
  if (viewWhere === 'none') return null;
  const restrictedWhere = scoped(restricted);
  const classificationWhere: Prisma.CorporateDocumentWhereInput =
    restrictedWhere === null
      ? {}
      : restrictedWhere === 'none'
        ? { classification: 'GENERAL' }
        : { OR: [{ classification: 'GENERAL' }, restrictedWhere] };
  return { AND: [viewWhere ?? {}, classificationWhere] };
}
