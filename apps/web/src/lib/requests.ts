import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;
type Query<P extends keyof paths> = paths[P]['get'] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

export type RequestTypeCatalogItem = Item<'/api/v1/request-types'>;
export type RequestForm = Data<'/api/v1/request-types/{id}/form'>;
export type RequestSummary = Item<'/api/v1/requests'>;
export type RequestDetail = Data<'/api/v1/requests/{id}'>;
export type RequestEvent = Item<'/api/v1/requests/{id}/history'>;
export type ApprovalItem = Item<'/api/v1/approvals'>;
export type Delegation = Item<'/api/v1/approval-delegations'>;
export type AdminRequestType = Item<'/api/v1/request-admin/types'>;
export type WorkflowVersionSummary = Item<'/api/v1/request-admin/types/{id}/versions'>;
export type WorkflowVersion = Data<'/api/v1/request-admin/types/{id}/versions/{versionId}'>;

export type FormSchema = RequestForm['form'];
export type FormField = FormSchema['fields'][number];
export type FormFieldType = FormField['type'];
export type RequestFormData = RequestDetail['formData'];
export type FormValue = NonNullable<RequestFormData[string]>;
export type Condition = NonNullable<FormField['visibleWhen']>;
export type ConditionRule = Condition['rules'][number];
export type ConditionOperator = ConditionRule['op'];
export type LocalizedText = RequestTypeCatalogItem['name'];
export type RequestStatus = RequestSummary['status'];
export type RequestCategory = RequestTypeCatalogItem['category'];
export type RequestTypeIcon = RequestTypeCatalogItem['icon'];
export type ApproverType = NonNullable<WorkflowVersion['steps'][number]['approver']>['type'];
export type StepState = RequestDetail['steps'][number]['state'];
export type RequestListQuery = Omit<Query<'/api/v1/requests'>, 'cursor' | 'limit'>;
export type DelegationStatus = Delegation['status'];

export const REQUEST_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'IN_FULFILLMENT',
  'COMPLETED',
] as const satisfies readonly RequestStatus[];
export const REQUEST_CATEGORIES = [
  'HR',
  'IT',
  'FINANCE',
  'ACCESS',
  'OPERATIONS',
  'OTHER',
] as const satisfies readonly RequestCategory[];
export const REQUEST_TYPE_ICONS = [
  'calendar',
  'home',
  'laptop',
  'key',
  'shopping-cart',
  'plane',
  'file-text',
  'clock',
  'wrench',
  'users',
] as const satisfies readonly RequestTypeIcon[];
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'money',
  'date',
  'date_range',
  'time',
  'boolean',
  'select',
  'multiselect',
  'member',
  'project',
  'info',
] as const satisfies readonly FormFieldType[];
export const APPROVER_TYPES = [
  'DIRECT_MANAGER',
  'DEPARTMENT_MANAGER',
  'TEAM_LEAD',
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'ROLE',
  'MEMBER',
] as const satisfies readonly ApproverType[];
export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isSet',
  'isNotSet',
] as const satisfies readonly ConditionOperator[];

/** Mirrors the server limits (ADR-0021); the server re-checks every value. */
export const REQUEST_LIMITS = {
  maxFields: 40,
  maxOptions: 50,
  maxConditionRules: 10,
  maxSteps: 20,
  maxTextLength: 500,
  maxTextareaLength: 5000,
  maxDelegationDays: 90,
} as const;

export const REQUEST_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
] as const;

const PAGE_SIZE = 25;

export const requestKeys = {
  all: ['requests'] as const,
  catalog: ['requests', 'catalog'] as const,
  form: (typeId: string) => ['requests', 'form', typeId] as const,
  lists: ['requests', 'list'] as const,
  list: (filters: RequestListQuery) => ['requests', 'list', filters] as const,
  detail: (id: string) => ['requests', 'detail', id] as const,
  history: (id: string) => ['requests', 'detail', id, 'history'] as const,
  approvals: ['requests', 'approvals'] as const,
  approvalSummary: ['requests', 'approvals', 'summary'] as const,
  delegations: (view: 'mine' | 'all') => ['requests', 'delegations', view] as const,
  adminTypes: ['requests', 'admin', 'types'] as const,
  adminType: (id: string) => ['requests', 'admin', 'types', id] as const,
  versions: (typeId: string) => ['requests', 'admin', 'types', typeId, 'versions'] as const,
  version: (typeId: string, versionId: string) =>
    ['requests', 'admin', 'types', typeId, 'versions', versionId] as const,
};

/** The label in the UI language, falling back to English when no Arabic text was configured. */
export function useLocalized(): (text: LocalizedText | null | undefined) => string {
  const locale = useLocale();
  return (text) => {
    if (text === null || text === undefined) {
      return '';
    }
    return locale === 'ar' && text.ar !== undefined ? text.ar : text.en;
  };
}

export function useRequestCatalog(enabled = true) {
  return useQuery({
    queryKey: requestKeys.catalog,
    queryFn: async () => (await request(() => api.GET('/api/v1/request-types'))).data,
    enabled,
  });
}

export function useRequestForm(typeId: string | null) {
  return useQuery({
    queryKey: requestKeys.form(typeId ?? ''),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/request-types/{id}/form', { params: { path: { id: typeId ?? '' } } })))
        .data,
    enabled: typeId !== null,
  });
}

export function useRequests(filters: RequestListQuery) {
  return useInfiniteQuery({
    queryKey: requestKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/requests', {
          params: {
            query: { ...filters, limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useRequest(id: string) {
  return useQuery({
    queryKey: requestKeys.detail(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/requests/{id}', { params: { path: { id } } }))).data,
  });
}

export function useRequestHistory(id: string) {
  return useInfiniteQuery({
    queryKey: requestKeys.history(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/requests/{id}/history', {
          params: { path: { id }, query: { limit: 50, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useApprovals(requestTypeId: string | null, overdue = false) {
  return useInfiniteQuery({
    queryKey: [...requestKeys.approvals, requestTypeId, overdue],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/approvals', {
          params: {
            query: {
              ...(requestTypeId === null ? {} : { requestTypeId }),
              ...(overdue ? { overdue: 'true' as const } : {}),
              limit: PAGE_SIZE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useApprovalSummary(enabled = true) {
  return useQuery({
    queryKey: requestKeys.approvalSummary,
    queryFn: async () => (await request(() => api.GET('/api/v1/approvals/summary'))).data.pending,
    refetchInterval: 120_000,
    enabled,
  });
}

export function useDelegations(view: 'mine' | 'all') {
  return useInfiniteQuery({
    queryKey: requestKeys.delegations(view),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/approval-delegations', {
          params: { query: { view, limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useAdminRequestTypes(enabled = true) {
  return useQuery({
    queryKey: requestKeys.adminTypes,
    queryFn: async () => (await request(() => api.GET('/api/v1/request-admin/types'))).data,
    enabled,
  });
}

export function useAdminRequestType(id: string) {
  return useQuery({
    queryKey: requestKeys.adminType(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/request-admin/types/{id}', { params: { path: { id } } }))).data,
  });
}

export function useWorkflowVersions(typeId: string) {
  return useInfiniteQuery({
    queryKey: requestKeys.versions(typeId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/request-admin/types/{id}/versions', {
          params: {
            path: { id: typeId },
            query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useWorkflowVersion(typeId: string, versionId: string | null) {
  return useQuery({
    queryKey: requestKeys.version(typeId, versionId ?? ''),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/request-admin/types/{id}/versions/{versionId}', {
            params: { path: { id: typeId, versionId: versionId ?? '' } },
          }),
        )
      ).data,
    enabled: versionId !== null,
  });
}

/** Field errors of a request form (`formData.<key>`) keyed by field key; other paths keyed as sent. */
export function formFieldErrors(fieldErrors: readonly { readonly path: string; readonly code: string }[]) {
  const map = new Map<string, string>();
  for (const item of fieldErrors) {
    const key = item.path.startsWith('formData.') ? (item.path.split('.')[1] ?? item.path) : item.path;
    if (!map.has(key)) {
      map.set(key, item.code);
    }
  }
  return map;
}
