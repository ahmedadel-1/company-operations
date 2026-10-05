import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;

export type JiraIntegrationStatus = Data<'/api/v1/integrations/jira'>;
export type JiraConnection = NonNullable<JiraIntegrationStatus['connection']>;
export type JiraSiteOption = Item<'/api/v1/integrations/jira/grants/{grantId}/sites'>;
export type JiraMapping = Item<'/api/v1/integrations/jira/mappings'>;
export type JiraProjectOption = Item<'/api/v1/integrations/jira/projects'>;
export type JiraRun = Item<'/api/v1/integrations/jira/sync-runs'>;
export type JiraRunDetail = Data<'/api/v1/integrations/jira/sync-runs/{id}'>;
export type JiraDeliveryFailure = Item<'/api/v1/integrations/jira/webhook-deliveries/failures'>;
export type TicketJiraPanel = Data<'/api/v1/support/tickets/{id}/jira'>;
export type TicketJiraLink = TicketJiraPanel['links'][number];
export type JiraIssue = TicketJiraLink['issue'];
export type JiraSearchResult = Item<'/api/v1/support/tickets/{id}/jira/search'>;
export type JiraProjectOverview = Data<'/api/v1/projects/{id}/jira'>;

export type JiraRunStatus = JiraRun['status'];
export type JiraRunType = JiraRun['type'];
export type JiraLinkType = TicketJiraLink['linkType'];
export type JiraStatusCategory = JiraIssue['statusCategory'];

export const JIRA_LINK_TYPES = ['FIX_TRACKED_BY', 'CAUSED_BY', 'RELATED'] as const satisfies readonly JiraLinkType[];
export const JIRA_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_FAILED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly JiraRunStatus[];
export const ACTIVE_RUN_STATUSES: readonly JiraRunStatus[] = ['QUEUED', 'RUNNING'];

export const jiraKeys = {
  all: ['jira'] as const,
  status: ['jira', 'status'] as const,
  sites: (grantId: string) => ['jira', 'grants', grantId] as const,
  mappings: ['jira', 'mappings'] as const,
  projects: (q: string) => ['jira', 'projects', q] as const,
  runs: (status: string) => ['jira', 'runs', status] as const,
  run: (id: string) => ['jira', 'run', id] as const,
  failures: ['jira', 'failures'] as const,
  ticket: (ticketId: string) => ['jira', 'ticket', ticketId] as const,
  search: (ticketId: string, q: string, source: string) => ['jira', 'ticket', ticketId, 'search', q, source] as const,
  issueTypes: (ticketId: string, mappingId: string) => ['jira', 'ticket', ticketId, 'types', mappingId] as const,
  project: (projectId: string) => ['jira', 'project', projectId] as const,
};

export function useJiraStatus() {
  return useQuery({
    queryKey: jiraKeys.status,
    queryFn: async () => (await request(() => api.GET('/api/v1/integrations/jira'))).data,
  });
}

export function useJiraSites(grantId: string | null) {
  return useQuery({
    queryKey: jiraKeys.sites(grantId ?? ''),
    enabled: grantId !== null,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/integrations/jira/grants/{grantId}/sites', { params: { path: { grantId: grantId ?? '' } } }),
        )
      ).data,
  });
}

export function useJiraMappings(enabled: boolean, live: boolean) {
  return useQuery({
    queryKey: jiraKeys.mappings,
    enabled,
    // While a run is active the list refreshes on progress events; this is the fallback without SSE.
    refetchInterval: live ? 10_000 : false,
    queryFn: async () => (await request(() => api.GET('/api/v1/integrations/jira/mappings'))).data,
  });
}

export function useJiraProjects(q: string, enabled: boolean) {
  return useQuery({
    queryKey: jiraKeys.projects(q),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => request(() => api.GET('/api/v1/integrations/jira/projects', { params: { query: { q } } })),
  });
}

export function useJiraRuns(status: JiraRunStatus | '') {
  return useInfiniteQuery({
    queryKey: jiraKeys.runs(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/integrations/jira/sync-runs', {
          params: {
            query: { ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useJiraRun(id: string | null) {
  return useQuery({
    queryKey: jiraKeys.run(id ?? ''),
    enabled: id !== null,
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/integrations/jira/sync-runs/{id}', { params: { path: { id: id ?? '' } } })))
        .data,
  });
}

export function useJiraDeliveryFailures(enabled: boolean) {
  return useQuery({
    queryKey: jiraKeys.failures,
    enabled,
    queryFn: async () => (await request(() => api.GET('/api/v1/integrations/jira/webhook-deliveries/failures'))).data,
  });
}

export function useTicketJira(ticketId: string) {
  return useQuery({
    queryKey: jiraKeys.ticket(ticketId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/support/tickets/{id}/jira', { params: { path: { id: ticketId } } }))).data,
  });
}

export function useTicketJiraSearch(ticketId: string, q: string, source: 'cache' | 'jira', enabled: boolean) {
  return useQuery({
    queryKey: jiraKeys.search(ticketId, q, source),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/tickets/{id}/jira/search', {
            params: { path: { id: ticketId }, query: { q, source } },
          }),
        )
      ).data,
  });
}

export function useJiraIssueTypes(ticketId: string, mappingId: string | null) {
  return useQuery({
    queryKey: jiraKeys.issueTypes(ticketId, mappingId ?? ''),
    enabled: mappingId !== null && mappingId !== '',
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/tickets/{id}/jira/issue-types', {
            params: { path: { id: ticketId }, query: { mappingId: mappingId ?? '' } },
          }),
        )
      ).data,
  });
}

export function useProjectJira(projectId: string) {
  return useQuery({
    queryKey: jiraKeys.project(projectId),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/jira', { params: { path: { id: projectId } } }))).data,
  });
}
