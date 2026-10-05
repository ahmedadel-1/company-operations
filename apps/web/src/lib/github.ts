import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;

export type GithubIntegrationStatus = Data<'/api/v1/integrations/github'>;
export type GithubInstallation = GithubIntegrationStatus['installations'][number];
export type GithubRepository = Item<'/api/v1/integrations/github/repositories'>;
export type GithubRun = Item<'/api/v1/integrations/github/sync-runs'>;
export type GithubRunDetail = Data<'/api/v1/integrations/github/sync-runs/{id}'>;
export type GithubDelivery = Item<'/api/v1/integrations/github/webhook-deliveries'>;
export type GithubProjectOverview = Data<'/api/v1/projects/{id}/github'>;
export type GithubProjectRepository = GithubProjectOverview['repositories'][number];
export type GithubPull = GithubProjectOverview['pulls'][number];
export type GithubPrJiraLink = GithubPull['jiraLinks'][number];
export type TicketGithubPanel = Data<'/api/v1/support/tickets/{id}/github'>;
export type TicketPull = TicketGithubPanel['pulls'][number];
export type TicketPullOption = Item<'/api/v1/support/tickets/{id}/github/search'>;
export type RetentionPolicy = Item<'/api/v1/organization/retention-policies'>;
export type RetentionPreview = Data<'/api/v1/organization/retention-policies/{category}/preview'>;

export type GithubRunStatus = GithubRun['status'];
export type GithubDeliveryStatus = GithubDelivery['status'];
export type GithubPullSignal = GithubPull['signals'][number];

export const GITHUB_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_FAILED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly GithubRunStatus[];
export const GITHUB_DELIVERY_STATUSES = [
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
] as const satisfies readonly GithubDeliveryStatus[];
export const ACTIVE_GITHUB_RUN_STATUSES: readonly GithubRunStatus[] = ['QUEUED', 'RUNNING'];

export const githubKeys = {
  all: ['github'] as const,
  status: ['github', 'status'] as const,
  repositoriesAll: ['github', 'repositories'] as const,
  repositories: (includeUnavailable: boolean) => ['github', 'repositories', includeUnavailable] as const,
  runsAll: ['github', 'runs'] as const,
  runs: (status: string) => ['github', 'runs', status] as const,
  run: (id: string) => ['github', 'run', id] as const,
  deliveries: (status: string) => ['github', 'deliveries', status] as const,
  project: (projectId: string) => ['github', 'project', projectId] as const,
  pulls: (projectId: string, state: string) => ['github', 'project', projectId, 'pulls', state] as const,
  jiraIssues: (projectId: string, q: string) => ['github', 'project', projectId, 'jira-issues', q] as const,
  ticket: (ticketId: string) => ['github', 'ticket', ticketId] as const,
  search: (ticketId: string, q: string) => ['github', 'ticket', ticketId, 'search', q] as const,
  retention: ['retention'] as const,
};

export function useGithubStatus() {
  return useQuery({
    queryKey: githubKeys.status,
    queryFn: async () => (await request(() => api.GET('/api/v1/integrations/github'))).data,
  });
}

export function useGithubRepositories(enabled: boolean, includeUnavailable: boolean, live: boolean) {
  return useQuery({
    queryKey: githubKeys.repositories(includeUnavailable),
    enabled,
    // While a run is active the list refreshes on progress events; this is the fallback without SSE.
    refetchInterval: live ? 10_000 : false,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/integrations/github/repositories', {
            params: { query: includeUnavailable ? { includeUnavailable: 'true' } : {} },
          }),
        )
      ).data,
  });
}

export function useGithubRuns(status: GithubRunStatus | '') {
  return useInfiniteQuery({
    queryKey: githubKeys.runs(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/integrations/github/sync-runs', {
          params: {
            query: { ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useGithubRun(id: string | null) {
  return useQuery({
    queryKey: githubKeys.run(id ?? ''),
    enabled: id !== null,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/integrations/github/sync-runs/{id}', { params: { path: { id: id ?? '' } } }),
        )
      ).data,
  });
}

export function useGithubDeliveries(status: GithubDeliveryStatus | '', enabled: boolean) {
  return useInfiniteQuery({
    queryKey: githubKeys.deliveries(status),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/integrations/github/webhook-deliveries', {
          params: {
            query: { ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useProjectGithub(projectId: string) {
  return useQuery({
    queryKey: githubKeys.project(projectId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/github', { params: { path: { id: projectId } } }))).data,
  });
}

export function useProjectPulls(projectId: string, state: GithubPull['state'] | '', enabled: boolean) {
  return useInfiniteQuery({
    queryKey: githubKeys.pulls(projectId, state),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/projects/{id}/github/pulls', {
          params: {
            path: { id: projectId },
            query: { ...(state === '' ? {} : { state }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useProjectJiraIssueSearch(projectId: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.jiraIssues(projectId, q),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/projects/{id}/github/jira-issues', { params: { path: { id: projectId }, query: { q } } }),
        )
      ).data,
  });
}

export function useTicketGithub(ticketId: string) {
  return useQuery({
    queryKey: githubKeys.ticket(ticketId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/support/tickets/{id}/github', { params: { path: { id: ticketId } } })))
        .data,
  });
}

export function useTicketPullSearch(ticketId: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.search(ticketId, q),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/tickets/{id}/github/search', { params: { path: { id: ticketId }, query: { q } } }),
        )
      ).data,
  });
}

export function useRetentionPolicies(enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.retention,
    enabled,
    queryFn: async () => (await request(() => api.GET('/api/v1/organization/retention-policies'))).data,
  });
}
