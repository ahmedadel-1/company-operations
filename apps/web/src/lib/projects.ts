import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;

export type ProjectSummary = Item<'/api/v1/projects'>;
export type Project = Data<'/api/v1/projects/{id}'>;
export type ProjectMember = Item<'/api/v1/projects/{id}/members'>;
export type ProjectLocation = Item<'/api/v1/projects/{id}/locations'>;
export type ProjectActivity = Item<'/api/v1/projects/{id}/activity'>;
export type DailyReportSummary = Item<'/api/v1/projects/{id}/daily-reports'>;
export type DailyReport = Data<'/api/v1/daily-reports/{id}'>;
export type MissingReports = Data<'/api/v1/projects/{id}/daily-reports/missing'>;
export type Customer = Item<'/api/v1/customers'>;
export type WorkLocation = Item<'/api/v1/work-locations'>;
export type Attachment = Item<'/api/v1/attachments'>;

export type ProjectStatus = ProjectSummary['status'];
export type ProjectHealth = ProjectSummary['health'];
export type ProjectRole = ProjectMember['projectRole'];
export type DailyReportStatus = DailyReportSummary['systemStatus'];

export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED', 'ARCHIVED'] as const;
export const SETTABLE_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED'] as const;
export const PROJECT_HEALTHS = ['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL'] as const;
export const PROJECT_ROLES = [
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'DEVELOPER',
  'SUPPORT',
  'FIELD',
  'QA',
  'OBSERVER',
] as const satisfies readonly ProjectRole[];
export const REPORT_STATUSES = ['NORMAL', 'DEGRADED', 'ISSUE', 'CRITICAL'] as const;
export const PROJECT_SORTS = [
  'updatedAt:desc',
  'createdAt:desc',
  'name:asc',
  'name:desc',
  'code:asc',
  'code:desc',
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export interface ProjectFilters {
  readonly q?: string;
  readonly status?: readonly ProjectStatus[];
  readonly health?: readonly ProjectHealth[];
  readonly customerId?: string;
  readonly managerId?: string;
  readonly scope?: 'all' | 'mine';
  readonly includeArchived?: boolean;
  readonly sort?: ProjectSort;
}

const PAGE_SIZE = 25;

export const projectKeys = {
  all: ['projects'] as const,
  list: (filters: ProjectFilters) => ['projects', 'list', filters] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
  members: (id: string) => ['projects', 'members', id] as const,
  locations: (id: string) => ['projects', 'locations', id] as const,
  activity: (id: string) => ['projects', 'activity', id] as const,
  reports: (id: string, filters: object) => ['projects', 'reports', id, filters] as const,
  missing: (id: string) => ['projects', 'missing', id] as const,
  report: (id: string) => ['daily-reports', id] as const,
  customers: (includeArchived: boolean, q: string) => ['customers', includeArchived, q] as const,
  workLocations: (includeInactive: boolean) => ['work-locations', includeInactive] as const,
  attachments: (ownerId: string) => ['attachments', ownerId] as const,
  employeeProjects: (employeeId: string) => ['employee-projects', employeeId] as const,
};

function listQuery(filters: ProjectFilters) {
  return {
    ...(filters.q === undefined || filters.q === '' ? {} : { q: filters.q }),
    ...(filters.status === undefined || filters.status.length === 0 ? {} : { status: filters.status.join(',') }),
    ...(filters.health === undefined || filters.health.length === 0 ? {} : { health: filters.health.join(',') }),
    ...(filters.customerId === undefined ? {} : { customerId: filters.customerId }),
    ...(filters.managerId === undefined ? {} : { managerId: filters.managerId }),
    ...(filters.scope === undefined ? {} : { scope: filters.scope }),
    ...(filters.includeArchived === true ? { includeArchived: 'true' as const } : {}),
    ...(filters.sort === undefined ? {} : { sort: filters.sort }),
  };
}

export function useProjects(filters: ProjectFilters, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: projectKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/projects', {
          params: {
            query: {
              ...listQuery(filters),
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

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/projects/{id}', { params: { path: { id } } }))).data,
  });
}

export function useProjectMembers(id: string) {
  return useQuery({
    queryKey: projectKeys.members(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/members', { params: { path: { id } } }))).data,
  });
}

export function useProjectLocations(id: string) {
  return useQuery({
    queryKey: projectKeys.locations(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/locations', { params: { path: { id } } }))).data,
  });
}

export function useProjectActivity(id: string, limit = PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...projectKeys.activity(id), limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/projects/{id}/activity', {
          params: { path: { id }, query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export interface ReportFilters {
  readonly from?: string;
  readonly to?: string;
  readonly systemStatus?: readonly DailyReportStatus[];
}

export function useProjectReports(id: string, filters: ReportFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: projectKeys.reports(id, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/projects/{id}/daily-reports', {
          params: {
            path: { id },
            query: {
              ...(filters.from === undefined || filters.from === '' ? {} : { from: filters.from }),
              ...(filters.to === undefined || filters.to === '' ? {} : { to: filters.to }),
              ...(filters.systemStatus === undefined || filters.systemStatus.length === 0
                ? {}
                : { systemStatus: filters.systemStatus.join(',') }),
              limit: PAGE_SIZE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMissingReports(id: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.missing(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/daily-reports/missing', { params: { path: { id } } }))).data,
    enabled,
  });
}

export function useDailyReport(id: string) {
  return useQuery({
    queryKey: projectKeys.report(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/daily-reports/{id}', { params: { path: { id } } }))).data,
  });
}

export function useCustomers(options: { includeArchived?: boolean; q?: string; enabled?: boolean } = {}) {
  const includeArchived = options.includeArchived === true;
  const q = options.q?.trim() ?? '';
  return useInfiniteQuery({
    queryKey: projectKeys.customers(includeArchived, q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/customers', {
          params: {
            query: {
              ...(includeArchived ? { includeArchived: 'true' as const } : {}),
              ...(q === '' ? {} : { q }),
              limit: 100,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

export function useWorkLocations(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: projectKeys.workLocations(includeInactive),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/work-locations', {
            params: { query: includeInactive ? { includeInactive: 'true' } : {} },
          }),
        )
      ).data,
    enabled,
  });
}

export type AttachmentOwnerType =
  | 'DAILY_REPORT'
  | 'SUPPORT_TICKET'
  | 'REQUEST'
  | 'TENDER_REQUIREMENT'
  | 'OBLIGATION_OCCURRENCE'
  | 'CONTRACT_MILESTONE'
  | 'GUARANTEE';

export function useAttachments(ownerType: AttachmentOwnerType, ownerId: string) {
  return useQuery({
    queryKey: projectKeys.attachments(ownerId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/attachments', { params: { query: { ownerType, ownerId } } }))).data,
  });
}

export function useEmployeeProjects(employeeId: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.employeeProjects(employeeId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/employees/{id}/projects', { params: { path: { id: employeeId } } }))).data,
    enabled,
  });
}
