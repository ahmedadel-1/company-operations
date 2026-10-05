import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { JiraAdminService } from '../../src/modules/jira/jira-admin.service.js';
import { JiraConnectionService } from '../../src/modules/jira/jira-connection.service.js';
import { InMemoryKeyValueStore } from '../../src/modules/jira/jira-coordination.js';
import {
  JiraCreateOutcomeUnknownError,
  JiraReauthRequiredError,
  JiraRequestRejectedError,
  JiraSyncInProgressError,
} from '../../src/modules/jira/jira-errors.js';
import { applySnapshot, loadPlacement } from '../../src/modules/jira/jira-issue-store.js';
import { JiraLinksService } from '../../src/modules/jira/jira-links.service.js';
import type { JiraAppSettings } from '../../src/modules/jira/jira-oauth.js';
import { JiraOverviewService } from '../../src/modules/jira/jira-overview.service.js';
import { createJiraRuntime } from '../../src/modules/jira/jira-runtime.js';
import type { JiraRuntime } from '../../src/modules/jira/jira-runtime.js';
import { JiraScheduler } from '../../src/modules/jira/jira-scheduler.js';
import { JiraSyncEngine } from '../../src/modules/jira/jira-sync-engine.js';
import type { SliceOutcome } from '../../src/modules/jira/jira-sync-engine.js';
import { signWebhookJwt } from '../../src/modules/jira/jira-webhook-jwt.js';
import { JiraWebhookIntake, JiraWebhookProcessor, JiraWebhookRegistrar } from '../../src/modules/jira/jira-webhooks.js';
import { notificationEntityAccess } from '../../src/modules/notifications/notification-entity-access.js';
import { TicketCommentService } from '../../src/modules/support/ticket-comment.service.js';
import { TicketService } from '../../src/modules/support/ticket.service.js';
import type { TicketView } from '../../src/modules/support/ticket-views.js';
import { EnvelopeCipher } from '../../src/platform/crypto/envelope-cipher.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../src/platform/errors.js';
import { FakeJira } from '../../src/testing/fake-jira.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * The Jira integration end to end against PostgreSQL 18 (real migrations, development seed) and the
 * deterministic Jira double (no network): OAuth connect, encrypted tokens and rotation, mappings,
 * import with checkpoints, webhooks (JWT, dedupe, out-of-order, tombstones), reconciliation, 429
 * pauses, re-authorization, ticket links, idempotent issue creation, signals and tenant isolation
 * of every Jira table.
 *
 * Actors (seed): EMP-00006 technical manager (integration.manage, jira.* at ORG), EMP-00001 org
 * admin (integration.manage), EMP-00040 support agent (jira.* at ORG), EMP-00019 support agent on
 * IHD (reports IHD tickets), EMP-00041 project manager
 * of IHD (jira.* at PROJECT), EMP-00002 general manager (jira.view only), EMP-00024 field employee
 * on TMP (no Jira permissions), EMP-00004 employee.
 */
const CLIENT_SECRET = 'fake-client-secret-for-tests';
const settings: JiraAppSettings = {
  clientId: 'fake-client-id',
  clientSecret: CLIENT_SECRET,
  authBaseUrl: 'http://fake-auth.test',
  apiBaseUrl: 'http://fake-api.test',
  publicUrl: 'http://localhost:3000',
};

let s: SeededDatabase;
let fake: FakeJira;
let runtime: JiraRuntime;
let cipher: EnvelopeCipher;
let connections: JiraConnectionService;
let admin: JiraAdminService;
let links: JiraLinksService;
let overview: JiraOverviewService;
let engine: JiraSyncEngine;
let onePageEngine: JiraSyncEngine;
let processor: JiraWebhookProcessor;
let registrar: JiraWebhookRegistrar;
let intake: JiraWebhookIntake;
let scheduler: JiraScheduler;
let tickets: TicketService;
let comments: TicketCommentService;
let skewMs = 0;

let tm: ActionContext;
let orgAdmin: ActionContext;
let agent: ActionContext;
let tier: ActionContext;
let pm: ActionContext;
let gm: ActionContext;
let field: ActionContext;
let employee: ActionContext;

let connectionId: string;
let ihdMappingId: string;
let tmpMappingId: string;

const projectId = async (code: string): Promise<string> =>
  (await s.prisma.project.findFirstOrThrow({ where: { organizationId: s.demoId, code }, select: { id: true } })).id;

const system = <T>(fn: () => PromiseLike<T>): Promise<T> => s.asSystem(s.demoId, fn);

async function connect(actor: ActionContext, reauthorize: string | null = null): Promise<string> {
  const { authorizeUrl } = await s.as(actor, () => connections.startConnect(actor, reauthorize));
  const redirect = await fake.fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(redirect.headers.get('location') ?? '');
  const result = await s.as(actor, () =>
    connections.completeCallback(actor, {
      code: back.searchParams.get('code') ?? '',
      state: back.searchParams.get('state') ?? '',
    }),
  );
  if (result.kind !== 'connected') {
    throw new Error('expected a direct connection');
  }
  return result.connectionId;
}

async function activeRun(mappingId: string): Promise<string> {
  return (
    await s.prisma.jiraSyncRun.findFirstOrThrow({
      where: { mappingId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    })
  ).id;
}

async function drain(runId: string, using: JiraSyncEngine = engine): Promise<SliceOutcome> {
  for (let slice = 0; slice < 60; slice += 1) {
    const outcome = await system(() => using.runSlice(runId));
    if (outcome.kind !== 'continue') {
      return outcome;
    }
  }
  throw new Error('the run did not finish');
}

async function runRow(runId: string) {
  return s.prisma.jiraSyncRun.findUniqueOrThrow({ where: { id: runId } });
}

async function cached(issueKey: string) {
  return s.prisma.jiraIssue.findFirstOrThrow({ where: { organizationId: s.demoId, issueKey } });
}

async function deliveryByKey(deliveryKey: string) {
  return s.prisma.jiraWebhookDelivery.findFirstOrThrow({ where: { organizationId: s.demoId, deliveryKey } });
}

async function processDelivery(deliveryKey: string) {
  const delivery = await deliveryByKey(deliveryKey);
  return system(() => processor.process(delivery.id));
}

const report = (actor: ActionContext, project: string, title: string): Promise<TicketView> =>
  projectId(project).then((id) =>
    s.as(actor, () =>
      tickets.create(actor, {
        title,
        description: 'Customer cannot sign in.',
        severity: 'HIGH',
        impact: 'SINGLE_USER',
        projectId: id,
        source: 'FIELD',
      }),
    ),
  );

const historyTypes = async (actor: ActionContext, ticketId: string): Promise<string[]> =>
  (await s.as(actor, () => tickets.history(actor, ticketId, {}))).items.map((event) => event.type);

beforeAll(async () => {
  s = await startSeededDatabase();
  fake = new FakeJira({
    clientId: settings.clientId,
    clientSecret: CLIENT_SECRET,
    hangMs: 50,
    deliver: async (url, init) => {
      const headers = new Headers(init.headers);
      const result = await intake.receive({
        connectionId: new URL(url).pathname.split('/').at(-1) ?? '',
        authorization: headers.get('authorization') ?? undefined,
        identifier: headers.get('x-atlassian-webhook-identifier') ?? undefined,
        retry: headers.get('x-atlassian-webhook-retry') ?? undefined,
        body: JSON.parse(typeof init.body === 'string' ? init.body : '{}'),
      });
      return new Response(JSON.stringify(result), { status: result.status });
    },
  });
  cipher = new EnvelopeCipher({ id: 'k1', key: randomBytes(32) });
  runtime = createJiraRuntime({
    settings,
    fetch: fake.fetch,
    kv: new InMemoryKeyValueStore(() => Date.now() + skewMs),
    db: s.tenantDb,
    cipher,
    http: { sleep: () => Promise.resolve(), maxRetries: 1, timeoutMs: 5_000 },
  });
  connections = new JiraConnectionService(s.tenantDb, s.tenant, runtime, cipher);
  admin = new JiraAdminService(s.tenantDb, s.tenant, runtime);
  links = new JiraLinksService(s.tenantDb, s.tenant, runtime, settings.publicUrl);
  overview = new JiraOverviewService(s.tenantDb, s.tenant, true);
  const publish = () => Promise.resolve();
  engine = new JiraSyncEngine(s.tenantDb, s.tenant, runtime.clients, runtime.coordination, publish, {
    pageSize: 2,
    maxPagesPerSlice: 3,
  });
  onePageEngine = new JiraSyncEngine(s.tenantDb, s.tenant, runtime.clients, runtime.coordination, publish, {
    pageSize: 2,
    maxPagesPerSlice: 1,
  });
  processor = new JiraWebhookProcessor(s.tenantDb, s.tenant, runtime.clients);
  registrar = new JiraWebhookRegistrar(s.tenantDb, s.tenant, runtime.clients, settings);
  intake = new JiraWebhookIntake(s.prisma, s.tenantDb, s.tenant, CLIENT_SECRET);
  scheduler = new JiraScheduler(s.prisma, s.tenantDb, s.tenant, (_organizationId, error) => {
    throw error;
  });
  tickets = new TicketService(s.tenantDb, s.tenant);
  comments = new TicketCommentService(s.tenantDb, s.tenant);
  tm = await s.actionFor('EMP-00006');
  orgAdmin = await s.actionFor('EMP-00001');
  agent = await s.actionFor('EMP-00040');
  tier = await s.actionFor('EMP-00019');
  pm = await s.actionFor('EMP-00041');
  gm = await s.actionFor('EMP-00002');
  field = await s.actionFor('EMP-00024');
  employee = await s.actionFor('EMP-00004');
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('connection', () => {
  it('is managed by integration administrators only', async () => {
    await expect(s.as(gm, () => connections.status(gm))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(agent, () => connections.startConnect(agent, null))).rejects.toBeInstanceOf(ForbiddenError);
    const status = await s.as(tm, () => connections.status(tm));
    expect(status).toMatchObject({
      configured: true,
      connection: null,
      redirectUri: 'http://localhost:3000/api/v1/integrations/jira/callback',
    });
  });

  it('binds the OAuth state to the member who started it and accepts it once', async () => {
    const { authorizeUrl } = await s.as(tm, () => connections.startConnect(tm, null));
    const back = new URL((await fake.fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location') ?? '');
    const input = { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '' };
    await expect(s.as(orgAdmin, () => connections.completeCallback(orgAdmin, input))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // The state was consumed by the rejected attempt: it cannot be replayed by its owner either.
    await expect(s.as(tm, () => connections.completeCallback(tm, input))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(tm, () => connections.completeCallback(tm, { code: 'x', state: 'forged' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('connects the site from accessible-resources and stores only encrypted, bound tokens', async () => {
    connectionId = await connect(tm);
    const row = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row).toMatchObject({
      organizationId: s.demoId,
      cloudId: 'fake-cloud-1',
      status: 'ACTIVE',
      encryptionKeyId: 'k1',
    });
    expect(row.accessTokenEnc).not.toContain('fake-access');
    expect(row.refreshTokenEnc).not.toContain('fake-refresh');
    const status = await s.as(tm, () => connections.status(tm));
    expect(status.connection).toMatchObject({ id: connectionId, siteName: 'Fake Jira', status: 'ACTIVE' });
    expect(JSON.stringify(status)).not.toMatch(/fake-(access|refresh)|TokenEnc/);
    const audit = await s.prisma.auditLog.findFirst({
      where: { organizationId: s.demoId, action: 'jira.connection.connected', entityId: connectionId },
    });
    expect(audit).not.toBeNull();
    await expect(s.as(tm, () => connections.startConnect(tm, null))).rejects.toBeInstanceOf(ConflictError);
  });

  it('refreshes tokens once under the connection lock when several callers race', async () => {
    const before = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const [a, b] = await Promise.all([
      system(() => runtime.tokens.accessToken(s.demoId, connectionId, true)),
      system(() => runtime.tokens.accessToken(s.demoId, connectionId, true)),
    ]);
    expect(a).toBe(b);
    const after = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.version).toBe(before.version + 1);
    expect(after.refreshTokenEnc).not.toBe(before.refreshTokenEnc);
  });
});

describe('mappings and import', () => {
  it('maps projects after validating the Jira project live, and audits it on the project timeline', async () => {
    const ihd = await projectId('IHD');
    await expect(
      s.as(agent, () => admin.createMapping(agent, { projectId: ihd, jiraProjectId: '20001' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(tm, () => admin.createMapping(tm, { projectId: ihd, jiraProjectId: '99999' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const options = await s.as(tm, () => admin.searchJiraProjects(tm, 'op', 0));
    expect(options.items.map((p) => p.key)).toEqual(['OPS']);
    const mapping = await s.as(tm, () => admin.createMapping(tm, { projectId: ihd, jiraProjectId: '20001' }));
    ihdMappingId = mapping.id;
    expect(mapping).toMatchObject({ jiraProject: { key: 'OPS' }, importState: 'NOT_STARTED' });
    await expect(
      s.as(tm, () => admin.createMapping(tm, { projectId: ihd, jiraProjectId: '20001' })),
    ).rejects.toBeInstanceOf(ConflictError);
    const tmpProject = await projectId('TMP');
    const tmp = await s.as(tm, () => admin.createMapping(tm, { projectId: tmpProject, jiraProjectId: '20002' }));
    tmpMappingId = tmp.id;
    const activity = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, eventType: 'project.activity.recorded', aggregateId: ihd },
    });
    expect(activity.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        source: 'JIRA',
        type: 'jira.mapping_added',
        summaryParams: { jiraProjectKey: 'OPS', jiraProjectName: 'Operations Platform' },
      }),
    );
  });

  it('imports every issue with an estimate, then marks the mapping imported', async () => {
    const runId = await activeRun(ihdMappingId);
    await expect(s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'MANUAL_RESYNC'))).rejects.toBeInstanceOf(
      JiraSyncInProgressError,
    );
    expect(await drain(runId)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    const run = await runRow(runId);
    expect(run).toMatchObject({ type: 'INITIAL_IMPORT', recordsEstimated: 4, recordsCreated: 4, recordsFailed: 0 });
    expect(run.pages).toBeGreaterThanOrEqual(2);
    const mapping = await s.prisma.jiraProjectMapping.findUniqueOrThrow({ where: { id: ihdMappingId } });
    expect(mapping.importState).toBe('COMPLETED');
    expect(mapping.lastReconciledAt).not.toBeNull();
    expect(await drain(await activeRun(tmpMappingId))).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect((await cached('OPS-3')).isBlocked).toBe(true);
  });

  it('shows signals on the project Jira tab to members with jira.view on the project only', async () => {
    const ihd = await projectId('IHD');
    const view = await s.as(pm, () => overview.projectOverview(pm, ihd));
    expect(view.signals).toMatchObject({ open: 3, blocked: 1, overdue: 1 });
    expect(view.mappings.map((m) => m.jiraProject.key)).toEqual(['OPS']);
    expect(view.canManage).toBe(false);
    const tmp = await projectId('TMP');
    await expect(s.as(pm, () => overview.projectOverview(pm, tmp))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(employee, () => overview.projectOverview(employee, ihd))).rejects.toThrow();
  });

  it('resumes an import from its checkpoint when the page token expires', async () => {
    for (let index = 0; index < 5; index += 1) {
      fake.addIssue({
        projectId: '20001',
        summary: `Bulk issue ${String(index)}`,
        created: Date.now() - 60_000 * (10 - index),
      });
    }
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'MANUAL_RESYNC'));
    expect(await system(() => onePageEngine.runSlice(run.id))).toEqual({ kind: 'continue' });
    expect((await runRow(run.id)).lastCursor).toHaveProperty('pageToken');
    fake.expirePageTokens();
    expect(await drain(run.id, onePageEngine)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(await s.prisma.jiraIssue.count({ where: { mappingId: ihdMappingId, deletedInJiraAt: null } })).toBe(9);
    expect((await runRow(run.id)).recordsFailed).toBe(0);
  });

  it('cancels a running import at the next page and keeps the completed cache usable', async () => {
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'MANUAL_RESYNC'));
    expect(await system(() => onePageEngine.runSlice(run.id))).toEqual({ kind: 'continue' });
    expect((await s.as(tm, () => admin.cancelRun(tm, run.id))).status).toBe('RUNNING');
    expect(await system(() => onePageEngine.runSlice(run.id))).toEqual({ kind: 'finished', status: 'CANCELLED' });
    expect((await s.prisma.jiraProjectMapping.findUniqueOrThrow({ where: { id: ihdMappingId } })).importState).toBe(
      'COMPLETED',
    );
    expect((await s.as(tm, () => admin.retryRun(tm, run.id))).resumedFromRunId).toBe(run.id);
    await drain(await activeRun(ihdMappingId));
  });

  it('pauses the whole connection when Jira rate limits and resumes after Retry-After', async () => {
    fake.fail({ match: 'POST /search/jql', kind: 'rate_limit', retryAfterSeconds: 120 });
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'RECONCILIATION'));
    const first = await system(() => engine.runSlice(run.id));
    expect(first.kind).toBe('retry_later');
    expect(first.kind === 'retry_later' ? first.delayMs : 0).toBeGreaterThan(100_000);
    expect(await runtime.coordination.pausedUntil(connectionId)).not.toBeNull();
    const calls = fake.requests.length;
    expect((await system(() => engine.runSlice(run.id))).kind).toBe('retry_later');
    expect(fake.requests.length).toBe(calls);
    skewMs += 130_000;
    expect(await drain(run.id)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
  });

  it('records transient failures and fails the run after repeated errors', async () => {
    fake.fail({ match: 'POST /search/jql', kind: 'server_error', times: 20 });
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'RECONCILIATION'));
    let outcome: SliceOutcome = { kind: 'continue' };
    for (let attempt = 0; attempt < 10 && outcome.kind !== 'finished'; attempt += 1) {
      outcome = await system(() => engine.runSlice(run.id));
    }
    expect(outcome).toEqual({ kind: 'finished', status: 'FAILED' });
    expect((await runRow(run.id)).errorCode).toBe('jira_unavailable');
    expect((await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe('ERROR');
    fake.failures.length = 0;
    expect(await drain((await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'RECONCILIATION'))).id)).toEqual({
      kind: 'finished',
      status: 'SUCCEEDED',
    });
    expect((await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe('ACTIVE');
  });

  it('queues due reconciliations and re-enqueues stalled runs from the scheduler', async () => {
    const totals = await scheduler.queueDue(
      'RECONCILIATION',
      60 * 60 * 1000,
      new Date(Date.now() + 3 * 60 * 60 * 1000),
    );
    expect(totals.queued).toBe(2);
    const runId = await activeRun(ihdMappingId);
    expect(await scheduler.requeueStale(new Date(Date.now() + 60_000))).toBeGreaterThanOrEqual(2);
    await drain(runId);
    await drain(await activeRun(tmpMappingId));
  });
});

describe('webhooks', () => {
  it('registers one webhook covering exactly the mapped projects', async () => {
    expect(await system(() => registrar.sync(connectionId))).toBe('registered');
    expect([...fake.webhooks.values()].map((w) => w.jqlFilter)).toEqual(['project in (20001, 20002)']);
    expect(await system(() => registrar.sync(connectionId))).toBe('unchanged');
  });

  it('authenticates, deduplicates and queues deliveries, then applies the re-fetched issue', async () => {
    fake.updateIssue('OPS-1', { statusName: 'In Review', summary: 'Login fails on Safari 18' });
    const [delivered] = await fake.emitWebhook('OPS-1', 'jira:issue_updated', { identifier: 'delivery-1' });
    expect(delivered?.status).toBe(202);
    const [replayed] = await fake.emitWebhook('OPS-1', 'jira:issue_updated', { identifier: 'delivery-1', retry: 1 });
    expect(replayed?.status).toBe(200);
    expect(await s.prisma.jiraWebhookDelivery.count({ where: { deliveryKey: 'delivery-1' } })).toBe(1);
    const stored = await deliveryByKey('delivery-1');
    expect(stored.payload).not.toHaveProperty('issue');
    expect(await processDelivery('delivery-1')).toBe('updated');
    expect(await processDelivery('delivery-1')).toBe('duplicate');
    expect(await cached('OPS-1')).toMatchObject({ statusName: 'In Review', summary: 'Login fails on Safari 18' });
  });

  it('rejects unsigned, forged, unknown-connection and foreign-webhook deliveries', async () => {
    const [forged] = await fake.emitWebhook('OPS-1', 'jira:issue_updated', { secret: 'not-the-client-secret' });
    expect(forged?.status).toBe(401);
    const token = `Bearer ${signWebhookJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, CLIENT_SECRET)}`;
    const body = {
      webhookEvent: 'jira:issue_updated',
      matchedWebhookIds: [99999],
      issue: { id: '10000', fields: { project: { id: '20001' } } },
    };
    const receive = (overrides: Partial<Parameters<JiraWebhookIntake['receive']>[0]>) =>
      intake.receive({ connectionId, authorization: token, identifier: randomUUID(), retry: '0', body, ...overrides });
    expect(await receive({ authorization: undefined })).toMatchObject({ status: 401 });
    expect(await receive({})).toMatchObject({ status: 403 });
    expect(await receive({ connectionId: randomUUID() })).toMatchObject({ status: 404 });
    expect(await receive({ connectionId: 'not-a-uuid' })).toMatchObject({ status: 404 });
    expect(await receive({ body: { issue: 'x' } })).toMatchObject({ status: 400 });
    expect(await receive({ body: { webhookEvent: 'comment_created', issue: { id: '10000' } } })).toMatchObject({
      status: 200,
      outcome: 'ignored',
    });
  });

  it('ignores snapshots older than the cached copy (out-of-order delivery)', async () => {
    const row = await cached('OPS-1');
    const placement = await system(() => loadPlacement(s.tenantDb, s.demoId, connectionId));
    const older = {
      jiraIssueId: row.jiraIssueId,
      issueKey: row.issueKey,
      jiraProjectId: row.jiraProjectId,
      summary: 'Stale summary',
      issueType: row.issueType,
      statusName: 'To Do',
      statusCategory: 'TODO' as const,
      priorityName: null,
      assigneeAccountId: null,
      assigneeDisplayName: null,
      reporterDisplayName: null,
      jiraCreatedAt: row.jiraCreatedAt,
      jiraUpdatedAt: new Date(row.jiraUpdatedAt.getTime() - 60_000),
      dueDate: null,
      resolution: null,
      resolvedAt: null,
      labels: [],
      parentIssueId: null,
      url: row.url,
    };
    expect((await system(() => applySnapshot(s.tenantDb, placement, older))).outcome).toBe('stale');
    expect((await cached('OPS-1')).summary).toBe('Login fails on Safari 18');
  });

  it('refreshes registrations close to expiry', async () => {
    await s.prisma.jiraWebhookRegistration.updateMany({
      where: { connectionId },
      data: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    expect(await system(() => registrar.sync(connectionId))).toBe('refreshed');
    const registration = await s.prisma.jiraWebhookRegistration.findFirstOrThrow({ where: { connectionId } });
    expect(registration.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
  });
});

describe('ticket links', () => {
  let ihdTicket: TicketView;
  let tmpTicket: TicketView;

  beforeAll(async () => {
    ihdTicket = await report(tier, 'IHD', 'Sign-in broken for customer');
    tmpTicket = await report(field, 'TMP', 'Field tablet app crashes');
  });

  it('shows the panel only to members with jira.view on the ticket', async () => {
    expect((await s.as(agent, () => links.panel(agent, ihdTicket.id))).visible).toBe(true);
    expect(await s.as(field, () => links.panel(field, tmpTicket.id))).toMatchObject({ visible: false, links: [] });
    await expect(s.as(employee, () => links.panel(employee, ihdTicket.id))).rejects.toBeInstanceOf(NotFoundError);
    expect(await s.as(gm, () => links.panel(gm, ihdTicket.id))).toMatchObject({
      visible: true,
      canLink: false,
      canCreate: false,
    });
  });

  it('searches the cache and live Jira inside the mapped projects only', async () => {
    const fromCache = await s.as(agent, () => links.search(agent, ihdTicket.id, { q: 'safari', source: 'cache' }));
    expect(fromCache.map((issue) => issue.key)).toEqual(['OPS-1']);
    const live = await s.as(agent, () => links.search(agent, ihdTicket.id, { q: 'MOB-1', source: 'jira' }));
    expect(live).toEqual([]);
    const byKey = await s.as(agent, () => links.search(agent, ihdTicket.id, { q: 'ops-2', source: 'jira' }));
    expect(byKey.map((issue) => issue.key)).toEqual(['OPS-2']);
    await expect(s.as(gm, () => links.search(gm, ihdTicket.id, { q: '', source: 'cache' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('links and unlinks with history and audit, never changing the ticket status', async () => {
    const issue = await cached('OPS-1');
    const link = await s.as(pm, () => links.link(pm, ihdTicket.id, { issueId: issue.id, linkType: 'FIX_TRACKED_BY' }));
    expect(link).toMatchObject({ linkType: 'FIX_TRACKED_BY', createdVia: 'LINKED_EXISTING', issue: { key: 'OPS-1' } });
    await expect(
      s.as(agent, () => links.link(agent, ihdTicket.id, { issueId: issue.id, linkType: 'RELATED' })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      s.as(gm, () => links.link(gm, ihdTicket.id, { issueId: issue.id, linkType: 'RELATED' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const mob = await cached('MOB-1');
    await expect(
      s.as(agent, () => links.link(agent, ihdTicket.id, { issueId: mob.id, linkType: 'RELATED' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const other = await cached('OPS-2');
    const second = await s.as(agent, () => links.link(agent, ihdTicket.id, { issueId: other.id, linkType: 'RELATED' }));
    await s.as(agent, () => links.unlink(agent, ihdTicket.id, second.id));
    expect(await historyTypes(agent, ihdTicket.id)).toEqual(expect.arrayContaining(['JIRA_LINKED', 'JIRA_UNLINKED']));
    expect((await s.as(agent, () => tickets.get(agent, ihdTicket.id))).status).toBe(ihdTicket.status);
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, action: { in: ['jira.link.created', 'jira.link.removed'] } },
      }),
    ).toBe(3);
  });

  it('records Jira status changes on linked tickets without touching their lifecycle', async () => {
    fake.updateIssue('OPS-1', { statusName: 'Done', statusCategory: 'done' });
    await fake.emitWebhook('OPS-1', 'jira:issue_updated', { identifier: 'delivery-status' });
    expect(await processDelivery('delivery-status')).toBe('updated');
    const history = await s.as(agent, () => tickets.history(agent, ihdTicket.id, {}));
    const synced = history.items.find((event) => event.type === 'JIRA_STATUS_SYNCED');
    expect(synced?.to).toMatchObject({ status: 'Done', category: 'DONE' });
    expect((await s.as(agent, () => tickets.get(agent, ihdTicket.id))).status).toBe(ihdTicket.status);
  });

  it('keeps links to issues deleted in Jira and shows them as removed', async () => {
    fake.deleteIssue('OPS-1');
    await fake.emitWebhook('OPS-1', 'jira:issue_deleted', { identifier: 'delivery-delete' });
    expect(await processDelivery('delivery-delete')).toBe('tombstoned');
    const panel = await s.as(agent, () => links.panel(agent, ihdTicket.id));
    expect(panel.links.map((l) => [l.issue.key, l.issue.removedInJira])).toEqual([['OPS-1', true]]);
    const removed = await cached('OPS-1');
    await expect(
      s.as(agent, () => links.link(agent, tmpTicket.id, { issueId: removed.id, linkType: 'RELATED' })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('hides Jira history from reporters without jira.view', async () => {
    const issue = await cached('MOB-1');
    await s.as(agent, () => links.link(agent, tmpTicket.id, { issueId: issue.id, linkType: 'RELATED' }));
    expect(await historyTypes(agent, tmpTicket.id)).toContain('JIRA_LINKED');
    expect(await historyTypes(field, tmpTicket.id)).not.toContain('JIRA_LINKED');
  });

  describe('create issue from ticket', () => {
    const input = (overrides: Partial<{ issueTypeId: string; summary: string }> = {}) => ({
      mappingId: tmpMappingId,
      issueTypeId: '10001',
      summary: 'Tablet app crashes on launch',
      description: 'Steps:\nopen the app\n\nIt crashes.',
      linkType: 'FIX_TRACKED_BY' as const,
      ...overrides,
    });

    it('offers only creatable issue types of the mapped project', async () => {
      const types = await s.as(agent, () => links.issueTypes(agent, tmpTicket.id, tmpMappingId));
      expect(types.map((type) => type.name)).toEqual(['Bug', 'Task']);
      await expect(s.as(agent, () => links.issueTypes(agent, tmpTicket.id, ihdMappingId))).rejects.toThrow();
    });

    it('creates once per key with a backlink and no internal notes, then replays', async () => {
      await s.as(agent, () =>
        comments.add(agent, tmpTicket.id, {
          body: 'SECRET-INTERNAL-NOTE customer password reset',
          visibility: 'INTERNAL_NOTE',
        }),
      );
      const key = randomUUID();
      const before = fake.createdIssues.length;
      const link = await s.as(agent, () => links.createIssue(agent, tmpTicket.id, input(), key));
      expect(link).toMatchObject({ createdVia: 'CREATED_FROM_TICKET', linkType: 'FIX_TRACKED_BY' });
      expect(fake.createdIssues).toHaveLength(before + 1);
      const sent = JSON.stringify(fake.createdIssues.at(-1)?.fields);
      expect(sent).toContain(`SUP-${String(tmpTicket.number)}`);
      expect(sent).toContain(`http://localhost:3000/support/tickets/${tmpTicket.id}`);
      expect(sent).not.toContain('SECRET-INTERNAL-NOTE');
      expect(sent).not.toMatch(/attachment/i);
      const replay = await s.as(agent, () => links.createIssue(agent, tmpTicket.id, input(), key));
      expect(replay.id).toBe(link.id);
      expect(fake.createdIssues).toHaveLength(before + 1);
      await expect(
        s.as(agent, () => links.createIssue(agent, tmpTicket.id, input({ summary: 'Different' }), key)),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await historyTypes(agent, tmpTicket.id)).toContain('JIRA_CREATED');
      expect((await s.as(agent, () => tickets.get(agent, tmpTicket.id))).status).toBe(tmpTicket.status);
      expect(
        await s.prisma.auditLog.count({
          where: { organizationId: s.demoId, action: 'jira.issue.created', entityId: tmpTicket.id },
        }),
      ).toBe(1);
    });

    it('rejects sub-task types and members without jira.create_issue', async () => {
      await expect(
        s.as(agent, () => links.createIssue(agent, tmpTicket.id, input({ issueTypeId: '10003' }), randomUUID())),
      ).rejects.toBeInstanceOf(InvalidInputError);
      await expect(s.as(gm, () => links.createIssue(gm, tmpTicket.id, input(), randomUUID()))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        s.as(field, () => links.createIssue(field, tmpTicket.id, input(), randomUUID())),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('reports an ambiguous outcome instead of creating twice, and allows a retry after a rejection', async () => {
      const ambiguous = randomUUID();
      fake.fail({ match: 'POST /issue', kind: 'server_error' });
      const before = fake.createdIssues.length;
      await expect(
        s.as(agent, () => links.createIssue(agent, tmpTicket.id, input(), ambiguous)),
      ).rejects.toBeInstanceOf(JiraCreateOutcomeUnknownError);
      await expect(
        s.as(agent, () => links.createIssue(agent, tmpTicket.id, input(), ambiguous)),
      ).rejects.toBeInstanceOf(JiraCreateOutcomeUnknownError);
      expect(fake.createdIssues).toHaveLength(before);
      const rejected = randomUUID();
      fake.fail({ match: 'POST /issue', kind: 'bad_request' });
      await expect(
        s.as(agent, () => links.createIssue(agent, tmpTicket.id, input({ summary: 'Retry me' }), rejected)),
      ).rejects.toBeInstanceOf(JiraRequestRejectedError);
      const retried = await s.as(agent, () =>
        links.createIssue(agent, tmpTicket.id, input({ summary: 'Retry me' }), rejected),
      );
      expect(retried.createdVia).toBe('CREATED_FROM_TICKET');
      expect(fake.createdIssues).toHaveLength(before + 1);
    });
  });
});

describe('deep reconciliation', () => {
  it('tombstones issues gone from Jira and queues a full resync on count drift', async () => {
    fake.deleteIssue('OPS-2');
    for (let index = 0; index < 3; index += 1) {
      fake.addIssue({
        projectId: '20001',
        summary: `Silent ${String(index)}`,
        created: Date.now() - 86_400_000,
        updated: Date.now() - 86_400_000,
      });
    }
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'DEEP_RECONCILIATION'));
    expect(await drain(run.id)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect((await runRow(run.id)).errorCode).toBe('count_drift');
    expect((await cached('OPS-2')).deletedInJiraAt).not.toBeNull();
    const resync = await s.prisma.jiraSyncRun.findFirstOrThrow({
      where: { mappingId: ihdMappingId, status: 'QUEUED' },
    });
    expect(resync.type).toBe('MANUAL_RESYNC');
    expect(await drain(resync.id)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(await s.prisma.jiraIssue.count({ where: { mappingId: ihdMappingId, deletedInJiraAt: null } })).toBe(
      [...fake.issues.values()].filter((issue) => issue.projectId === '20001' && !issue.deleted).length,
    );
  });
});

describe('re-authorization', () => {
  it('moves the connection to NEEDS_REAUTH once when the grant is revoked, and recovers on reconnect', async () => {
    const ticket = await report(tier, 'IHD', 'Re-auth probe');
    fake.revokeGrants();
    await expect(s.as(agent, () => links.search(agent, ticket.id, { q: '', source: 'jira' }))).rejects.toBeInstanceOf(
      JiraReauthRequiredError,
    );
    const row = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row).toMatchObject({ status: 'NEEDS_REAUTH', lastErrorCode: 'jira_reauth_required' });
    const notices = await s.prisma.outboxEvent.findMany({
      where: {
        organizationId: s.demoId,
        aggregateType: 'jira_connection',
        aggregateId: connectionId,
        eventType: 'notification.requested',
      },
    });
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(notices.map((n) => n.payload))).toContain('JIRA_REAUTH_REQUIRED');
    await expect(s.as(agent, () => links.search(agent, ticket.id, { q: '', source: 'jira' }))).rejects.toBeInstanceOf(
      JiraReauthRequiredError,
    );
    expect(
      await s.prisma.outboxEvent.count({ where: { aggregateId: connectionId, eventType: 'notification.requested' } }),
    ).toBe(notices.length);
    expect(await s.as(agent, () => links.panel(agent, ticket.id))).toMatchObject({
      connectionStatus: 'NEEDS_REAUTH',
      canLink: false,
      canCreate: false,
    });
    await expect(s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'RECONCILIATION'))).rejects.toBeInstanceOf(
      JiraReauthRequiredError,
    );
    expect(await connect(tm, connectionId)).toBe(connectionId);
    expect((await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe('ACTIVE');
    expect((await s.as(agent, () => links.search(agent, ticket.id, { q: '', source: 'jira' }))).length).toBeGreaterThan(
      0,
    );
  });

  it('re-checks integration.manage before emailing connection notices', async () => {
    const access = notificationEntityAccess(s.tenantDb);
    expect(await system(() => access(s.demoId, tm.principal.memberId, 'jira_connection', connectionId))).toBe(true);
    expect(await system(() => access(s.demoId, agent.principal.memberId, 'jira_connection', connectionId))).toBe(false);
  });
});

describe('tenant isolation of every Jira table', () => {
  let foreign: {
    connectionId: string;
    mappingId: string;
    issueId: string;
    runId: string;
    deliveryId: string;
    memberId: string;
  };

  beforeAll(async () => {
    const member = await s.employee('NW-001', s.northwindId);
    const project = await s.prisma.project.create({
      data: { organizationId: s.northwindId, number: 900, code: 'NWJ', name: 'Northwind Jira project' },
      select: { id: true },
    });
    const org = s.northwindId;
    const connection = await s.prisma.jiraConnection.create({
      data: {
        organizationId: org,
        cloudId: 'nw-cloud',
        siteUrl: 'https://nw.atlassian.net',
        siteName: 'Northwind',
        status: 'DISCONNECTED',
        disconnectedAt: new Date(),
        connectedByMemberId: member.memberId,
      },
    });
    const mapping = await s.prisma.jiraProjectMapping.create({
      data: {
        organizationId: org,
        connectionId: connection.id,
        projectId: project.id,
        jiraProjectId: '30001',
        jiraProjectKey: 'NW',
        jiraProjectName: 'NW',
      },
    });
    const issue = await s.prisma.jiraIssue.create({
      data: {
        organizationId: org,
        connectionId: connection.id,
        mappingId: mapping.id,
        jiraIssueId: '50001',
        issueKey: 'NW-1',
        jiraProjectId: '30001',
        summary: 'Northwind secret issue',
        issueType: 'Bug',
        statusName: 'To Do',
        statusCategory: 'TODO',
        jiraCreatedAt: new Date(),
        jiraUpdatedAt: new Date(),
        url: 'https://nw.atlassian.net/browse/NW-1',
        syncHash: 'x',
      },
    });
    const run = await s.prisma.jiraSyncRun.create({
      data: { organizationId: org, connectionId: connection.id, mappingId: mapping.id, type: 'INITIAL_IMPORT' },
    });
    await s.prisma.jiraSyncFailure.create({
      data: { organizationId: org, runId: run.id, errorCode: 'x', classification: 'PERMANENT', message: 'x' },
    });
    await s.prisma.jiraWebhookRegistration.create({
      data: {
        organizationId: org,
        connectionId: connection.id,
        jiraWebhookId: '1',
        jqlFilter: 'project = 30001',
        events: ['jira:issue_updated'],
        expiresAt: new Date(),
      },
    });
    const delivery = await s.prisma.jiraWebhookDelivery.create({
      data: {
        organizationId: org,
        connectionId: connection.id,
        deliveryKey: 'nw-1',
        eventType: 'jira:issue_updated',
        jiraIssueId: '50001',
        status: 'FAILED',
      },
    });
    foreign = {
      connectionId: connection.id,
      mappingId: mapping.id,
      issueId: issue.id,
      runId: run.id,
      deliveryId: delivery.id,
      memberId: member.memberId,
    };
  });

  it('never returns another organization’s rows through the services', async () => {
    expect((await s.as(tm, () => admin.listMappings(tm))).some((m) => m.id === foreign.mappingId)).toBe(false);
    expect((await s.as(tm, () => admin.listRuns(tm, {}))).items.some((r) => r.id === foreign.runId)).toBe(false);
    expect((await s.as(tm, () => admin.failedDeliveries(tm))).some((d) => d.id === foreign.deliveryId)).toBe(false);
    await expect(s.as(tm, () => admin.getRun(tm, foreign.runId))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(tm, () => admin.cancelRun(tm, foreign.runId))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(tm, () => admin.updateMapping(tm, foreign.mappingId, { version: 1, syncEnabled: false })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(tm, () => admin.removeMapping(tm, foreign.mappingId, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(tm, () => connections.disconnect(tm, foreign.connectionId, 1))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const ticket = await report(tier, 'IHD', 'Isolation probe');
    await expect(
      s.as(agent, () => links.link(agent, ticket.id, { issueId: foreign.issueId, linkType: 'RELATED' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await s.as(agent, () => links.search(agent, ticket.id, { q: 'Northwind', source: 'cache' }))).length).toBe(
      0,
    );
    expect(await system(() => processor.process(foreign.deliveryId))).toBe('duplicate');
    expect(await system(() => engine.runSlice(foreign.runId))).toEqual({ kind: 'skipped' });
    expect(await system(() => registrar.sync(foreign.connectionId))).toBe('inactive');
    expect(await system(() => registrar.cleanup(foreign.connectionId))).toBe('skipped');
  });

  it('rejects cross-organization references in every Jira table (composite foreign keys)', async () => {
    const demo = s.demoId;
    const ticket = await s.prisma.supportTicket.findFirstOrThrow({
      where: { organizationId: demo },
      select: { id: true },
    });
    const ihd = await projectId('IHD');
    const fk = { code: 'P2003' };
    await expect(
      s.prisma.jiraConnection.create({
        data: {
          organizationId: demo,
          cloudId: 'x-cloud',
          siteUrl: 'https://x',
          siteName: 'x',
          status: 'DISCONNECTED',
          disconnectedAt: new Date(),
          connectedByMemberId: foreign.memberId,
        },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraProjectMapping.create({
        data: {
          organizationId: demo,
          connectionId: foreign.connectionId,
          projectId: ihd,
          jiraProjectId: '1',
          jiraProjectKey: 'X',
          jiraProjectName: 'X',
        },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraIssue.create({
        data: {
          organizationId: demo,
          connectionId: connectionId,
          mappingId: foreign.mappingId,
          jiraIssueId: '77777',
          issueKey: 'X-1',
          jiraProjectId: '1',
          summary: 'x',
          issueType: 'Bug',
          statusName: 'x',
          statusCategory: 'TODO',
          jiraCreatedAt: new Date(),
          jiraUpdatedAt: new Date(),
          url: 'https://x',
          syncHash: 'x',
        },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraSyncRun.create({
        data: { organizationId: demo, connectionId, mappingId: foreign.mappingId, type: 'RECONCILIATION' },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraSyncFailure.create({
        data: { organizationId: demo, runId: foreign.runId, errorCode: 'x', classification: 'PERMANENT', message: 'x' },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraWebhookRegistration.create({
        data: {
          organizationId: demo,
          connectionId: foreign.connectionId,
          jiraWebhookId: '9',
          jqlFilter: 'x',
          events: ['jira:issue_updated'],
          expiresAt: new Date(),
        },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraWebhookDelivery.create({
        data: { organizationId: demo, connectionId: foreign.connectionId, deliveryKey: 'x', eventType: 'x' },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.supportTicketJiraLink.create({
        data: {
          organizationId: demo,
          ticketId: ticket.id,
          issueId: foreign.issueId,
          linkType: 'RELATED',
          createdVia: 'LINKED_EXISTING',
        },
      }),
    ).rejects.toMatchObject(fk);
    await expect(
      s.prisma.jiraIssueCreateRequest.create({
        data: {
          organizationId: demo,
          ticketId: ticket.id,
          idempotencyKey: randomUUID(),
          mappingId: foreign.mappingId,
          requestedByMemberId: agent.principal.memberId,
          requestHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject(fk);
  });

  it('refuses unscoped queries through the tenant guard', async () => {
    await expect(system(() => s.tenantDb.jiraIssue.findMany({ where: { issueKey: 'NW-1' } }))).rejects.toThrow();
    await expect(
      system(() => s.tenantDb.jiraConnection.findFirst({ where: { organizationId: s.northwindId } })),
    ).rejects.toThrow();
  });
});

describe('disconnect', () => {
  it('stops sync at once, cancels runs, then removes webhooks and wipes tokens in cleanup', async () => {
    const run = await s.as(tm, () => admin.requestRun(tm, ihdMappingId, 'RECONCILIATION'));
    const current = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const view = await s.as(tm, () => connections.disconnect(tm, connectionId, current.version));
    expect(view.status).toBe('DISCONNECTED');
    expect((await runRow(run.id)).status).toBe('CANCELLED');
    const [delivered] = await fake.emitWebhook('OPS-3', 'jira:issue_updated');
    expect(delivered?.status).toBe(404);
    expect(await system(() => registrar.cleanup(connectionId))).toBe('cleaned');
    expect(fake.webhooks.size).toBe(0);
    const row = await s.prisma.jiraConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null });
    expect(await s.prisma.jiraIssue.count({ where: { connectionId } })).toBeGreaterThan(0);
    expect((await s.as(tm, () => connections.status(tm))).connection).toBeNull();
  });

  it('a cleanup racing a reconnect never removes webhooks registered after the disconnect', async () => {
    const later = await s.prisma.jiraWebhookRegistration.create({
      data: {
        organizationId: s.demoId,
        connectionId,
        jiraWebhookId: '777001',
        jqlFilter: 'project in (20001)',
        events: ['jira:issue_updated'],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const requestsBefore = fake.requests.length;
    await system(() => registrar.cleanup(connectionId));
    expect(await s.prisma.jiraWebhookRegistration.findUnique({ where: { id: later.id } })).not.toBeNull();
    expect(
      fake.requests
        .slice(requestsBefore)
        .filter((request) => request.startsWith('DELETE') && request.includes('webhook')),
    ).toEqual([]);
  });
});
