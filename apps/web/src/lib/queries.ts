import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Query<P extends keyof paths> = paths[P]['get'] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

export type EmployeeFilters = Omit<Query<'/api/v1/employees'>, 'cursor' | 'limit'>;
export type AuditFilters = Omit<Query<'/api/v1/audit/events'>, 'cursor' | 'limit'>;

const PAGE_SIZE = 25;

/** Removes empty filter values so they are not sent as `?q=`. */
function compact<T extends object>(filters: T): T {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as T;
}

export const queryKeys = {
  me: ['me'] as const,
  organization: ['organization'] as const,
  ownProfile: ['me', 'profile'] as const,
  employees: (filters: EmployeeFilters) => ['employees', 'list', filters] as const,
  employee: (id: string) => ['employees', 'detail', id] as const,
  departments: (includeArchived: boolean) => ['departments', includeArchived] as const,
  teams: (includeArchived: boolean) => ['teams', 'list', includeArchived] as const,
  team: (id: string) => ['teams', 'detail', id] as const,
  teamMembers: (id: string) => ['teams', 'members', id] as const,
  jobTitles: (includeArchived: boolean) => ['job-titles', includeArchived] as const,
  roles: ['roles'] as const,
  memberRoles: (memberId: string) => ['member-roles', memberId] as const,
  audit: (filters: AuditFilters) => ['audit', filters] as const,
  notifications: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  failedJobs: ['failed-jobs'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => (await request(() => api.GET('/api/v1/me'))).data,
    staleTime: 60_000,
  });
}

export function useOrganization() {
  return useQuery({
    queryKey: queryKeys.organization,
    queryFn: async () => (await request(() => api.GET('/api/v1/organization'))).data,
    staleTime: 5 * 60_000,
  });
}

export function useOwnProfile() {
  return useQuery({
    queryKey: queryKeys.ownProfile,
    queryFn: async () => (await request(() => api.GET('/api/v1/me/profile'))).data,
  });
}

export function useEmployees(filters: EmployeeFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.employees(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/employees', {
          params: {
            query: { ...compact(filters), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useEmployee(id: string) {
  return useQuery({
    queryKey: queryKeys.employee(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/employees/{id}', { params: { path: { id } } }))).data,
  });
}

export function useDepartments(includeArchived = false) {
  return useQuery({
    queryKey: queryKeys.departments(includeArchived),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/departments', {
            params: { query: { includeArchived: includeArchived ? 'true' : 'false' } },
          }),
        )
      ).data,
  });
}

export function useTeams(includeArchived = false) {
  return useQuery({
    queryKey: queryKeys.teams(includeArchived),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/teams', { params: { query: { includeArchived: includeArchived ? 'true' : 'false' } } }),
        )
      ).data,
  });
}

export function useTeam(id: string) {
  return useQuery({
    queryKey: queryKeys.team(id),
    queryFn: async () => (await request(() => api.GET('/api/v1/teams/{id}', { params: { path: { id } } }))).data,
  });
}

export function useTeamMembers(id: string) {
  return useQuery({
    queryKey: queryKeys.teamMembers(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/teams/{id}/members', { params: { path: { id } } }))).data,
  });
}

export function useJobTitles(includeArchived = false) {
  return useQuery({
    queryKey: queryKeys.jobTitles(includeArchived),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/job-titles', { params: { query: { includeArchived: includeArchived ? 'true' : 'false' } } }),
        )
      ).data,
  });
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: queryKeys.roles,
    queryFn: async () => (await request(() => api.GET('/api/v1/roles'))).data,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMemberRoles(memberId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.memberRoles(memberId ?? ''),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/members/{memberId}/roles', { params: { path: { memberId: memberId ?? '' } } }),
        )
      ).data,
    enabled: memberId !== undefined,
  });
}

export function useAuditEvents(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/audit/events', {
          params: {
            query: { ...compact(filters), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useNotifications(unreadOnly: boolean, limit = PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.notifications(unreadOnly), limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/notifications', {
          params: {
            query: {
              unreadOnly: unreadOnly ? 'true' : 'false',
              limit,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: queryKeys.unreadCount,
    queryFn: async () => (await request(() => api.GET('/api/v1/notifications/unread-count'))).data.unread,
    refetchInterval: 60_000,
  });
}

export function useFailedJobs() {
  return useQuery({
    queryKey: queryKeys.failedJobs,
    queryFn: async () => (await request(() => api.GET('/api/v1/admin/failed-jobs'))).data,
  });
}
