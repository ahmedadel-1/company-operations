import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

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

export type TicketSummary = Item<'/api/v1/support/tickets'>;
export type Ticket = Data<'/api/v1/support/tickets/{id}'>;
export type TicketComment = Item<'/api/v1/support/tickets/{id}/comments'>;
export type TicketEvent = Item<'/api/v1/support/tickets/{id}/history'>;
export type TicketWatcher = Item<'/api/v1/support/tickets/{id}/watchers'>;
export type TicketAssignee = Item<'/api/v1/support/tickets/{id}/assignees'>;
export type SupportCategory = Item<'/api/v1/support/categories'>;
export type SupportComponent = Item<'/api/v1/support/components'>;
export type BusinessCalendar = Item<'/api/v1/support/calendars'>;
export type SlaPolicy = Item<'/api/v1/support/sla-policies'>;
export type EscalationRule = Item<'/api/v1/support/escalation-rules'>;
export type ProjectSupport = Data<'/api/v1/projects/{id}/support'>;

export type TicketStatus = TicketSummary['status'];
export type TicketSeverity = TicketSummary['severity'];
export type TicketPriority = TicketSummary['priority'];
export type TicketImpact = TicketSummary['impact'];
export type TicketSource = TicketSummary['source'];
export type SlaState = NonNullable<TicketSummary['sla']>['resolutionState'];
export type TicketQuery = Omit<Query<'/api/v1/support/tickets'>, 'cursor' | 'limit'>;
export type TicketView = NonNullable<TicketQuery['view']>;
export type TicketSort = NonNullable<TicketQuery['sort']>;

export const TICKET_STATUSES = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly TicketStatus[];
export const TICKET_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const satisfies readonly TicketSeverity[];
export const TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const satisfies readonly TicketPriority[];
export const TICKET_IMPACTS = [
  'SINGLE_USER',
  'MULTIPLE_USERS',
  'SITE',
  'ALL_USERS',
] as const satisfies readonly TicketImpact[];
export const TICKET_SOURCES = [
  'FIELD',
  'CUSTOMER_PHONE',
  'CUSTOMER_EMAIL',
  'MONITORING',
  'INTERNAL',
  'OTHER',
] as const satisfies readonly TicketSource[];
export const SLA_STATES = ['ON_TRACK', 'AT_RISK', 'BREACHED', 'PAUSED', 'MET'] as const;
export const TICKET_VIEWS = [
  'open',
  'assigned_to_me',
  'reported_by_me',
  'watching',
  'unassigned',
  'untriaged',
  'critical',
  'sla_risk',
  'all',
] as const satisfies readonly TicketView[];
export const TICKET_SORTS = [
  'createdAt:desc',
  'createdAt:asc',
  'updatedAt:desc',
  'priority:asc',
] as const satisfies readonly TicketSort[];

const PAGE_SIZE = 25;

export const supportKeys = {
  all: ['support'] as const,
  tickets: (filters: TicketQuery) => ['support', 'tickets', filters] as const,
  ticket: (id: string) => ['support', 'ticket', id] as const,
  comments: (id: string) => ['support', 'ticket', id, 'comments'] as const,
  history: (id: string) => ['support', 'ticket', id, 'history'] as const,
  watchers: (id: string) => ['support', 'ticket', id, 'watchers'] as const,
  assignees: (id: string, teamId: string | null, q: string) =>
    ['support', 'ticket', id, 'assignees', teamId, q] as const,
  categories: (includeInactive: boolean, projectId: string | null) =>
    ['support', 'categories', includeInactive, projectId] as const,
  components: (includeInactive: boolean, projectId: string | null) =>
    ['support', 'components', includeInactive, projectId] as const,
  calendars: ['support', 'calendars'] as const,
  policies: ['support', 'sla-policies'] as const,
  rules: ['support', 'escalation-rules'] as const,
  project: (id: string) => ['support', 'project', id] as const,
};

function compact<T extends object>(filters: T): T {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as T;
}

export function useTickets(filters: TicketQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: supportKeys.tickets(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/support/tickets', {
          params: {
            query: { ...compact(filters), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTicket(id: string) {
  return useQuery({
    queryKey: supportKeys.ticket(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/support/tickets/{id}', { params: { path: { id } } }))).data,
  });
}

export function useTicketComments(id: string) {
  return useInfiniteQuery({
    queryKey: supportKeys.comments(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/support/tickets/{id}/comments', {
          params: { path: { id }, query: { limit: 50, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useTicketHistory(id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: supportKeys.history(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/support/tickets/{id}/history', {
          params: { path: { id }, query: { limit: 50, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useTicketWatchers(id: string) {
  return useQuery({
    queryKey: supportKeys.watchers(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/support/tickets/{id}/watchers', { params: { path: { id } } }))).data,
  });
}

export function useTicketAssignees(id: string, teamId: string | null, q: string, enabled: boolean) {
  return useQuery({
    queryKey: supportKeys.assignees(id, teamId, q),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/tickets/{id}/assignees', {
            params: {
              path: { id },
              query: { ...(teamId === null ? {} : { teamId }), ...(q.trim() === '' ? {} : { q: q.trim() }) },
            },
          }),
        )
      ).data,
    enabled,
  });
}

export function useSupportCategories(options: { includeInactive?: boolean; projectId?: string | null } = {}) {
  const includeInactive = options.includeInactive === true;
  const projectId = options.projectId ?? null;
  return useQuery({
    queryKey: supportKeys.categories(includeInactive, projectId),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/categories', {
            params: {
              query: {
                ...(includeInactive ? { includeInactive: 'true' as const } : {}),
                ...(projectId === null ? {} : { projectId }),
              },
            },
          }),
        )
      ).data,
  });
}

export function useSupportComponents(options: { includeInactive?: boolean; projectId?: string | null } = {}) {
  const includeInactive = options.includeInactive === true;
  const projectId = options.projectId ?? null;
  return useQuery({
    queryKey: supportKeys.components(includeInactive, projectId),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/support/components', {
            params: {
              query: {
                ...(includeInactive ? { includeInactive: 'true' as const } : {}),
                ...(projectId === null ? {} : { projectId }),
              },
            },
          }),
        )
      ).data,
  });
}

export function useBusinessCalendars(enabled = true) {
  return useQuery({
    queryKey: supportKeys.calendars,
    queryFn: async () => (await request(() => api.GET('/api/v1/support/calendars'))).data,
    enabled,
  });
}

export function useSlaPolicies(enabled = true) {
  return useQuery({
    queryKey: supportKeys.policies,
    queryFn: async () => (await request(() => api.GET('/api/v1/support/sla-policies'))).data,
    enabled,
  });
}

export function useEscalationRules(enabled = true) {
  return useQuery({
    queryKey: supportKeys.rules,
    queryFn: async () => (await request(() => api.GET('/api/v1/support/escalation-rules'))).data,
    enabled,
  });
}

export function useProjectSupport(id: string, enabled = true) {
  return useQuery({
    queryKey: supportKeys.project(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/projects/{id}/support', { params: { path: { id } } }))).data,
    enabled,
  });
}

/** Open statuses (mirrors the server's list; used only for presentation). */
export const OPEN_STATUSES: readonly TicketStatus[] = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
];
