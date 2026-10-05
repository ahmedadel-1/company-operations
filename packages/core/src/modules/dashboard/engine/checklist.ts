/** First-run setup checklist (ADR-0023): derived from real state on every request, never stored. */
export type SetupItemKey =
  | 'organization'
  | 'departments'
  | 'employees'
  | 'work_locations'
  | 'attendance_policy'
  | 'request_types'
  | 'sla'
  | 'projects'
  | 'jira'
  | 'github';

export interface SetupFacts {
  readonly departments: number;
  /** Members other than the first administrator (invited or active). */
  readonly otherMembers: number;
  readonly activeWorkLocations: number;
  readonly attendancePolicy: boolean;
  readonly publishedRequestTypes: number;
  readonly slaPolicies: number;
  readonly projects: number;
  readonly jiraConnected: boolean;
  readonly githubConnected: boolean;
}

export interface SetupItem {
  readonly key: SetupItemKey;
  readonly done: boolean;
  readonly optional: boolean;
  readonly count: number;
  readonly path: string;
}

const flag = (value: boolean): number => (value ? 1 : 0);

export function deriveChecklist(facts: SetupFacts): {
  readonly items: readonly SetupItem[];
  readonly completed: number;
  readonly required: number;
} {
  const items: SetupItem[] = [
    { key: 'organization', done: true, optional: false, count: 1, path: '/admin/organization' },
    {
      key: 'departments',
      done: facts.departments > 0,
      optional: false,
      count: facts.departments,
      path: '/departments',
    },
    { key: 'employees', done: facts.otherMembers > 0, optional: false, count: facts.otherMembers, path: '/people' },
    {
      key: 'work_locations',
      done: facts.activeWorkLocations > 0,
      optional: false,
      count: facts.activeWorkLocations,
      path: '/admin/work-locations',
    },
    {
      key: 'attendance_policy',
      done: facts.attendancePolicy,
      optional: false,
      count: flag(facts.attendancePolicy),
      path: '/admin/attendance',
    },
    {
      key: 'request_types',
      done: facts.publishedRequestTypes > 0,
      optional: false,
      count: facts.publishedRequestTypes,
      path: '/admin/request-types',
    },
    { key: 'sla', done: facts.slaPolicies > 0, optional: false, count: facts.slaPolicies, path: '/admin/support' },
    { key: 'projects', done: facts.projects > 0, optional: false, count: facts.projects, path: '/projects' },
    {
      key: 'jira',
      done: facts.jiraConnected,
      optional: true,
      count: flag(facts.jiraConnected),
      path: '/admin/integrations/jira',
    },
    {
      key: 'github',
      done: facts.githubConnected,
      optional: true,
      count: flag(facts.githubConnected),
      path: '/admin/integrations/github',
    },
  ];
  const required = items.filter((item) => !item.optional);
  return { items, completed: required.filter((item) => item.done).length, required: required.length };
}
