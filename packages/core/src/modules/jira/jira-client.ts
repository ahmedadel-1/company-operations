import type { z } from 'zod';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { JiraCoordination } from './jira-coordination.js';
import { JiraApiError } from './jira-errors.js';
import type { JiraHttp, JiraRequest } from './jira-http.js';
import type { JiraAppSettings } from './jira-oauth.js';
import { markNeedsReauth } from './jira-tokens.js';
import type { JiraTokenService } from './jira-tokens.js';
import {
  approximateCountSchema,
  bulkFetchSchema,
  createdIssueSchema,
  createMetaIssueTypesSchema,
  ISSUE_FIELDS,
  issueSchema,
  projectSchema,
  projectSearchSchema,
  searchJqlSchema,
  webhookListSchema,
  webhookRefreshSchema,
  webhookRegisterSchema,
} from './jira-wire.js';
import type { JiraIssueTypeWire, JiraIssueWire, JiraProjectWire } from './jira-wire.js';

/** Default pause when Jira rate limits without saying for how long. */
const DEFAULT_PAUSE_MS = 60_000;

export interface JiraConnectionRef {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly cloudId: string;
  /** Only for removing a disconnected connection's webhooks before its tokens are wiped. */
  readonly allowDisconnected?: boolean;
}

export interface SearchPage {
  readonly issues: JiraIssueWire[];
  readonly nextPageToken: string | null;
  readonly isLast: boolean;
}

export interface WebhookRegistrationResult {
  readonly webhookId: string | null;
  readonly errors: readonly string[];
}

/**
 * Jira Cloud REST v3 for one connection, through `https://api.atlassian.com/ex/jira/{cloudId}`.
 * Endpoints are the current documented ones (checked 2026-10-03): `search/jql` with
 * `nextPageToken` (the old `/search` is being removed), `search/approximate-count`,
 * `issue/bulkfetch`, `issue/createmeta/{project}/issuetypes`, dynamic `webhook` registration.
 *
 * Before each call the connection-wide pause is honoured, so one rate-limited request slows every
 * process using the connection. A 401 triggers one forced token refresh; a second 401 means the
 * grant no longer works and the connection moves to NEEDS_REAUTH.
 */
export class JiraClient {
  private readonly base: string;

  constructor(
    private readonly ref: JiraConnectionRef,
    settings: Pick<JiraAppSettings, 'apiBaseUrl'>,
    private readonly http: JiraHttp,
    private readonly tokens: JiraTokenService,
    private readonly coordination: JiraCoordination,
    private readonly db: TenantDb,
    private readonly now: () => number = Date.now,
  ) {
    this.base = `${settings.apiBaseUrl}/ex/jira/${encodeURIComponent(ref.cloudId)}/rest/api/3`;
  }

  getProject(projectIdOrKey: string): Promise<JiraProjectWire> {
    return this.call({
      method: 'GET',
      path: `/project/${encodeURIComponent(projectIdOrKey)}`,
      schema: projectSchema,
      idempotent: true,
    });
  }

  async searchProjects(query: string, startAt = 0): Promise<{ values: JiraProjectWire[]; isLast: boolean }> {
    const params = new URLSearchParams({ maxResults: '50', startAt: String(startAt), orderBy: 'key' });
    if (query.trim() !== '') {
      params.set('query', query.trim().slice(0, 100));
    }
    const page = await this.call({
      method: 'GET',
      path: `/project/search?${params.toString()}`,
      schema: projectSearchSchema,
      idempotent: true,
    });
    return { values: page.values, isLast: page.isLast ?? true };
  }

  async searchJql(jql: string, options: { maxResults: number; nextPageToken?: string | null }): Promise<SearchPage> {
    const page = await this.call({
      method: 'POST',
      path: '/search/jql',
      body: {
        jql,
        fields: ISSUE_FIELDS,
        maxResults: options.maxResults,
        ...(options.nextPageToken === undefined || options.nextPageToken === null
          ? {}
          : { nextPageToken: options.nextPageToken }),
      },
      schema: searchJqlSchema,
      idempotent: true,
    });
    const next = page.nextPageToken ?? null;
    return { issues: page.issues, nextPageToken: next, isLast: page.isLast ?? next === null };
  }

  async approximateCount(jql: string): Promise<number> {
    const result = await this.call({
      method: 'POST',
      path: '/search/approximate-count',
      body: { jql },
      schema: approximateCountSchema,
      idempotent: true,
    });
    return result.count;
  }

  getIssue(issueIdOrKey: string): Promise<JiraIssueWire> {
    const params = new URLSearchParams({ fields: ISSUE_FIELDS.join(',') });
    return this.call({
      method: 'GET',
      path: `/issue/${encodeURIComponent(issueIdOrKey)}?${params.toString()}`,
      schema: issueSchema,
      idempotent: true,
    });
  }

  /** Up to 100 issues by id; ids Jira does not return are deleted or no longer visible. */
  async bulkFetch(issueIds: readonly string[]): Promise<JiraIssueWire[]> {
    if (issueIds.length === 0) {
      return [];
    }
    const result = await this.call({
      method: 'POST',
      path: '/issue/bulkfetch',
      body: { issueIdsOrKeys: issueIds.slice(0, 100), fields: ISSUE_FIELDS },
      schema: bulkFetchSchema,
      idempotent: true,
    });
    return result.issues;
  }

  /** Issue types that can be created in the project (sub-tasks excluded: they need a parent). */
  async creatableIssueTypes(projectId: string): Promise<JiraIssueTypeWire[]> {
    const types = await this.call({
      method: 'GET',
      path: `/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes?maxResults=50`,
      schema: createMetaIssueTypesSchema,
      idempotent: true,
    });
    return types.filter((type) => type.subtask !== true);
  }

  /** Not retried automatically: Jira has no idempotency key (the caller keeps a reservation). */
  createIssue(fields: Readonly<Record<string, unknown>>): Promise<{ id: string; key: string }> {
    return this.call({
      method: 'POST',
      path: '/issue',
      body: { fields },
      schema: createdIssueSchema,
      idempotent: false,
    });
  }

  async registerWebhook(url: string, jqlFilter: string, events: readonly string[]): Promise<WebhookRegistrationResult> {
    const result = await this.call({
      method: 'POST',
      path: '/webhook',
      body: { url, webhooks: [{ events, jqlFilter }] },
      schema: webhookRegisterSchema,
      idempotent: false,
    });
    const first = result.webhookRegistrationResult[0];
    return { webhookId: first?.createdWebhookId ?? null, errors: first?.errors ?? [] };
  }

  async refreshWebhooks(webhookIds: readonly string[]): Promise<Date> {
    const result = await this.call({
      method: 'PUT',
      path: '/webhook/refresh',
      body: { webhookIds: webhookIds.map(Number) },
      schema: webhookRefreshSchema,
      idempotent: true,
    });
    return result.expirationDate;
  }

  async deleteWebhooks(webhookIds: readonly string[]): Promise<void> {
    if (webhookIds.length === 0) {
      return;
    }
    await this.send({
      method: 'DELETE',
      path: '/webhook',
      body: { webhookIds: webhookIds.map(Number) },
      idempotent: true,
    });
  }

  /** Webhooks this app registered on the site (first 100). */
  async listWebhooks(): Promise<string[]> {
    const result = await this.call({
      method: 'GET',
      path: '/webhook?startAt=0&maxResults=100',
      schema: webhookListSchema,
      idempotent: true,
    });
    return result.values.map((value) => value.id);
  }

  private call<T>(request: {
    method: JiraRequest<T>['method'];
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    idempotent: boolean;
  }): Promise<T> {
    return this.authorized((token) =>
      this.http.request({
        method: request.method,
        url: `${this.base}${request.path}`,
        headers: { authorization: `Bearer ${token}` },
        ...(request.body === undefined ? {} : { body: request.body }),
        schema: request.schema,
        idempotent: request.idempotent,
      }),
    );
  }

  private send(request: {
    method: JiraRequest<unknown>['method'];
    path: string;
    body?: unknown;
    idempotent: boolean;
  }): Promise<void> {
    return this.authorized((token) =>
      this.http.send({
        method: request.method,
        url: `${this.base}${request.path}`,
        headers: { authorization: `Bearer ${token}` },
        ...(request.body === undefined ? {} : { body: request.body }),
        idempotent: request.idempotent,
      }),
    );
  }

  private async authorized<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { organizationId, connectionId } = this.ref;
    const allowDisconnected = this.ref.allowDisconnected === true;
    const pausedUntil = await this.coordination.pausedUntil(connectionId);
    if (pausedUntil !== null) {
      throw new JiraApiError('rate_limited', null, 'Jira calls for this connection are paused.', {
        retryAfterMs: pausedUntil - this.now(),
      });
    }
    try {
      try {
        return await fn(await this.tokens.accessToken(organizationId, connectionId, false, allowDisconnected));
      } catch (error) {
        if (!(error instanceof JiraApiError) || error.kind !== 'unauthorized') {
          throw error;
        }
        try {
          return await fn(await this.tokens.accessToken(organizationId, connectionId, true, allowDisconnected));
        } catch (retryError) {
          if (retryError instanceof JiraApiError && retryError.kind === 'unauthorized') {
            throw new JiraApiError('reauth_required', retryError.status, 'Jira keeps rejecting the access token.');
          }
          throw retryError;
        }
      }
    } catch (error) {
      if (error instanceof JiraApiError && error.kind === 'rate_limited') {
        await this.coordination.pause(connectionId, this.now() + (error.retryAfterMs ?? DEFAULT_PAUSE_MS));
      }
      if (error instanceof JiraApiError && error.kind === 'reauth_required' && !allowDisconnected) {
        await markNeedsReauth(this.db, organizationId, connectionId, error.code);
      }
      throw error;
    }
  }
}

/** Builds clients for connections; one per process. */
export class JiraClientFactory {
  constructor(
    private readonly settings: Pick<JiraAppSettings, 'apiBaseUrl'>,
    private readonly http: JiraHttp,
    private readonly tokens: JiraTokenService,
    private readonly coordination: JiraCoordination,
    private readonly db: TenantDb,
  ) {}

  forConnection(ref: JiraConnectionRef): JiraClient {
    return new JiraClient(ref, this.settings, this.http, this.tokens, this.coordination, this.db);
  }
}
