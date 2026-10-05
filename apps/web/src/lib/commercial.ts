import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';
import { dashboardKeys } from './dashboard';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;
type Query<P extends keyof paths> = paths[P]['get'] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

export type TenderSummary = Item<'/api/v1/tenders'>;
export type Tender = Data<'/api/v1/tenders/{id}'>;
export type TenderRequirement = Item<'/api/v1/tenders/{id}/requirements'>;
export type TenderReviewGate = Item<'/api/v1/tenders/{id}/reviews'>;
export type BidDecisionRecord = Item<'/api/v1/tenders/{id}/bid-decisions'>;
export type TenderSubmission = Item<'/api/v1/tenders/{id}/submissions'>;
export type TenderAddendum = Item<'/api/v1/tenders/{id}/addenda'>;
export type TenderClarification = Item<'/api/v1/tenders/{id}/clarifications'>;
export type TenderWork = Data<'/api/v1/tenders/my-work'>;
export type CommercialDocumentList = Data<'/api/v1/tenders/{id}/documents'>;
export type CommercialDocument = CommercialDocumentList['items'][number];
export type Guarantee = Item<'/api/v1/tenders/{id}/guarantees'>;
export type CommercialEvent = Item<'/api/v1/tenders/{id}/timeline'>;
export type ContractSummary = Item<'/api/v1/contracts'>;
export type Contract = Data<'/api/v1/contracts/{id}'>;
export type Obligation = Item<'/api/v1/contracts/{id}/obligations'>;
export type Occurrence = Item<'/api/v1/contracts/{id}/occurrences'>;
export type Milestone = Item<'/api/v1/contracts/{id}/milestones'>;
export type Amendment = Item<'/api/v1/contracts/{id}/amendments'>;
export type RenewalAction = Item<'/api/v1/contracts/{id}/renewal-actions'>;
export type CorporateDocumentSummary = Item<'/api/v1/corporate-documents'>;
export type CorporateDocument = Data<'/api/v1/corporate-documents/{id}'>;
export type CommercialSettings = Data<'/api/v1/commercial/settings'>;
export type ProjectCommercial = Data<'/api/v1/projects/{id}/commercial'>;
export type CommercialDashboard = Data<'/api/v1/dashboard/commercial'>;
export type CommercialSection = CommercialDashboard['commercial'];
export type Money = NonNullable<TenderSummary['estimatedValue']>;

export type TenderQuery = Omit<Query<'/api/v1/tenders'>, 'cursor' | 'limit'>;
export type ContractQuery = Omit<Query<'/api/v1/contracts'>, 'cursor' | 'limit'>;
export type CorporateDocumentQuery = Omit<Query<'/api/v1/corporate-documents'>, 'cursor' | 'limit'>;
export type TenderWorkView = NonNullable<Query<'/api/v1/tenders/my-work'>['view']>;

export type TenderStatus = TenderSummary['status'];
export type TenderType = Tender['tenderType'];
export type CommercialPriority = TenderSummary['priority'];
export type RequirementStatus = TenderRequirement['status'];
export type RequirementCategory = TenderRequirement['category'];
export type ContractStatus = ContractSummary['status'];
export type ContractType = Contract['contractType'];
export type RenewalType = Contract['renewalType'];
export type CommercialHealth = ContractSummary['health'];
export type HealthReason = ContractSummary['healthReasons'][number];
export type DocumentValidity = CorporateDocumentSummary['validity'];
export type CorporateDocumentType = CorporateDocumentSummary['documentType'];
export type DocumentClassification = CorporateDocumentSummary['classification'];
export type DocumentCategory = CommercialDocument['category'];
export type GuaranteeType = Guarantee['type'];
export type GuaranteeStatus = Guarantee['status'];
export type ObligationStatus = Occurrence['status'];
export type ObligationCategory = Obligation['category'];
export type Recurrence = Obligation['recurrence'];
export type MilestoneStatus = Milestone['status'];
export type AmendmentType = Amendment['type'];
export type AmendmentStatus = Amendment['status'];
export type RenewalActionType = RenewalAction['action'];
export type ReviewGateType = TenderReviewGate['gate'];
export type SubmissionMethod = TenderSubmission['method'];
export type LossReason = NonNullable<Tender['loss']>['reason'];
export type NoBidReason = NonNullable<BidDecisionRecord['noBidReason']>;
export type TenderAlert = TenderSummary['alerts'][number];
export type CommercialReport = paths['/api/v1/commercial/reports/{report}']['get']['parameters']['path']['report'];

export const TENDER_STATUSES = [
  'DRAFT',
  'NEW',
  'UNDER_REVIEW',
  'BID_DECISION_PENDING',
  'NO_BID',
  'PREPARING',
  'INTERNAL_REVIEW',
  'READY_FOR_SUBMISSION',
  'SUBMITTED',
  'CLARIFICATION',
  'AWARDED',
  'LOST',
  'CANCELLED',
  'ARCHIVED',
] as const satisfies readonly TenderStatus[];
export const TENDER_TYPES = [
  'OPEN_TENDER',
  'LIMITED_TENDER',
  'DIRECT_INVITATION',
  'RFQ',
  'RFP',
  'FRAMEWORK_AGREEMENT',
  'OTHER',
] as const satisfies readonly TenderType[];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const satisfies readonly CommercialPriority[];
export const REQUIREMENT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED',
  'NOT_APPLICABLE',
  'BLOCKED',
] as const satisfies readonly RequirementStatus[];
export const REQUIREMENT_CATEGORIES = [
  'TECHNICAL',
  'COMMERCIAL',
  'LEGAL',
  'ADMINISTRATIVE',
  'FINANCIAL',
  'CERTIFICATE',
  'FORM',
  'EXPERIENCE',
  'BANK',
  'SECURITY',
  'OTHER',
] as const satisfies readonly RequirementCategory[];
export const CONTRACT_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'AWAITING_SIGNATURE',
  'ACTIVE',
  'RENEWAL_REVIEW',
  'SUSPENDED',
  'EXPIRED',
  'TERMINATED',
  'CLOSED',
] as const satisfies readonly ContractStatus[];
export const CONTRACT_TYPES = [
  'SUPPLY',
  'SERVICES',
  'MAINTENANCE',
  'SUPPORT',
  'IMPLEMENTATION',
  'FRAMEWORK',
  'LICENSE',
  'OTHER',
] as const satisfies readonly ContractType[];
export const RENEWAL_TYPES = [
  'NONE',
  'FIXED_TERM',
  'MANUAL_RENEWAL',
  'AUTO_RENEWAL',
  'EVERGREEN',
] as const satisfies readonly RenewalType[];
export const HEALTHS = [
  'HEALTHY',
  'NEEDS_ATTENTION',
  'AT_RISK',
  'CRITICAL',
] as const satisfies readonly CommercialHealth[];
export const VALIDITIES = [
  'VALID',
  'EXPIRING',
  'EXPIRED',
  'NO_EXPIRY',
  'NO_VERSION',
] as const satisfies readonly DocumentValidity[];
export const CORPORATE_DOCUMENT_TYPES = [
  'COMMERCIAL_REGISTRATION',
  'TAX_REGISTRATION',
  'VAT_CERTIFICATE',
  'ISO_CERTIFICATE',
  'BANK_LETTER',
  'COMPANY_PROFILE',
  'PREVIOUS_EXPERIENCE',
  'MANUFACTURER_AUTHORIZATION',
  'LICENSE',
  'INSURANCE_CERTIFICATE',
  'OTHER',
] as const satisfies readonly CorporateDocumentType[];
export const CLASSIFICATIONS = [
  'GENERAL',
  'COMMERCIAL_CONFIDENTIAL',
  'LEGAL_RESTRICTED',
  'BANKING_RESTRICTED',
] as const satisfies readonly DocumentClassification[];
export const DOCUMENT_CATEGORIES = [
  'SOURCE_DOCUMENTS',
  'ADDENDA',
  'CLARIFICATIONS',
  'TECHNICAL_SUBMISSION',
  'COMMERCIAL_SUBMISSION',
  'ADMINISTRATIVE',
  'CERTIFICATES',
  'BANKING',
  'FINAL_SUBMISSION',
  'PROOF_OF_SUBMISSION',
  'SIGNED_CONTRACT',
  'STATEMENT_OF_WORK',
  'TECHNICAL_PROPOSAL',
  'COMMERCIAL_PROPOSAL',
  'ANNEX',
  'AMENDMENT',
  'EXTENSION',
  'RENEWAL',
  'ACCEPTANCE_CERTIFICATE',
  'CORRESPONDENCE',
  'OTHER',
] as const satisfies readonly DocumentCategory[];
export const GUARANTEE_TYPES = [
  'BID_SECURITY',
  'PERFORMANCE_GUARANTEE',
  'ADVANCE_PAYMENT_GUARANTEE',
  'WARRANTY_GUARANTEE',
  'INSURANCE_CERTIFICATE',
  'OTHER',
] as const satisfies readonly GuaranteeType[];
export const OBLIGATION_CATEGORIES = [
  'REPORTING',
  'MAINTENANCE',
  'SUPPORT',
  'SLA',
  'TRAINING',
  'DELIVERY',
  'PAYMENT_RELATED',
  'CERTIFICATION',
  'SECURITY',
  'WARRANTY',
  'OTHER',
] as const satisfies readonly ObligationCategory[];
export const RECURRENCES = ['NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const satisfies readonly Recurrence[];
export const AMENDMENT_TYPES = [
  'VALUE_CHANGE',
  'TIME_EXTENSION',
  'SCOPE_CHANGE',
  'COMMERCIAL_CHANGE',
  'TECHNICAL_CHANGE',
  'GENERAL',
] as const satisfies readonly AmendmentType[];
export const RENEWAL_ACTIONS = [
  'REVIEW_STARTED',
  'RENEW',
  'DO_NOT_RENEW',
  'NOTICE_SENT',
  'RENEWED',
  'EXTENDED',
] as const satisfies readonly RenewalActionType[];
export const REVIEW_GATES = ['TECHNICAL', 'COMMERCIAL', 'LEGAL', 'FINAL'] as const satisfies readonly ReviewGateType[];
export const SUBMISSION_METHODS = [
  'GOVERNMENT_PORTAL',
  'EMAIL',
  'PHYSICAL',
  'COURIER',
  'OTHER',
] as const satisfies readonly SubmissionMethod[];
export const LOSS_REASONS = [
  'PRICE',
  'TECHNICAL_SCORE',
  'COMMERCIAL_TERMS',
  'QUALIFICATION',
  'DELIVERY_TIMELINE',
  'CUSTOMER_DECISION',
  'CANCELLED',
  'UNKNOWN',
  'OTHER',
] as const satisfies readonly LossReason[];
export const NO_BID_REASONS = [
  'INSUFFICIENT_TIME',
  'TECHNICAL_MISMATCH',
  'RESOURCE_CONSTRAINT',
  'COMMERCIAL_RISK',
  'MISSING_QUALIFICATION',
  'LOW_STRATEGIC_VALUE',
  'LOW_MARGIN_EXPECTATION',
  'OTHER',
] as const satisfies readonly NoBidReason[];
export const BID_CRITERIA = [
  'technicalFit',
  'commercialAttractiveness',
  'resourcesAvailable',
  'requiredQualificationsAvailable',
  'deadlineFeasible',
  'strategicCustomer',
  'previousExperienceAvailable',
  'commercialRisk',
  'technicalRisk',
] as const satisfies readonly (keyof BidDecisionRecord['criteria'])[];
export const TENDER_WORK_VIEWS = [
  'mine',
  'unassigned',
  'overdue',
  'blocked',
  'critical',
] as const satisfies readonly TenderWorkView[];
export const TENDER_REPORTS = [
  'tender-pipeline',
  'tender-win-loss',
  'tender-bid-decisions',
  'tender-deadlines',
  'tender-readiness',
  'tender-loss-reasons',
  'tender-workload',
] as const satisfies readonly CommercialReport[];
export const CONTRACT_REPORTS = [
  'contracts-active',
  'contracts-by-customer',
  'contracts-by-value',
  'contracts-expiring',
  'contracts-renewal',
  'obligations-overdue',
  'milestones-upcoming',
  'guarantees-expiring',
  'amendment-history',
] as const satisfies readonly CommercialReport[];
/** Reports the API refuses without the contract financial permission (others omit money columns instead). */
export const FINANCIAL_REPORTS: readonly CommercialReport[] = ['contracts-by-value'];

const PAGE_SIZE = 25;

export const commercialKeys = {
  all: ['commercial'] as const,
  tenders: (filters: TenderQuery) => ['commercial', 'tenders', filters] as const,
  tender: (id: string) => ['commercial', 'tender', id] as const,
  tenderPart: (id: string, part: string) => ['commercial', 'tender', id, part] as const,
  work: (view: TenderWorkView) => ['commercial', 'tender-work', view] as const,
  contracts: (filters: ContractQuery) => ['commercial', 'contracts', filters] as const,
  contract: (id: string) => ['commercial', 'contract', id] as const,
  contractPart: (id: string, part: string) => ['commercial', 'contract', id, part] as const,
  corporate: (filters: CorporateDocumentQuery) => ['commercial', 'corporate', filters] as const,
  corporateDocument: (id: string) => ['commercial', 'corporate', 'detail', id] as const,
  settings: ['commercial', 'settings'] as const,
  project: (id: string) => ['commercial', 'project', id] as const,
  dashboard: ['dashboard', 'commercial'] as const,
};

function compact<T extends object>(filters: T): T {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as T;
}

const cursor = (pageParam: string | undefined) => (pageParam === undefined ? {} : { cursor: pageParam });

export function useTenders(filters: TenderQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: commercialKeys.tenders(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/tenders', {
          params: { query: { ...compact(filters), limit: PAGE_SIZE, ...cursor(pageParam) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTender(id: string) {
  return useQuery({
    queryKey: commercialKeys.tender(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/tenders/{id}', { params: { path: { id } } }))).data,
  });
}

export function useTenderRequirements(id: string) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'requirements'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/requirements', { params: { path: { id } } }))).data,
  });
}

export function useTenderReviews(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'reviews'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/reviews', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useBidDecisions(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'bid-decisions'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/bid-decisions', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useTenderSubmissions(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'submissions'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/submissions', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useTenderAddenda(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'addenda'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/addenda', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useTenderClarifications(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.tenderPart(id, 'clarifications'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/{id}/clarifications', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useParentDocuments(parent: 'tenders' | 'contracts', id: string, enabled = true) {
  return useQuery({
    queryKey:
      parent === 'tenders' ? commercialKeys.tenderPart(id, 'documents') : commercialKeys.contractPart(id, 'documents'),
    queryFn: async () =>
      parent === 'tenders'
        ? (await request(() => api.GET('/api/v1/tenders/{id}/documents', { params: { path: { id } } }))).data
        : (await request(() => api.GET('/api/v1/contracts/{id}/documents', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useParentGuarantees(parent: 'tenders' | 'contracts', id: string, enabled = true) {
  return useQuery({
    queryKey:
      parent === 'tenders'
        ? commercialKeys.tenderPart(id, 'guarantees')
        : commercialKeys.contractPart(id, 'guarantees'),
    queryFn: async () =>
      parent === 'tenders'
        ? (await request(() => api.GET('/api/v1/tenders/{id}/guarantees', { params: { path: { id } } }))).data
        : (await request(() => api.GET('/api/v1/contracts/{id}/guarantees', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useTimeline(parent: 'tenders' | 'contracts', id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey:
      parent === 'tenders' ? commercialKeys.tenderPart(id, 'timeline') : commercialKeys.contractPart(id, 'timeline'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      parent === 'tenders'
        ? request(() =>
            api.GET('/api/v1/tenders/{id}/timeline', {
              params: { path: { id }, query: { limit: 50, ...cursor(pageParam) } },
            }),
          )
        : request(() =>
            api.GET('/api/v1/contracts/{id}/timeline', {
              params: { path: { id }, query: { limit: 50, ...cursor(pageParam) } },
            }),
          ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useTenderWork(view: TenderWorkView) {
  return useQuery({
    queryKey: commercialKeys.work(view),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/tenders/my-work', { params: { query: { view } } }))).data,
  });
}

export function useContracts(filters: ContractQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: commercialKeys.contracts(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/contracts', {
          params: { query: { ...compact(filters), limit: PAGE_SIZE, ...cursor(pageParam) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: commercialKeys.contract(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/contracts/{id}', { params: { path: { id } } }))).data,
  });
}

export function useObligations(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.contractPart(id, 'obligations'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/contracts/{id}/obligations', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useOccurrences(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.contractPart(id, 'occurrences'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/contracts/{id}/occurrences', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useMilestones(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.contractPart(id, 'milestones'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/contracts/{id}/milestones', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useAmendments(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.contractPart(id, 'amendments'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/contracts/{id}/amendments', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useRenewalActions(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.contractPart(id, 'renewal-actions'),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/contracts/{id}/renewal-actions', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useCorporateDocuments(filters: CorporateDocumentQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: commercialKeys.corporate(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/corporate-documents', {
          params: { query: { ...compact(filters), limit: PAGE_SIZE, ...cursor(pageParam) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCorporateDocument(id: string | null) {
  return useQuery({
    queryKey: commercialKeys.corporateDocument(id ?? ''),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/corporate-documents/{id}', { params: { path: { id: id ?? '' } } }))).data,
    enabled: id !== null,
  });
}

export function useCommercialSettings(enabled = true) {
  return useQuery({
    queryKey: commercialKeys.settings,
    queryFn: async () => (await request(() => api.GET('/api/v1/commercial/settings'))).data,
    enabled,
  });
}

export function useProjectCommercial(id: string, enabled = true) {
  return useQuery({
    queryKey: commercialKeys.project(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/commercial', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useCommercialDashboard(enabled = true) {
  return useQuery({
    queryKey: commercialKeys.dashboard,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/commercial'))).data,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * Runs one commercial write and refreshes every commercial and dashboard query afterwards (a change to
 * a requirement moves readiness, lists, the dashboard and Needs Attention at once).
 */
export function useCommercialAction<T = unknown>() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<T>) => run(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: commercialKeys.all }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
      ]);
    },
  });
}

/** Same-origin CSV download URL (the browser sends the session cookie; the API checks every permission). */
export function reportUrl(report: CommercialReport, options: { readonly withinDays?: number } = {}): string {
  const query = new URLSearchParams();
  if (options.withinDays !== undefined) query.set('withinDays', String(options.withinDays));
  const search = query.toString();
  return `/api/v1/commercial/reports/${report}${search === '' ? '' : `?${search}`}`;
}

/** A fresh Idempotency-Key per user action; a retried request reuses the key it was created with. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** `datetime-local` value (local wall time) to an ISO instant, or undefined when empty. */
export function localInputToIso(value: string): string | undefined {
  if (value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * `datetime-local` value read as wall time in `timeZone` (the organization's zone for tender deadlines,
 * whatever the browser's zone is) to an ISO instant, or undefined when empty.
 */
export function zonedInputToIso(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/** Money amount as typed by the user, accepted only in the canonical decimal form the API validates. */
export function amountOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\d{1,15}(\.\d{1,4})?$/.test(trimmed) ? trimmed : undefined;
}
