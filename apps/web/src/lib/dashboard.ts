import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;

export type MeDashboard = Data<'/api/v1/dashboard/me'>;
export type TeamDashboard = Data<'/api/v1/dashboard/team'>;
export type SupportDashboard = Data<'/api/v1/dashboard/support'>;
export type ProjectsDashboard = Data<'/api/v1/dashboard/projects'>;
export type ExecutiveDashboard = Data<'/api/v1/dashboard/executive'>;
export type NeedsAttention = Data<'/api/v1/dashboard/needs-attention'>;
export type AttentionItem = NeedsAttention['items'][number];
export type Trend = Data<'/api/v1/dashboard/trends'>;
export type TrendMetric = Trend['metric'];
export type TrendRange = Trend['range'];
export type SearchResults = Data<'/api/v1/search'>;
export type SearchGroup = SearchResults['groups'][number];
export type SearchType = SearchGroup['type'];
export type SetupChecklist = Data<'/api/v1/organization/setup-checklist'>;
export type NotificationPreferences = Data<'/api/v1/notifications/preferences'>;
export type NotificationCategory = NotificationPreferences['items'][number]['category'];
export type DashboardMetric = MeDashboard['myPendingRequests'];
export type SupportSection = SupportDashboard['support'];
export type ProjectsSection = ProjectsDashboard['projects'];
export type DevelopmentSection = ProjectsDashboard['development'];
export type AttendanceTodaySection = TeamDashboard['attendance'];

export const TREND_RANGES = ['today', '7d', '30d', '90d'] as const satisfies readonly TrendRange[];
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
] as const satisfies readonly SearchType[];
export const SEARCH_MIN_LENGTH = 2;

/**
 * Dashboards refetch every minute (the server cache lives 60 s) and on live-update hints, so a page left
 * open stays current with or without the event stream.
 */
const REFRESH_MS = 60_000;

export const dashboardKeys = {
  all: ['dashboard'] as const,
  me: ['dashboard', 'me'] as const,
  team: ['dashboard', 'team'] as const,
  support: ['dashboard', 'support'] as const,
  projects: ['dashboard', 'projects'] as const,
  executive: ['dashboard', 'executive'] as const,
  attention: ['dashboard', 'attention'] as const,
  trend: (metric: TrendMetric, range: TrendRange) => ['dashboard', 'trend', metric, range] as const,
  checklist: ['dashboard', 'setup-checklist'] as const,
  search: (q: string, types: readonly SearchType[]) => ['search', q, types.join(',')] as const,
  preferences: ['notifications', 'preferences'] as const,
};

const live = { refetchInterval: REFRESH_MS, refetchOnWindowFocus: true, placeholderData: keepPreviousData } as const;

export function useMeDashboard() {
  return useQuery({
    queryKey: dashboardKeys.me,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/me'))).data,
    ...live,
  });
}

export function useTeamDashboard(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.team,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/team'))).data,
    enabled,
    ...live,
  });
}

export function useSupportDashboard(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.support,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/support'))).data,
    enabled,
    ...live,
  });
}

export function useProjectsDashboard(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.projects,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/projects'))).data,
    enabled,
    ...live,
  });
}

export function useExecutiveDashboard(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.executive,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/executive'))).data,
    enabled,
    ...live,
  });
}

export function useNeedsAttention() {
  return useQuery({
    queryKey: dashboardKeys.attention,
    queryFn: async () => (await request(() => api.GET('/api/v1/dashboard/needs-attention'))).data,
    ...live,
  });
}

export function useTrend(metric: TrendMetric, range: TrendRange, enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.trend(metric, range),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/dashboard/trends', { params: { query: { metric, range } } }))).data,
    enabled,
    ...live,
  });
}

export function useSetupChecklist(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.checklist,
    queryFn: async () => (await request(() => api.GET('/api/v1/organization/setup-checklist'))).data,
    enabled,
  });
}

/** One query per type when paging ("more"), all types otherwise. The server bounds every page. */
export function useSearch(q: string, types: readonly SearchType[], locale: 'en' | 'ar') {
  const normalized = q.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return useInfiniteQuery({
    queryKey: [...dashboardKeys.search(normalized, types), locale],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await request(() =>
          api.GET('/api/v1/search', {
            params: {
              query: {
                q: normalized,
                locale,
                ...(types.length === 0 ? {} : { types: types.join(',') }),
                ...(pageParam === undefined ? {} : { cursor: pageParam }),
              },
            },
          }),
        )
      ).data,
    getNextPageParam: (last) => (types.length === 1 ? (last.groups[0]?.nextCursor ?? undefined) : undefined),
    enabled: normalized.length >= SEARCH_MIN_LENGTH,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: dashboardKeys.preferences,
    queryFn: async () => (await request(() => api.GET('/api/v1/notifications/preferences'))).data,
  });
}

export interface PreferenceChange {
  readonly category: NotificationCategory;
  readonly channel: 'IN_APP' | 'EMAIL';
  readonly enabled: boolean;
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: readonly PreferenceChange[]) =>
      (await request(() => api.PUT('/api/v1/notifications/preferences', { body: { items: [...items] } }))).data,
    onSuccess: (data) => {
      queryClient.setQueryData(dashboardKeys.preferences, data);
    },
  });
}
