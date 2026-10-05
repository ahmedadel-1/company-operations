import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signWebhookJwt } from '@company-ops/core';
import { FakeJira, startFakeJiraServer } from '@company-ops/core/testing';
import type { FakeJiraServer } from '@company-ops/core/testing';
import {
  errorEnvelopeSchema,
  jiraConnectResponseSchema,
  jiraConnectionResponseSchema,
  jiraDeliveryFailureListResponseSchema,
  jiraIntegrationStatusResponseSchema,
  jiraIssueTypeListResponseSchema,
  jiraMappingListResponseSchema,
  jiraMappingResponseSchema,
  jiraProjectOverviewResponseSchema,
  jiraProjectSearchResponseSchema,
  jiraRunDetailResponseSchema,
  jiraRunPageResponseSchema,
  jiraRunResponseSchema,
  jiraWebhookAckResponseSchema,
  ticketJiraLinkResponseSchema,
  ticketJiraPanelResponseSchema,
  ticketJiraSearchResponseSchema,
  ticketResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 4 (Jira) endpoints over real HTTP against the fake Atlassian server: OAuth redirects,
 * mappings and runs, the JWT-authenticated webhook receiver, the ticket Development panel and the
 * project Jira tab. Success bodies are validated against the shared contracts; errors use the
 * standard envelope and never carry tokens.
 */
const CLIENT_ID = 'api-test-jira-client';
const CLIENT_SECRET = 'api-test-jira-client-secret-0123456789';

const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  support: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f09',
  technicalManager: 'seed-demo-emp-00006',
  tier: 'seed-demo-emp-00019',
  fieldTmp: 'seed-demo-emp-00024',
} as const;

let stack: ApiStack;
let fake: FakeJira;
let fakeServer: FakeJiraServer;
let orgA: string;
let tm: TestSession;
let admin: TestSession;
let gm: TestSession;
let employee: TestSession;
let support: TestSession;
let tier: TestSession;
let fieldTmp: TestSession;
let connectionId: string;
let mappingId: string;
let ticketId: string;

function call(
  path: string,
  session: TestSession | null,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirect?: 'follow' | 'manual' | 'error';
  } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (session !== null) {
    headers.set('cookie', session.cookie);
    if (method !== 'GET') {
      headers.set('origin', PUBLIC_URL);
      headers.set('x-csrf-token', session.csrfToken);
    }
  }
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${stack.baseUrl}/api/v1${path}`, {
    method,
    headers,
    redirect: init.redirect ?? 'follow',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function ok<T>(response: Response, schema: { parse(value: unknown): T }, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  expect(text).not.toMatch(/fake-(access|refresh)|refresh_token|access_token/i);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack|fake-(access|refresh)/i);
  return envelope.error.code;
}

/** Follows the consent flow the way a browser would: authorize at the fake, then hit our callback. */
async function consent(session: TestSession, body: Record<string, string> = {}): Promise<URL> {
  const { data } = await ok(
    await call('/integrations/jira/connect', session, { method: 'POST', body }),
    jiraConnectResponseSchema,
  );
  const authorize = await fetch(data.authorizeUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location') ?? '');
  expect(back.origin).toBe(PUBLIC_URL);
  const callback = await call(`/integrations/jira/callback${back.search}`, session, { redirect: 'manual' });
  expect(callback.status).toBe(302);
  expect(callback.headers.get('cache-control')).toContain('no-store');
  return new URL(callback.headers.get('location') ?? '');
}

function webhook(
  body: unknown,
  options: { secret?: string; identifier?: string; target?: string; token?: string | null } = {},
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token =
    options.token === undefined
      ? signWebhookJwt({ iss: CLIENT_ID, iat: now, exp: now + 180, sub: 'fake-jira' }, options.secret ?? CLIENT_SECRET)
      : options.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (options.identifier !== undefined) {
    headers['x-atlassian-webhook-identifier'] = options.identifier;
  }
  return fetch(`${stack.baseUrl}/api/v1/webhooks/jira/${options.target ?? connectionId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const issueEvent = (issueId: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  timestamp: Date.now(),
  webhookEvent: 'jira:issue_updated',
  issue: { id: issueId, key: 'OPS-1', fields: { project: { id: projectId } } },
  ...extra,
});

async function projectId(code: string): Promise<string> {
  return (await stack.prisma.project.findFirstOrThrow({ where: { organizationId: orgA, code }, select: { id: true } }))
    .id;
}

beforeAll(async () => {
  fake = new FakeJira({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  fakeServer = await startFakeJiraServer(fake);
  stack = await startApiStack({
    issuer: 'http://127.0.0.1:9/realms/company-ops',
    overrides: {
      JIRA_OAUTH_CLIENT_ID: CLIENT_ID,
      JIRA_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      JIRA_AUTH_BASE_URL: fakeServer.url,
      JIRA_API_BASE_URL: fakeServer.url,
    },
  });
  orgA = await seed(stack);
  tm = await createSession(stack, SUBJECT.technicalManager, orgA, { mfa: true });
  admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
  gm = await createSession(stack, SUBJECT.gm, orgA);
  employee = await createSession(stack, SUBJECT.employee, orgA);
  support = await createSession(stack, SUBJECT.support, orgA);
  tier = await createSession(stack, SUBJECT.tier, orgA);
  fieldTmp = await createSession(stack, SUBJECT.fieldTmp, orgA);
}, 300_000);

afterAll(async () => {
  await stack.stop();
  await fakeServer.close();
});

describe('connection (OAuth 2.0 3LO)', () => {
  it('reports configuration without secrets and refuses members without integration.manage', async () => {
    const { data } = await ok(await call('/integrations/jira', tm), jiraIntegrationStatusResponseSchema);
    expect(data.configured).toBe(true);
    expect(data.connection).toBeNull();
    expect(data.redirectUri).toBe(`${PUBLIC_URL}/api/v1/integrations/jira/callback`);
    expect(await failure(await call('/integrations/jira', employee), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/integrations/jira', gm), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/integrations/jira', null), 401)).toBe('UNAUTHENTICATED');
  });

  it('integration.manage is privileged: without a fresh MFA the admin routes ask for step-up', async () => {
    const withoutMfa = await createSession(stack, SUBJECT.technicalManager, orgA);
    expect(await failure(await call('/integrations/jira', withoutMfa), 401)).toBe('MFA_REQUIRED');
    expect(await failure(await call('/integrations/jira/connect', withoutMfa, { method: 'POST', body: {} }), 401)).toBe(
      'MFA_REQUIRED',
    );
    expect(await failure(await call('/integrations/jira/mappings', withoutMfa), 401)).toBe('MFA_REQUIRED');
  });

  it('redirects consent refusals and malformed callbacks back to the admin page', async () => {
    fake.authorizeMode = 'deny';
    const denied = await consent(tm);
    expect(denied.pathname).toBe('/admin/integrations/jira');
    expect(Object.fromEntries(denied.searchParams)).toEqual({ jira: 'error', reason: 'consent_denied' });
    fake.authorizeMode = 'approve';

    const missing = await call('/integrations/jira/callback?code=abc', tm, { redirect: 'manual' });
    expect(missing.status).toBe(302);
    expect(new URL(missing.headers.get('location') ?? '').searchParams.get('reason')).toBe('invalid_callback');

    const forged = await call('/integrations/jira/callback?code=abc&state=forged-state', tm, { redirect: 'manual' });
    expect(forged.status).toBe(302);
    const reason = new URL(forged.headers.get('location') ?? '').searchParams.get('reason') ?? '';
    expect(reason).toBe('forbidden');
  });

  it('a state minted for one administrator cannot be completed by another', async () => {
    const { data } = await ok(
      await call('/integrations/jira/connect', tm, { method: 'POST', body: {} }),
      jiraConnectResponseSchema,
    );
    const back = new URL((await fetch(data.authorizeUrl, { redirect: 'manual' })).headers.get('location') ?? '');
    const stolen = await call(`/integrations/jira/callback${back.search}`, admin, { redirect: 'manual' });
    expect(new URL(stolen.headers.get('location') ?? '').searchParams.get('jira')).toBe('error');
    expect(await stack.prisma.jiraConnection.count({ where: { organizationId: orgA } })).toBe(0);
  });

  it('connects a single-site grant directly and never exposes tokens', async () => {
    const landed = await consent(tm);
    expect(Object.fromEntries(landed.searchParams)).toEqual({ jira: 'connected' });
    const { data } = await ok(await call('/integrations/jira', tm), jiraIntegrationStatusResponseSchema);
    expect(data.connection?.status).toBe('ACTIVE');
    expect(data.connection?.siteName).toBe('Fake Jira');
    connectionId = data.connection?.id ?? '';
    const row = await stack.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(row.refreshTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toMatch(/fake-access|fake-refresh/);
  });
});

describe('mappings and runs', () => {
  it('searches Jira projects and maps one to a project (initial import queued)', async () => {
    const projects = await ok(await call('/integrations/jira/projects?q=OPS', tm), jiraProjectSearchResponseSchema);
    expect(projects.data.map((project) => project.key)).toContain('OPS');

    const ihd = await projectId('IHD');
    expect(
      await failure(
        await call('/integrations/jira/mappings', support, {
          method: 'POST',
          body: { projectId: ihd, jiraProjectId: '20001' },
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
    const created = await ok(
      await call('/integrations/jira/mappings', tm, {
        method: 'POST',
        body: { projectId: ihd, jiraProjectId: '20001' },
      }),
      jiraMappingResponseSchema,
      201,
    );
    mappingId = created.data.id;
    expect(created.data.jiraProject.key).toBe('OPS');
    expect(created.data.importState).toBe('NOT_STARTED');
    expect(
      await failure(
        await call('/integrations/jira/mappings', tm, {
          method: 'POST',
          body: { projectId: ihd, jiraProjectId: '20001' },
        }),
        409,
      ),
    ).toBe('CONFLICT');
    expect(
      await failure(
        await call('/integrations/jira/mappings', tm, {
          method: 'POST',
          body: { projectId: ihd, jiraProjectId: 'OPS' },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');

    const list = await ok(await call('/integrations/jira/mappings', tm), jiraMappingListResponseSchema);
    expect(list.data.map((mapping) => mapping.id)).toEqual([mappingId]);
  });

  it('updates a mapping with optimistic concurrency', async () => {
    const before = (await ok(await call('/integrations/jira/mappings', tm), jiraMappingListResponseSchema)).data[0];
    const updated = await ok(
      await call(`/integrations/jira/mappings/${mappingId}`, tm, {
        method: 'PATCH',
        body: { version: before?.version ?? 0, blockedStatuses: ['Blocked', 'On Hold'] },
      }),
      jiraMappingResponseSchema,
    );
    expect(updated.data.blockedStatuses).toEqual(['Blocked', 'On Hold']);
    expect(
      await failure(
        await call(`/integrations/jira/mappings/${mappingId}`, tm, {
          method: 'PATCH',
          body: { version: before?.version ?? 0, syncEnabled: false },
        }),
        409,
      ),
    ).toBe('VERSION_CONFLICT');
  });

  it('lists, shows, cancels and retries runs; one active run per mapping', async () => {
    const page = await ok(await call('/integrations/jira/sync-runs', tm), jiraRunPageResponseSchema);
    const initial = page.data.find((run) => run.mappingId === mappingId);
    expect(initial?.type).toBe('INITIAL_IMPORT');
    expect(initial?.status).toBe('QUEUED');
    expect(
      await failure(
        await call(`/integrations/jira/mappings/${mappingId}/runs`, tm, {
          method: 'POST',
          body: { type: 'RECONCILIATION' },
        }),
        409,
      ),
    ).toBe('INVALID_TRANSITION');

    const runId = initial?.id ?? '';
    const detail = await ok(await call(`/integrations/jira/sync-runs/${runId}`, tm), jiraRunDetailResponseSchema);
    expect(detail.data.failures).toEqual([]);
    const cancelled = await ok(
      await call(`/integrations/jira/sync-runs/${runId}/cancel`, tm, { method: 'POST' }),
      jiraRunResponseSchema,
    );
    expect(cancelled.data.status).toBe('CANCELLED');
    const retried = await ok(
      await call(`/integrations/jira/sync-runs/${runId}/retry`, tm, { method: 'POST' }),
      jiraRunResponseSchema,
      201,
    );
    expect(retried.data.status).toBe('QUEUED');
    expect(await failure(await call(`/integrations/jira/sync-runs/${randomUUID()}`, tm), 404)).toBe('NOT_FOUND');
    expect(await failure(await call('/integrations/jira/sync-runs', support), 403)).toBe('FORBIDDEN');

    await ok(await call('/integrations/jira/webhook-deliveries/failures', tm), jiraDeliveryFailureListResponseSchema);
  });
});

describe('webhook receiver', () => {
  it('rejects missing, forged and foreign-secret tokens with 401 and no session or CSRF needed', async () => {
    const event = issueEvent('10000', '20001');
    expect(await failure(await webhook(event, { token: null }), 401)).toBe('UNAUTHENTICATED');
    expect(await failure(await webhook(event, { token: 'not-a-jwt' }), 401)).toBe('UNAUTHENTICATED');
    expect(await failure(await webhook(event, { secret: 'some-other-secret-0123456789abcdef' }), 401)).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('answers 404 for unknown connections and 400 for malformed payloads', async () => {
    expect(await failure(await webhook(issueEvent('10000', '20001'), { target: randomUUID() }), 404)).toBe('NOT_FOUND');
    expect(await failure(await webhook(issueEvent('10000', '20001'), { target: 'not-a-uuid' }), 400)).toBe(
      'VALIDATION_FAILED',
    );
    expect(await failure(await webhook({ webhookEvent: 42 }), 400)).toBe('VALIDATION_FAILED');
  });

  it('answers 403 when the delivery names webhooks this connection never registered', async () => {
    expect(await failure(await webhook(issueEvent('10000', '20001', { matchedWebhookIds: [987654] })), 403)).toBe(
      'FORBIDDEN',
    );
  });

  it('queues relevant deliveries (202), acknowledges duplicates and irrelevant events (200)', async () => {
    const identifier = `delivery-${randomUUID()}`;
    const queued = await ok(
      await webhook(issueEvent('10000', '20001'), { identifier }),
      jiraWebhookAckResponseSchema,
      202,
    );
    expect(queued.data.outcome).toBe('queued');
    const duplicate = await ok(
      await webhook(issueEvent('10000', '20001'), { identifier }),
      jiraWebhookAckResponseSchema,
    );
    expect(duplicate.data.outcome).toBe('duplicate');
    const unmapped = await ok(await webhook(issueEvent('10004', '20002')), jiraWebhookAckResponseSchema);
    expect(unmapped.data.outcome).toBe('ignored');
    const otherEvent = await ok(
      await webhook({ webhookEvent: 'comment_created', timestamp: Date.now() }),
      jiraWebhookAckResponseSchema,
    );
    expect(otherEvent.data.outcome).toBe('ignored');
    const stored = await stack.prisma.jiraWebhookDelivery.findMany({
      where: { connectionId, deliveryKey: identifier },
    });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.payload)).not.toMatch(/summary|description/);
  });
});

describe('ticket Development panel', () => {
  it('shows the panel to permitted members and hides it from the reporter without Jira rights', async () => {
    const created = await ok(
      await call('/support/tickets', tier, {
        method: 'POST',
        body: {
          title: 'Sign-in broken for customer',
          description: 'Customer cannot sign in.',
          severity: 'HIGH',
          impact: 'SINGLE_USER',
          projectId: await projectId('IHD'),
        },
      }),
      ticketResponseSchema,
      201,
    );
    ticketId = created.data.id;
    const panel = await ok(await call(`/support/tickets/${ticketId}/jira`, support), ticketJiraPanelResponseSchema);
    expect(panel.data).toMatchObject({
      visible: true,
      available: true,
      canLink: true,
      canCreate: true,
      connectionStatus: 'ACTIVE',
    });
    expect(panel.data.mappings.map((mapping) => mapping.jiraProjectKey)).toEqual(['OPS']);
    const own = await ok(
      await call('/support/tickets', fieldTmp, {
        method: 'POST',
        body: {
          title: 'Field tablet app crashes',
          description: 'Crashes on start.',
          severity: 'MEDIUM',
          impact: 'SINGLE_USER',
          projectId: await projectId('TMP'),
        },
      }),
      ticketResponseSchema,
      201,
    );
    const reporter = await ok(
      await call(`/support/tickets/${own.data.id}/jira`, fieldTmp),
      ticketJiraPanelResponseSchema,
    );
    expect(reporter.data).toMatchObject({ visible: false, canLink: false, canCreate: false, links: [], mappings: [] });
    expect(await failure(await call(`/support/tickets/${own.data.id}/jira/search`, fieldTmp), 403)).toBe('FORBIDDEN');
  });

  it('searches Jira live, links and unlinks an issue', async () => {
    const live = await ok(
      await call(`/support/tickets/${ticketId}/jira/search?source=jira&q=Safari`, support),
      ticketJiraSearchResponseSchema,
    );
    const issue = live.data.find((row) => row.summary === 'Login fails on Safari');
    expect(issue?.url).toBe('https://fake-jira.example.test/browse/OPS-1');
    expect(issue?.linked).toBe(false);
    const cached = await ok(
      await call(`/support/tickets/${ticketId}/jira/search?q=OPS-1`, support),
      ticketJiraSearchResponseSchema,
    );
    expect(cached.data.map((row) => row.key)).toContain('OPS-1');

    const link = await ok(
      await call(`/support/tickets/${ticketId}/jira/links`, support, {
        method: 'POST',
        body: { issueId: issue?.id, linkType: 'CAUSED_BY' },
      }),
      ticketJiraLinkResponseSchema,
      201,
    );
    expect(link.data.issue.key).toBe('OPS-1');
    expect(
      await failure(
        await call(`/support/tickets/${ticketId}/jira/links`, support, {
          method: 'POST',
          body: { issueId: issue?.id },
        }),
        409,
      ),
    ).toMatch(/CONFLICT|JIRA_/);
    const del = await call(`/support/tickets/${ticketId}/jira/links/${link.data.id}`, support, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(
      await failure(
        await call(`/support/tickets/${ticketId}/jira/links/${link.data.id}`, support, { method: 'DELETE' }),
        404,
      ),
    ).toBe('NOT_FOUND');
  });

  it('creates an issue idempotently (Idempotency-Key required) without touching the ticket status', async () => {
    const types = await ok(
      await call(`/support/tickets/${ticketId}/jira/issue-types?mappingId=${mappingId}`, support),
      jiraIssueTypeListResponseSchema,
    );
    expect(types.data.map((type) => type.name)).toEqual(['Bug', 'Task']);
    const before = await stack.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true, version: true },
    });
    const body = {
      mappingId,
      issueTypeId: '10001',
      summary: 'Sign-in broken for customer',
      description: 'Customer cannot sign in.',
    };

    expect(
      await failure(await call(`/support/tickets/${ticketId}/jira/issues`, support, { method: 'POST', body }), 400),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await call(`/support/tickets/${ticketId}/jira/issues`, support, {
          method: 'POST',
          body,
          headers: { 'idempotency-key': 'nope' },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');

    const key = randomUUID();
    const first = await ok(
      await call(`/support/tickets/${ticketId}/jira/issues`, support, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': key },
      }),
      ticketJiraLinkResponseSchema,
      201,
    );
    const replay = await ok(
      await call(`/support/tickets/${ticketId}/jira/issues`, support, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': key },
      }),
      ticketJiraLinkResponseSchema,
      201,
    );
    expect(replay.data.id).toBe(first.data.id);
    expect(fake.createdIssues).toHaveLength(1);
    expect(first.data.createdVia).toBe('CREATED_FROM_TICKET');
    expect(
      await failure(
        await call(`/support/tickets/${ticketId}/jira/issues`, support, {
          method: 'POST',
          body: { ...body, summary: 'Different' },
          headers: { 'idempotency-key': key },
        }),
        409,
      ),
    ).toMatch(/CONFLICT|IDEMPOTENCY/);
    expect(
      await failure(
        await call(`/support/tickets/${ticketId}/jira/issues`, support, {
          method: 'POST',
          body: { ...body, issueTypeId: '10003' },
          headers: { 'idempotency-key': randomUUID() },
        }),
        400,
      ),
    ).toMatch(/VALIDATION|JIRA_/);
    const after = await stack.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true },
    });
    expect(after.status).toBe(before.status);
    expect(
      await failure(await call(`/support/tickets/${ticketId}/jira/issue-types?mappingId=${mappingId}`, gm), 403),
    ).toBe('FORBIDDEN');
  });

  it('a field reporter on another project cannot reach this ticket or its Jira panel', async () => {
    expect(await failure(await call(`/support/tickets/${ticketId}/jira`, fieldTmp), 404)).toBe('NOT_FOUND');
  });
});

describe('project Jira tab', () => {
  it('returns the overview to jira.view holders and refuses others', async () => {
    const ihd = await projectId('IHD');
    const overview = await ok(await call(`/projects/${ihd}/jira`, gm), jiraProjectOverviewResponseSchema);
    expect(overview.data.mappings.map((mapping) => mapping.jiraProject.key)).toEqual(['OPS']);
    expect(overview.data.signals.linkedTickets).toBe(1);
    expect(await failure(await call(`/projects/${ihd}/jira`, employee), 403)).toBe('FORBIDDEN');
  });
});

describe('disconnect', () => {
  it('needs the current version, wipes tokens and turns the webhook endpoint into 404', async () => {
    const status = await ok(await call('/integrations/jira', tm), jiraIntegrationStatusResponseSchema);
    const version = status.data.connection?.version ?? 0;
    expect(
      await failure(
        await call(`/integrations/jira/connections/${connectionId}?version=${String(version + 5)}`, tm, {
          method: 'DELETE',
        }),
        409,
      ),
    ).toBe('VERSION_CONFLICT');
    const disconnected = await ok(
      await call(`/integrations/jira/connections/${connectionId}?version=${String(version)}`, tm, { method: 'DELETE' }),
      jiraConnectionResponseSchema,
    );
    expect(disconnected.data.status).toBe('DISCONNECTED');
    expect(await failure(await webhook(issueEvent('10000', '20001')), 404)).toBe('NOT_FOUND');
    const panel = await ok(await call(`/support/tickets/${ticketId}/jira`, support), ticketJiraPanelResponseSchema);
    expect(panel.data.available).toBe(false);
    expect(panel.data.links).toHaveLength(1);
  });
});
