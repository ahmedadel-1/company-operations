import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { signWebhookJwt } from '../modules/jira/jira-webhook-jwt.js';

/**
 * Deterministic Jira Cloud + Atlassian OAuth test double (ADR-0019). It implements only the
 * documented contracts the adapter uses — OAuth 3LO with rotating refresh tokens, accessible
 * resources, project search, `search/jql` with opaque `nextPageToken`, approximate count, issue
 * get/bulkfetch/createmeta/create and dynamic webhooks — plus failure injection and signed webhook
 * delivery. It never talks to Atlassian. Used by integration tests (in process, through `fetch`)
 * and end-to-end tests (as an HTTP server with `/__fake/*` control routes).
 */

export type FakeStatusCategory = 'new' | 'indeterminate' | 'done';

export interface FakeIssue {
  id: string;
  key: string;
  projectId: string;
  summary: string;
  issueTypeName: string;
  statusName: string;
  statusCategory: FakeStatusCategory;
  priorityName: string | null;
  assigneeName: string | null;
  created: number;
  updated: number;
  dueDate: string | null;
  labels: string[];
  deleted: boolean;
  description: unknown;
}

export interface FakeProject {
  id: string;
  key: string;
  name: string;
  issueTypes: { id: string; name: string; subtask: boolean }[];
}

export interface FakeSite {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

export type FakeFailureKind =
  'rate_limit' | 'server_error' | 'unavailable' | 'malformed' | 'hang' | 'unauthorized' | 'bad_request';

export interface FakeFailure {
  /** Substring of `METHOD /path` (path without the `/ex/jira/{cloudId}/rest/api/3` prefix), e.g. `POST /search/jql`. */
  readonly match: string;
  readonly kind: FakeFailureKind;
  /** How many matching requests fail (default 1). */
  times?: number;
  readonly retryAfterSeconds?: number;
}

interface FakeWebhook {
  id: number;
  url: string;
  jqlFilter: string;
  events: string[];
  expiresAt: number;
}

interface WebhookDeliveryResult {
  readonly webhookId: number;
  readonly status: number;
  readonly identifier: string;
}

const API_PREFIX = /^\/ex\/jira\/([^/]+)\/rest\/api\/3(\/.*)$/;
const ACCESS_TTL_SECONDS = 3600;
const WEBHOOK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WEBHOOKS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Jira's timestamp format, e.g. `2026-10-03T10:00:00.000+0000`. */
function jiraTime(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+0000');
}

interface ParsedJql {
  projectIds: string[];
  createdWithinMinutes: number | null;
  updatedWithinMinutes: number | null;
  issueKey: string | null;
  text: string | null;
  order: 'created_asc' | 'updated_asc' | 'updated_desc';
}

/** Parses the JQL subset the adapter generates (see `jira-jql.ts`); anything else is a 400. */
export function parseFakeJql(jql: string): ParsedJql | null {
  const match =
    /^project (?:= ([0-9]+)|in \(([0-9, ]+)\))((?: AND (?:created >= -[0-9]+m|updated >= -[0-9]+m|issuekey = "(?:[^"\\]|\\.)*"|text ~ "(?:[^"\\]|\\.)*"))*)(?: ORDER BY (created ASC, key ASC|updated ASC, key ASC|updated DESC))?$/.exec(
      jql,
    );
  if (match === null) {
    return null;
  }
  const ids = match[1] !== undefined ? [match[1]] : (match[2] ?? '').split(',').map((part) => part.trim());
  const clauses = match[3] ?? '';
  const minutes = (field: string): number | null => {
    const found = new RegExp(`${field} >= -([0-9]+)m`).exec(clauses);
    return found?.[1] === undefined ? null : Number(found[1]);
  };
  const quoted = (field: string): string | null => {
    const found = new RegExp(`${field} "((?:[^"\\\\]|\\\\.)*)"`).exec(clauses);
    return found?.[1] === undefined ? null : found[1].replace(/\\(.)/g, '$1');
  };
  const orderBy = match[4];
  return {
    projectIds: ids,
    createdWithinMinutes: minutes('created'),
    updatedWithinMinutes: minutes('updated'),
    issueKey: quoted('issuekey ='),
    text: quoted('text ~'),
    order:
      orderBy === 'updated DESC' ? 'updated_desc' : orderBy === 'updated ASC, key ASC' ? 'updated_asc' : 'created_asc',
  };
}

export interface FakeJiraOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly now?: () => number;
  /** How long a `hang` failure waits (default 30 s); aborted requests end earlier. */
  readonly hangMs?: number;
  /** How webhook deliveries are posted (defaults to global fetch). */
  readonly deliver?: (url: string, init: RequestInit) => Promise<Response>;
}

export class FakeJira {
  readonly clientId: string;
  readonly clientSecret: string;
  private readonly clock: () => number;
  private readonly hangMs: number;
  private readonly deliver: (url: string, init: RequestInit) => Promise<Response>;

  sites: FakeSite[] = [];
  readonly projects = new Map<string, FakeProject>();
  readonly issues = new Map<string, FakeIssue>();
  readonly webhooks = new Map<number, FakeWebhook>();
  readonly failures: FakeFailure[] = [];
  /** `METHOD /path` of every API request, in order. */
  readonly requests: string[] = [];
  /** Issues created through `POST /issue`, with the fields exactly as sent. */
  readonly createdIssues: { id: string; key: string; fields: Record<string, unknown> }[] = [];
  /** `deny` makes the authorize step redirect back with `error=access_denied`. */
  authorizeMode: 'approve' | 'deny' = 'approve';
  /** Page tokens issued before this generation are rejected (simulates expired tokens). */
  private pageTokenGeneration = 0;
  /** Webhook registration refusals left (simulates Jira refusing the filter). */
  refuseWebhookRegistrations = 0;

  private readonly codes = new Map<string, number>();
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Map<string, { valid: boolean }>();
  private counter = 0;
  private nextIssueNumber = 10000;
  private nextWebhookId = 1;

  constructor(options: FakeJiraOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.clock = options.now ?? Date.now;
    this.hangMs = options.hangMs ?? 30_000;
    this.deliver = options.deliver ?? ((url, init) => fetch(url, init));
    this.reset();
  }

  /** Default fixture: one site with two projects and a handful of issues. */
  reset(): void {
    this.projects.clear();
    this.issues.clear();
    this.webhooks.clear();
    this.failures.length = 0;
    this.requests.length = 0;
    this.createdIssues.length = 0;
    this.codes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.authorizeMode = 'approve';
    this.refuseWebhookRegistrations = 0;
    this.pageTokenGeneration += 1;
    this.counter = 0;
    this.nextIssueNumber = 10000;
    this.nextWebhookId = 1;
    this.sites = [
      {
        id: 'fake-cloud-1',
        name: 'Fake Jira',
        url: 'https://fake-jira.example.test',
        scopes: ['read:jira-work', 'write:jira-work', 'manage:jira-webhook'],
      },
    ];
    const issueTypes = [
      { id: '10001', name: 'Bug', subtask: false },
      { id: '10002', name: 'Task', subtask: false },
      { id: '10003', name: 'Sub-task', subtask: true },
    ];
    this.projects.set('20001', { id: '20001', key: 'OPS', name: 'Operations Platform', issueTypes });
    this.projects.set('20002', { id: '20002', key: 'MOB', name: 'Mobile App', issueTypes });
    const base = this.clock() - 10 * 24 * 60 * 60 * 1000;
    const seed: [string, string, string, FakeStatusCategory, string | null][] = [
      ['20001', 'Login fails on Safari', 'In Progress', 'indeterminate', null],
      ['20001', 'Export to CSV times out', 'To Do', 'new', '2020-01-01'],
      ['20001', 'Dashboard widget overlaps', 'Blocked', 'indeterminate', null],
      ['20001', 'Password reset email delay', 'Done', 'done', null],
      ['20002', 'Crash on startup (Android 15)', 'To Do', 'new', null],
    ];
    seed.forEach(([projectId, summary, statusName, category, due], index) => {
      this.addIssue({
        projectId,
        summary,
        statusName,
        statusCategory: category,
        dueDate: due,
        created: base + index * 60_000,
        updated: base + index * 60_000,
      });
    });
  }

  addIssue(input: Partial<FakeIssue> & { projectId: string; summary: string }): FakeIssue {
    const project = this.projects.get(input.projectId);
    if (project === undefined) {
      throw new Error(`Unknown fake project ${input.projectId}`);
    }
    const id = input.id ?? String(this.nextIssueNumber++);
    const sameProject = [...this.issues.values()].filter((issue) => issue.projectId === project.id).length;
    const now = this.clock();
    const issue: FakeIssue = {
      id,
      key: input.key ?? `${project.key}-${String(sameProject + 1)}`,
      projectId: project.id,
      summary: input.summary,
      issueTypeName: input.issueTypeName ?? 'Bug',
      statusName: input.statusName ?? 'To Do',
      statusCategory: input.statusCategory ?? 'new',
      priorityName: input.priorityName ?? 'Medium',
      assigneeName: input.assigneeName ?? null,
      created: input.created ?? now,
      updated: input.updated ?? now,
      dueDate: input.dueDate ?? null,
      labels: input.labels ?? [],
      deleted: input.deleted ?? false,
      description: input.description ?? null,
    };
    this.issues.set(id, issue);
    return issue;
  }

  /** Changes an issue in "Jira" (bumps `updated`). */
  updateIssue(idOrKey: string, change: Partial<Omit<FakeIssue, 'id' | 'key' | 'projectId'>>): FakeIssue {
    const issue = this.findIssue(idOrKey);
    if (issue === null) {
      throw new Error(`Unknown fake issue ${idOrKey}`);
    }
    Object.assign(issue, change, { updated: Math.max(this.clock(), issue.updated + 1) });
    return issue;
  }

  deleteIssue(idOrKey: string): void {
    const issue = this.findIssue(idOrKey);
    if (issue !== null) {
      issue.deleted = true;
    }
  }

  fail(failure: FakeFailure): void {
    this.failures.push({ ...failure, times: failure.times ?? 1 });
  }

  /** The user revoked consent: every token stops working (refresh answers `invalid_grant`). */
  revokeGrants(): void {
    for (const token of this.refreshTokens.values()) {
      token.valid = false;
    }
    this.accessTokens.clear();
  }

  /** Invalidates current access tokens only (forces a refresh). */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  expirePageTokens(): void {
    this.pageTokenGeneration += 1;
  }

  /**
   * Delivers a webhook for an issue to every registration whose filter covers its project, signed
   * the way Jira signs deliveries for OAuth 2.0 apps. `identifier` lets tests replay a delivery.
   */
  async emitWebhook(
    idOrKey: string,
    event: 'jira:issue_created' | 'jira:issue_updated' | 'jira:issue_deleted',
    options: { identifier?: string; retry?: number; secret?: string } = {},
  ): Promise<WebhookDeliveryResult[]> {
    const issue = this.findIssue(idOrKey);
    if (issue === null) {
      throw new Error(`Unknown fake issue ${idOrKey}`);
    }
    const results: WebhookDeliveryResult[] = [];
    for (const webhook of this.webhooks.values()) {
      const filter = parseFakeJql(webhook.jqlFilter);
      if (filter === null || !filter.projectIds.includes(issue.projectId) || !webhook.events.includes(event)) {
        continue;
      }
      const nowSeconds = Math.floor(this.clock() / 1000);
      const token = signWebhookJwt(
        { iss: this.clientId, iat: nowSeconds, exp: nowSeconds + 180, sub: 'fake-jira' },
        options.secret ?? this.clientSecret,
      );
      const identifier = options.identifier ?? `fake-delivery-${String(++this.counter)}`;
      const response = await this.deliver(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-atlassian-webhook-identifier': identifier,
          'x-atlassian-webhook-retry': String(options.retry ?? 0),
        },
        body: JSON.stringify({
          timestamp: this.clock(),
          webhookEvent: event,
          matchedWebhookIds: [webhook.id],
          issue: {
            id: issue.id,
            key: issue.key,
            self: `${webhook.url}#${issue.id}`,
            fields: { project: { id: issue.projectId } },
          },
        }),
      });
      results.push({ webhookId: webhook.id, status: response.status, identifier });
    }
    return results;
  }

  /** `fetch`-compatible entry point for in-process use. */
  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => this.handle(new Request(url, init));

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/__fake/')) {
      return this.control(request, path.slice('/__fake'.length));
    }
    if (request.method === 'GET' && path === '/authorize') {
      return this.authorize(url);
    }
    if (request.method === 'POST' && path === '/oauth/token') {
      return this.token(await this.body(request));
    }
    if (request.method === 'GET' && path === '/oauth/token/accessible-resources') {
      return this.authenticated(request) ? json(200, this.sites) : json(401, { code: 401, message: 'Unauthorized' });
    }
    const api = API_PREFIX.exec(path);
    if (api === null) {
      return json(404, { errorMessages: ['Not found'] });
    }
    const [, cloudId = '', rest = ''] = api;
    const signature = `${request.method} ${rest}`;
    this.requests.push(signature);
    const injected = await this.injectedFailure(signature, request.signal);
    if (injected !== null) {
      return injected;
    }
    if (!this.authenticated(request)) {
      return json(401, { code: 401, message: 'Unauthorized' });
    }
    if (!this.sites.some((site) => site.id === cloudId)) {
      return json(404, { errorMessages: ['Site not found'] });
    }
    return this.api(request, rest, url);
  }

  private authorize(url: URL): Response {
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    if (redirect === null || url.searchParams.get('client_id') !== this.clientId) {
      return json(400, { error: 'invalid_request' });
    }
    const target = new URL(redirect);
    target.searchParams.set('state', state);
    if (this.authorizeMode === 'deny') {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = `code-${String(++this.counter)}`;
      this.codes.set(code, this.clock());
      target.searchParams.set('code', code);
    }
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private token(body: unknown): Response {
    if (!isRecord(body) || body.client_id !== this.clientId || body.client_secret !== this.clientSecret) {
      return json(401, { error: 'access_denied', error_description: 'Unauthorized' });
    }
    if (body.grant_type === 'authorization_code') {
      const code = text(body.code);
      if (code === null || !this.codes.delete(code)) {
        return json(403, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      }
      return json(200, this.issueTokens());
    }
    if (body.grant_type === 'refresh_token') {
      const refresh = this.refreshTokens.get(text(body.refresh_token) ?? '');
      if (refresh?.valid !== true) {
        return json(403, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' });
      }
      return json(200, this.issueTokens());
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private issueTokens(): Record<string, unknown> {
    const access = `fake-access-${String(++this.counter)}`;
    const refresh = `fake-refresh-${String(++this.counter)}`;
    this.accessTokens.set(access, this.clock() + ACCESS_TTL_SECONDS * 1000);
    this.refreshTokens.set(refresh, { valid: true });
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: ACCESS_TTL_SECONDS,
      scope: 'read:jira-work write:jira-work manage:jira-webhook offline_access',
      token_type: 'Bearer',
    };
  }

  private authenticated(request: Request): boolean {
    const header = request.headers.get('authorization') ?? '';
    const expires = this.accessTokens.get(header.replace(/^Bearer /, ''));
    return expires !== undefined && expires > this.clock();
  }

  private async injectedFailure(signature: string, signal: AbortSignal): Promise<Response | null> {
    const index = this.failures.findIndex((failure) => signature.includes(failure.match));
    const failure = this.failures[index];
    if (failure === undefined) {
      return null;
    }
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) {
      this.failures.splice(index, 1);
    }
    const retryAfter =
      failure.retryAfterSeconds === undefined ? {} : { 'retry-after': String(failure.retryAfterSeconds) };
    switch (failure.kind) {
      case 'rate_limit':
        return json(429, { message: 'Rate limit exceeded' }, { ...retryAfter, 'ratelimit-reason': 'jira-burst-based' });
      case 'server_error':
        return json(500, { errorMessages: ['Internal server error'] });
      case 'unavailable':
        return json(503, { errorMessages: ['Service unavailable'] }, retryAfter);
      case 'malformed':
        return new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      case 'unauthorized':
        return json(401, { code: 401, message: 'Unauthorized' });
      case 'bad_request':
        return json(400, { errorMessages: [], errors: { summary: 'Field is invalid.' } });
      case 'hang':
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.hangMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return json(504, { errorMessages: ['Gateway timeout'] });
    }
  }

  private async api(request: Request, rest: string, url: URL): Promise<Response> {
    const method = request.method;
    let match: RegExpExecArray | null;
    if (method === 'GET' && rest !== '/project/search' && (match = /^\/project\/([^/]+)$/.exec(rest)) !== null) {
      const project = this.findProject(decodeURIComponent(match[1] ?? ''));
      return project === null
        ? json(404, { errorMessages: ['No project could be found.'] })
        : json(200, this.projectWire(project));
    }
    if (method === 'GET' && rest === '/project/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const startAt = Number(url.searchParams.get('startAt') ?? '0');
      const maxResults = Number(url.searchParams.get('maxResults') ?? '50');
      const all = [...this.projects.values()]
        .filter(
          (project) =>
            query === '' || project.key.toLowerCase().includes(query) || project.name.toLowerCase().includes(query),
        )
        .sort((a, b) => a.key.localeCompare(b.key));
      const values = all.slice(startAt, startAt + maxResults);
      return json(200, {
        values: values.map((project) => this.projectWire(project)),
        isLast: startAt + maxResults >= all.length,
        total: all.length,
      });
    }
    if (method === 'POST' && rest === '/search/jql') {
      return this.search(await this.body(request));
    }
    if (method === 'POST' && rest === '/search/approximate-count') {
      const body = await this.body(request);
      const parsed = parseFakeJql(isRecord(body) ? (text(body.jql) ?? '') : '');
      return parsed === null
        ? json(400, { errorMessages: ['Invalid JQL'] })
        : json(200, { count: this.matching(parsed).length });
    }
    if (method === 'POST' && rest === '/issue/bulkfetch') {
      const body = await this.body(request);
      const ids = isRecord(body) && Array.isArray(body.issueIdsOrKeys) ? body.issueIdsOrKeys.map(String) : [];
      if (ids.length > 100) {
        return json(400, { errorMessages: ['Too many issues'] });
      }
      const issues = ids
        .map((id) => this.findIssue(id))
        .filter((issue): issue is FakeIssue => issue !== null && !issue.deleted);
      const found = new Set(issues.flatMap((issue) => [issue.id, issue.key]));
      return json(200, {
        issues: issues.map((issue) => this.issueWire(issue)),
        issueErrors: ids.filter((id) => !found.has(id)).map((id) => ({ issueIdsOrKeys: [id], status: 404 })),
      });
    }
    if (method === 'GET' && (match = /^\/issue\/createmeta\/([^/]+)\/issuetypes$/.exec(rest)) !== null) {
      const project = this.findProject(decodeURIComponent(match[1] ?? ''));
      return project === null
        ? json(404, { errorMessages: ['No project could be found.'] })
        : json(200, { issueTypes: project.issueTypes, maxResults: 50, startAt: 0, total: project.issueTypes.length });
    }
    if (method === 'GET' && (match = /^\/issue\/([^/]+)$/.exec(rest)) !== null) {
      const issue = this.findIssue(decodeURIComponent(match[1] ?? ''));
      return issue === null || issue.deleted
        ? json(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] })
        : json(200, this.issueWire(issue));
    }
    if (method === 'POST' && rest === '/issue') {
      return this.create(await this.body(request));
    }
    if (rest === '/webhook' || rest.startsWith('/webhook?') || rest === '/webhook/refresh') {
      return this.webhookApi(method, rest, await this.body(request));
    }
    return json(404, { errorMessages: [`Fake Jira does not implement ${method} ${rest}`] });
  }

  private search(body: unknown): Response {
    if (!isRecord(body)) {
      return json(400, { errorMessages: ['Invalid body'] });
    }
    const jql = text(body.jql) ?? '';
    const parsed = parseFakeJql(jql);
    if (parsed === null) {
      return json(400, { errorMessages: [`Unsupported JQL: ${jql}`] });
    }
    const maxResults = Math.min(100, Math.max(1, typeof body.maxResults === 'number' ? body.maxResults : 50));
    let offset = 0;
    const token = text(body.nextPageToken);
    if (token !== null) {
      const decoded = /^g([0-9]+)o([0-9]+)$/.exec(Buffer.from(token, 'base64url').toString('utf8'));
      if (decoded === null || Number(decoded[1]) !== this.pageTokenGeneration) {
        return json(400, { errorMessages: ['The provided next page token is invalid or expired.'] });
      }
      offset = Number(decoded[2]);
    }
    const all = this.matching(parsed);
    const page = all.slice(offset, offset + maxResults);
    const next =
      offset + maxResults < all.length
        ? Buffer.from(`g${String(this.pageTokenGeneration)}o${String(offset + maxResults)}`).toString('base64url')
        : null;
    return json(200, {
      issues: page.map((issue) => this.issueWire(issue)),
      ...(next === null ? {} : { nextPageToken: next }),
      isLast: next === null,
    });
  }

  private matching(jql: ParsedJql): FakeIssue[] {
    const now = this.clock();
    const words =
      jql.text
        ?.toLowerCase()
        .split(' ')
        .filter((word) => word !== '') ?? [];
    const issues = [...this.issues.values()].filter(
      (issue) =>
        !issue.deleted &&
        jql.projectIds.includes(issue.projectId) &&
        (jql.createdWithinMinutes === null || issue.created >= now - jql.createdWithinMinutes * 60_000) &&
        (jql.updatedWithinMinutes === null || issue.updated >= now - jql.updatedWithinMinutes * 60_000) &&
        (jql.issueKey === null || issue.key === jql.issueKey) &&
        words.every((word) => issue.summary.toLowerCase().includes(word)),
    );
    const byKey = (a: FakeIssue, b: FakeIssue): number => a.key.localeCompare(b.key, 'en', { numeric: true });
    switch (jql.order) {
      case 'created_asc':
        return issues.sort((a, b) => a.created - b.created || byKey(a, b));
      case 'updated_asc':
        return issues.sort((a, b) => a.updated - b.updated || byKey(a, b));
      case 'updated_desc':
        return issues.sort((a, b) => b.updated - a.updated || byKey(a, b));
    }
  }

  private create(body: unknown): Response {
    const fields = isRecord(body) && isRecord(body.fields) ? body.fields : null;
    const projectId = fields !== null && isRecord(fields.project) ? text(fields.project.id) : null;
    const typeId = fields !== null && isRecord(fields.issuetype) ? text(fields.issuetype.id) : null;
    const summary = fields === null ? null : text(fields.summary);
    const project = projectId === null ? undefined : this.projects.get(projectId);
    const type = project?.issueTypes.find((candidate) => candidate.id === typeId);
    if (
      fields === null ||
      project === undefined ||
      type === undefined ||
      summary === null ||
      summary.trim() === '' ||
      summary.length > 255
    ) {
      return json(400, {
        errorMessages: [],
        errors: {
          ...(summary === null || summary.trim() === '' ? { summary: 'You must specify a summary of the issue.' } : {}),
          ...(type === undefined ? { issuetype: 'Specify a valid issue type' } : {}),
        },
      });
    }
    const issue = this.addIssue({
      projectId: project.id,
      summary,
      issueTypeName: type.name,
      description: fields.description ?? null,
    });
    this.createdIssues.push({ id: issue.id, key: issue.key, fields });
    return json(201, { id: issue.id, key: issue.key, self: `https://fake/rest/api/3/issue/${issue.id}` });
  }

  private webhookApi(method: string, rest: string, body: unknown): Response {
    const now = this.clock();
    if (method === 'POST' && rest === '/webhook') {
      if (!isRecord(body) || text(body.url) === null || !Array.isArray(body.webhooks)) {
        return json(400, { errorMessages: ['Invalid webhook registration'] });
      }
      const url = text(body.url) ?? '';
      const result = body.webhooks.map((entry: unknown) => {
        const jqlFilter = isRecord(entry) ? (text(entry.jqlFilter) ?? '') : '';
        const events = isRecord(entry) && Array.isArray(entry.events) ? entry.events.map(String) : [];
        if (this.refuseWebhookRegistrations > 0) {
          this.refuseWebhookRegistrations -= 1;
          return { errors: ['Only 5 webhooks can be registered per app on this site.'] };
        }
        if (parseFakeJql(jqlFilter) === null || events.length === 0) {
          return { errors: ['The JQL filter is not supported.'] };
        }
        if (this.webhooks.size >= MAX_WEBHOOKS) {
          return { errors: ['Only 5 webhooks can be registered per app on this site.'] };
        }
        const id = this.nextWebhookId++;
        this.webhooks.set(id, { id, url, jqlFilter, events, expiresAt: now + WEBHOOK_TTL_MS });
        return { createdWebhookId: id };
      });
      return json(200, { webhookRegistrationResult: result });
    }
    const ids = isRecord(body) && Array.isArray(body.webhookIds) ? body.webhookIds.map(Number) : [];
    if (method === 'PUT' && rest === '/webhook/refresh') {
      const expirationDate = now + WEBHOOK_TTL_MS;
      for (const id of ids) {
        const webhook = this.webhooks.get(id);
        if (webhook !== undefined) {
          webhook.expiresAt = expirationDate;
        }
      }
      return json(200, { expirationDate });
    }
    if (method === 'DELETE' && rest === '/webhook') {
      for (const id of ids) {
        this.webhooks.delete(id);
      }
      return new Response(null, { status: 202 });
    }
    if (method === 'GET') {
      const values = [...this.webhooks.values()].map((webhook) => ({
        id: webhook.id,
        jqlFilter: webhook.jqlFilter,
        events: webhook.events,
        expirationDate: webhook.expiresAt,
      }));
      return json(200, { values, isLast: true, maxResults: 100, startAt: 0, total: values.length });
    }
    return json(405, { errorMessages: ['Method not allowed'] });
  }

  private async control(request: Request, path: string): Promise<Response> {
    const body = await this.body(request);
    const record = isRecord(body) ? body : {};
    if (request.method === 'GET' && path === '/state') {
      return json(200, {
        webhooks: [...this.webhooks.values()],
        createdIssues: this.createdIssues.map((issue) => ({ id: issue.id, key: issue.key, fields: issue.fields })),
        requests: this.requests,
        issues: [...this.issues.values()].map((issue) => ({
          id: issue.id,
          key: issue.key,
          summary: issue.summary,
          statusName: issue.statusName,
          deleted: issue.deleted,
        })),
      });
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'method' });
    }
    switch (path) {
      case '/reset':
        this.reset();
        return json(200, { ok: true });
      case '/revoke':
        this.revokeGrants();
        return json(200, { ok: true });
      case '/authorize-mode':
        this.authorizeMode = record.mode === 'deny' ? 'deny' : 'approve';
        return json(200, { ok: true });
      case '/fail': {
        const kind = text(record.kind);
        const kinds: readonly FakeFailureKind[] = [
          'rate_limit',
          'server_error',
          'unavailable',
          'malformed',
          'hang',
          'unauthorized',
          'bad_request',
        ];
        const failureKind = kinds.find((candidate) => candidate === kind);
        if (failureKind === undefined || text(record.match) === null) {
          return json(400, { error: 'kind and match are required' });
        }
        this.fail({
          match: text(record.match) ?? '',
          kind: failureKind,
          times: typeof record.times === 'number' ? record.times : 1,
          ...(typeof record.retryAfterSeconds === 'number' ? { retryAfterSeconds: record.retryAfterSeconds } : {}),
        });
        return json(200, { ok: true });
      }
      case '/issues': {
        const projectId = text(record.projectId);
        const summary = text(record.summary);
        if (projectId === null || summary === null || !this.projects.has(projectId)) {
          return json(400, { error: 'projectId and summary are required' });
        }
        const issue = this.addIssue({
          projectId,
          summary,
          ...(text(record.statusName) === null ? {} : { statusName: text(record.statusName) ?? '' }),
          ...(record.statusCategory === 'done' || record.statusCategory === 'indeterminate'
            ? { statusCategory: record.statusCategory }
            : {}),
        });
        return json(200, { id: issue.id, key: issue.key });
      }
      case '/issues/update': {
        const id = text(record.issue);
        if (id === null || this.findIssue(id) === null) {
          return json(404, { error: 'issue' });
        }
        const category = record.statusCategory;
        const issue = this.updateIssue(id, {
          ...(text(record.summary) === null ? {} : { summary: text(record.summary) ?? '' }),
          ...(text(record.statusName) === null ? {} : { statusName: text(record.statusName) ?? '' }),
          ...(category === 'new' || category === 'indeterminate' || category === 'done'
            ? { statusCategory: category }
            : {}),
        });
        return json(200, { id: issue.id, key: issue.key });
      }
      case '/issues/delete': {
        this.deleteIssue(text(record.issue) ?? '');
        return json(200, { ok: true });
      }
      case '/webhooks/emit': {
        const id = text(record.issue);
        const event =
          record.event === 'jira:issue_created' || record.event === 'jira:issue_deleted'
            ? record.event
            : 'jira:issue_updated';
        if (id === null || this.findIssue(id) === null) {
          return json(404, { error: 'issue' });
        }
        const identifier = text(record.identifier);
        return json(200, { deliveries: await this.emitWebhook(id, event, identifier === null ? {} : { identifier }) });
      }
      default:
        return json(404, { error: 'unknown control route' });
    }
  }

  private async body(request: Request): Promise<unknown> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return null;
    }
    const raw = await request.text();
    if (raw === '') {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed;
    } catch {
      return null;
    }
  }

  private findIssue(idOrKey: string): FakeIssue | null {
    return this.issues.get(idOrKey) ?? [...this.issues.values()].find((issue) => issue.key === idOrKey) ?? null;
  }

  private findProject(idOrKey: string): FakeProject | null {
    return this.projects.get(idOrKey) ?? [...this.projects.values()].find((project) => project.key === idOrKey) ?? null;
  }

  private projectWire(project: FakeProject): Record<string, unknown> {
    return {
      id: project.id,
      key: project.key,
      name: project.name,
      self: `https://fake/rest/api/3/project/${project.id}`,
    };
  }

  private issueWire(issue: FakeIssue): Record<string, unknown> {
    return {
      id: issue.id,
      key: issue.key,
      self: `https://fake/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        issuetype: { name: issue.issueTypeName, subtask: false },
        status: { name: issue.statusName, statusCategory: { key: issue.statusCategory } },
        priority: issue.priorityName === null ? null : { name: issue.priorityName },
        assignee:
          issue.assigneeName === null
            ? null
            : { accountId: `acct-${issue.assigneeName}`, displayName: issue.assigneeName },
        reporter: { displayName: 'Fake Reporter' },
        created: jiraTime(issue.created),
        updated: jiraTime(issue.updated),
        duedate: issue.dueDate,
        resolution: issue.statusCategory === 'done' ? { name: 'Done' } : null,
        resolutiondate: issue.statusCategory === 'done' ? jiraTime(issue.updated) : null,
        labels: issue.labels,
        parent: null,
        project: { id: issue.projectId, key: this.projects.get(issue.projectId)?.key ?? '' },
      },
    };
  }
}

async function toRequest(message: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const method = message.method ?? 'GET';
  return new Request(new URL(message.url ?? '/', origin), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function respond(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;
  response.headers.forEach((value, name) => {
    out.setHeader(name, value);
  });
  out.end(Buffer.from(await response.arrayBuffer()));
}

export interface FakeJiraServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Serves a fake over HTTP on 127.0.0.1 (port 0 = any free port). */
export async function startFakeJiraServer(fake: FakeJira, port = 0): Promise<FakeJiraServer> {
  let origin = '';
  const server: Server = createServer((message, out) => {
    toRequest(message, origin)
      .then((request) => fake.handle(request))
      .then((response) => respond(response, out))
      .catch(() => {
        out.statusCode = 500;
        out.end();
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake Jira server has no TCP address.');
  }
  origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
