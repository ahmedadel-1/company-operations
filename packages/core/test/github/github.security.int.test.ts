import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { GithubAdminService } from '../../src/modules/github/github-admin.service.js';
import { loadAppPrivateKey, webhookSignature } from '../../src/modules/github/github-crypto.js';
import {
  GithubInstallationConflictError,
  GithubInstallationInactiveError,
  GithubSetupInvalidError,
  GithubSyncInProgressError,
} from '../../src/modules/github/github-errors.js';
import { GithubInstallationSync } from '../../src/modules/github/github-installations.js';
import { GithubProjectService } from '../../src/modules/github/github-project.service.js';
import { createGithubRuntime } from '../../src/modules/github/github-runtime.js';
import type { GithubRuntime } from '../../src/modules/github/github-runtime.js';
import { GithubScheduler } from '../../src/modules/github/github-scheduler.js';
import { GithubSetupService } from '../../src/modules/github/github-setup.service.js';
import { GithubSyncEngine } from '../../src/modules/github/github-sync-engine.js';
import type { GithubSliceOutcome } from '../../src/modules/github/github-sync-engine.js';
import { GithubTicketService } from '../../src/modules/github/github-ticket.service.js';
import { GithubWebhookIntake, GithubWebhookProcessor } from '../../src/modules/github/github-webhooks.js';
import { InMemoryKeyValueStore } from '../../src/modules/jira/jira-coordination.js';
import { RetentionPolicyService, RetentionPurger } from '../../src/modules/retention/retention.service.js';
import { TicketService } from '../../src/modules/support/ticket.service.js';
import { EnvelopeCipher } from '../../src/platform/crypto/envelope-cipher.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/platform/errors.js';
import { FakeGithub } from '../../src/testing/fake-github.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * The GitHub App integration end to end against PostgreSQL 18 (real migrations, development seed)
 * and the deterministic GitHub double (no network): verified installation setup, repository
 * discovery and renames, mappings, initial sync and reconciliation, signed webhooks with dedupe and
 * replay, out-of-order protection, review/check summaries, Jira key inference, manual links, the
 * ticket panel, installation and repository lifecycle, rate limits, retention, secret hygiene and
 * tenant isolation of every GitHub table.
 *
 * Actors (seed): EMP-00006 technical manager (integration.manage, github.* at ORG), EMP-00001 org
 * admin (integration.manage, org.settings.manage, github.view), EMP-00041 project manager of IHD
 * (github.* and jira.* at PROJECT), EMP-00002 general manager (github.view), EMP-00019 support agent
 * on IHD (no GitHub permissions), EMP-00024 field employee on TMP, EMP-00004 employee.
 */
const APP_ID = '123456';
const CLIENT_ID = 'Iv23liFakeClient';
const CLIENT_SECRET = 'fake-client-secret-for-tests';
const WEBHOOK_SECRET = 'fake-webhook-secret-for-tests';
const PUBLIC_URL = 'http://localhost:3000';
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const DAY = 24 * 60 * 60 * 1000;

let s: SeededDatabase;
let fake: FakeGithub;
let runtime: GithubRuntime;
let setup: GithubSetupService;
let admin: GithubAdminService;
let installSync: GithubInstallationSync;
let engine: GithubSyncEngine;
let processor: GithubWebhookProcessor;
let intake: GithubWebhookIntake;
let projects: GithubProjectService;
let tickets: GithubTicketService;
let supportTickets: TicketService;
let scheduler: GithubScheduler;
let retention: RetentionPolicyService;
let purger: RetentionPurger;
let skewMs = 0;
const issuedTokens: string[] = [];

let tm: ActionContext;
let orgAdmin: ActionContext;
let pm: ActionContext;
let gm: ActionContext;
let tier: ActionContext;
let field: ActionContext;
let employee: ActionContext;

let installationId: string;
let opsRepoId: string;
let mobileRepoId: string;
let ihdId: string;
let tmpId: string;
let opsIssueId: string;
let mobIssueId: string;

const system = <T>(fn: () => PromiseLike<T>): Promise<T> => s.asSystem(s.demoId, fn);

const projectId = async (code: string): Promise<string> =>
  (await s.prisma.project.findFirstOrThrow({ where: { organizationId: s.demoId, code }, select: { id: true } })).id;

async function install(actor: ActionContext, session: string, githubId = 1001): Promise<string> {
  fake.pendingInstallationId = githubId;
  const { installUrl } = await s.as(actor, () => setup.startInstall(actor, session));
  const installed = await fake.fetch(installUrl, { redirect: 'manual' });
  const back = new URL(installed.headers.get('location') ?? '');
  const step = await s.as(actor, () =>
    setup.handleSetup(actor, session, {
      installationId: back.searchParams.get('installation_id'),
      setupAction: back.searchParams.get('setup_action'),
      state: back.searchParams.get('state'),
    }),
  );
  if (step.kind !== 'authorize') {
    throw new Error(`expected the authorize step, got ${step.kind}`);
  }
  const authorized = await fake.fetch(step.url, { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location') ?? '');
  const result = await s.as(actor, () =>
    setup.completeCallback(actor, session, {
      code: callback.searchParams.get('code') ?? '',
      state: callback.searchParams.get('state') ?? '',
    }),
  );
  return result.installationId;
}

async function activeRun(repositoryId: string): Promise<string> {
  return (
    await s.prisma.githubSyncRun.findFirstOrThrow({
      where: { repositoryId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    })
  ).id;
}

async function drain(runId: string): Promise<GithubSliceOutcome> {
  for (let slice = 0; slice < 80; slice += 1) {
    const outcome = await system(() => engine.runSlice(runId));
    if (outcome.kind !== 'continue') {
      return outcome;
    }
  }
  throw new Error('the run did not finish');
}

async function pull(repositoryId: string, number: number) {
  return s.prisma.githubPullRequest.findFirstOrThrow({ where: { organizationId: s.demoId, repositoryId, number } });
}

async function delivery(deliveryId: string) {
  return s.prisma.githubWebhookDelivery.findFirstOrThrow({ where: { deliveryId } });
}

async function processDelivery(deliveryId: string) {
  const row = await delivery(deliveryId);
  return system(() => processor.process(row.id));
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await s.prisma.auditLog.findMany({
    where: { organizationId: s.demoId, entityId },
    select: { action: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  s = await startSeededDatabase();
  fake = new FakeGithub({
    privateKeyPem: PEM,
    appId: APP_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    slug: 'company-ops-test',
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: `${PUBLIC_URL}/api/v1/webhooks/github`,
    setupUrl: `${PUBLIC_URL}/api/v1/integrations/github/setup`,
    deliver: async (_url, init) => {
      const headers = new Headers(init.headers);
      const result = await intake.receive({
        signature: headers.get('x-hub-signature-256') ?? undefined,
        event: headers.get('x-github-event') ?? undefined,
        deliveryId: headers.get('x-github-delivery') ?? undefined,
        targetType: headers.get('x-github-hook-installation-target-type') ?? undefined,
        rawBody: Buffer.from(typeof init.body === 'string' ? init.body : ''),
      });
      return new Response(JSON.stringify(result), { status: result.status });
    },
  });
  const capture = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await fake.fetch(url, init);
    if (url.includes('/access_tokens') && response.ok) {
      const body: unknown = await response.clone().json();
      if (typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string') {
        issuedTokens.push(body.token);
      }
    }
    return response;
  };
  runtime = createGithubRuntime({
    settings: {
      appId: APP_ID,
      clientId: CLIENT_ID,
      privateKey: loadAppPrivateKey(PEM),
      clientSecret: CLIENT_SECRET,
      slug: 'company-ops-test',
      webhookSecret: WEBHOOK_SECRET,
      apiBaseUrl: 'http://fake-github.test',
      webBaseUrl: 'http://fake-github.test',
      publicUrl: PUBLIC_URL,
    },
    fetch: capture,
    kv: new InMemoryKeyValueStore(() => Date.now() + skewMs),
    cipher: new EnvelopeCipher({ id: 'k1', key: randomBytes(32) }),
    http: { sleep: () => Promise.resolve(), maxRetries: 1, timeoutMs: 5_000 },
    now: () => Date.now() + skewMs,
  });
  setup = new GithubSetupService(s.prisma, s.tenantDb, s.tenant, runtime);
  admin = new GithubAdminService(s.tenantDb, s.tenant, runtime);
  installSync = new GithubInstallationSync(s.tenantDb, s.tenant, runtime);
  engine = new GithubSyncEngine(s.tenantDb, s.tenant, runtime, () => Promise.resolve(), { maxPagesPerSlice: 2 });
  processor = new GithubWebhookProcessor(s.tenantDb, s.tenant, runtime, installSync);
  intake = new GithubWebhookIntake(s.prisma, s.tenantDb, s.tenant, WEBHOOK_SECRET);
  projects = new GithubProjectService(s.tenantDb, s.tenant, true);
  tickets = new GithubTicketService(s.tenantDb, s.tenant);
  supportTickets = new TicketService(s.tenantDb, s.tenant);
  scheduler = new GithubScheduler(s.prisma, s.tenantDb, s.tenant, (_organizationId, error) => {
    throw error;
  });
  retention = new RetentionPolicyService(s.tenantDb, s.tenant);
  purger = new RetentionPurger(s.prisma, s.tenantDb, s.tenant, (_organizationId, error) => {
    throw error;
  });
  tm = await s.actionFor('EMP-00006');
  orgAdmin = await s.actionFor('EMP-00001');
  pm = await s.actionFor('EMP-00041');
  gm = await s.actionFor('EMP-00002');
  tier = await s.actionFor('EMP-00019');
  field = await s.actionFor('EMP-00024');
  employee = await s.actionFor('EMP-00004');
  ihdId = await projectId('IHD');
  tmpId = await projectId('TMP');

  // Jira cache: OPS (mapped to IHD) has OPS-1 cached; MOB (mapped to TMP) has MOB-5 cached.
  const connection = await s.prisma.jiraConnection.create({
    data: {
      organizationId: s.demoId,
      cloudId: 'demo-cloud',
      siteUrl: 'https://demo.atlassian.net',
      siteName: 'Demo',
      status: 'DISCONNECTED',
      disconnectedAt: new Date(),
      connectedByMemberId: tm.principal.memberId,
    },
  });
  const issue = async (mappingId: string, jiraProjectId: string, key: string, summary: string) =>
    s.prisma.jiraIssue.create({
      data: {
        organizationId: s.demoId,
        connectionId: connection.id,
        mappingId,
        jiraIssueId: String(60000 + Number(key.split('-')[1])) + jiraProjectId,
        issueKey: key,
        jiraProjectId,
        summary,
        issueType: 'Bug',
        statusName: 'In Progress',
        statusCategory: 'IN_PROGRESS',
        jiraCreatedAt: new Date(),
        jiraUpdatedAt: new Date(),
        url: `https://demo.atlassian.net/browse/${key}`,
        syncHash: 'x',
      },
    });
  const ops = await s.prisma.jiraProjectMapping.create({
    data: {
      organizationId: s.demoId,
      connectionId: connection.id,
      projectId: ihdId,
      jiraProjectId: '41001',
      jiraProjectKey: 'OPS',
      jiraProjectName: 'Operations',
    },
  });
  const mob = await s.prisma.jiraProjectMapping.create({
    data: {
      organizationId: s.demoId,
      connectionId: connection.id,
      projectId: tmpId,
      jiraProjectId: '41002',
      jiraProjectKey: 'MOB',
      jiraProjectName: 'Mobile',
    },
  });
  opsIssueId = (await issue(ops.id, '41001', 'OPS-1', 'Safari login loop')).id;
  await issue(ops.id, '41001', 'OPS-7', 'Export is slow');
  mobIssueId = (await issue(mob.id, '41002', 'MOB-5', 'Push notifications')).id;
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('installation setup', () => {
  it('requires integration.manage at organization scope', async () => {
    for (const actor of [gm, pm, field, employee]) {
      await expect(s.as(actor, () => setup.startInstall(actor, 'sess'))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('never binds an installation from a bare or forged installation_id', async () => {
    await expect(
      s.as(tm, () => setup.handleSetup(tm, 'sess-tm', { installationId: '1001', setupAction: 'install', state: null })),
    ).rejects.toBeInstanceOf(GithubSetupInvalidError);
    await expect(
      s.as(tm, () =>
        setup.handleSetup(tm, 'sess-tm', { installationId: '1001 OR 1=1', setupAction: 'install', state: 'x' }),
      ),
    ).rejects.toBeInstanceOf(GithubSetupInvalidError);
    // A state issued to another member, or to another browser session, does not work.
    const { installUrl } = await s.as(orgAdmin, () => setup.startInstall(orgAdmin, 'sess-admin'));
    const state = new URL(installUrl).searchParams.get('state');
    await expect(
      s.as(tm, () => setup.handleSetup(tm, 'sess-tm', { installationId: '1001', setupAction: 'install', state })),
    ).rejects.toBeInstanceOf(GithubSetupInvalidError);
    const own = new URL((await s.as(tm, () => setup.startInstall(tm, 'sess-tm'))).installUrl).searchParams.get('state');
    await expect(
      s.as(tm, () =>
        setup.handleSetup(tm, 'sess-other', { installationId: '1001', setupAction: 'install', state: own }),
      ),
    ).rejects.toBeInstanceOf(GithubSetupInvalidError);
    expect(await s.prisma.githubInstallation.count({ where: { organizationId: s.demoId } })).toBe(0);
  });

  it('refuses when the signed-in GitHub user cannot access the installation, and revokes the user token', async () => {
    fake.currentUser = 'someone-else';
    const revoked = fake.revokedUserTokens;
    await expect(install(tm, 'sess-tm')).rejects.toBeInstanceOf(GithubSetupInvalidError);
    expect(fake.revokedUserTokens).toBe(revoked + 1);
    fake.currentUser = 'octo-admin';
    expect(await s.prisma.githubInstallation.count({ where: { organizationId: s.demoId } })).toBe(0);
  });

  it('binds a verified installation to exactly one organization, audited', async () => {
    installationId = await install(tm, 'sess-tm');
    const row = await s.prisma.githubInstallation.findFirstOrThrow({ where: { id: installationId } });
    expect(row).toMatchObject({
      organizationId: s.demoId,
      githubInstallationId: 1001n,
      accountLogin: 'acme-org',
      accountType: 'ORGANIZATION',
      repositorySelection: 'SELECTED',
      status: 'ACTIVE',
      installedByMemberId: tm.principal.memberId,
    });
    expect(await auditActions(installationId)).toContain('github.installation.bound');
    // The setup state is single use: replaying the callback cannot bind anything again.
    const outbox = await s.prisma.outboxEvent.count({
      where: { organizationId: s.demoId, eventType: 'github.installation.sync', aggregateId: installationId },
    });
    expect(outbox).toBe(1);
  });

  it('refuses an installation already bound to another organization', async () => {
    const nwMember = await s.employee('NW-001', s.northwindId);
    await s.prisma.githubInstallation.create({
      data: {
        organizationId: s.northwindId,
        githubInstallationId: 2002n,
        accountId: 6002n,
        accountLogin: 'other-org',
        accountType: 'ORGANIZATION',
        repositorySelection: 'ALL',
        installedByMemberId: nwMember.memberId,
      },
    });
    fake.installations.get(2002)?.userLogins.push('octo-admin');
    await expect(install(tm, 'sess-tm', 2002)).rejects.toBeInstanceOf(GithubInstallationConflictError);
    expect(await s.prisma.githubInstallation.count({ where: { githubInstallationId: 2002n } })).toBe(1);
  });

  it('discovers repositories keyed by their immutable id', async () => {
    expect(await system(() => installSync.sync(installationId))).toBe('synced');
    const repos = await s.prisma.githubRepository.findMany({
      where: { organizationId: s.demoId },
      orderBy: { githubRepoId: 'asc' },
    });
    expect(repos.map((repo) => repo.fullName)).toEqual([
      'acme-org/ops-platform',
      'acme-org/mobile-app',
      'acme-org/website',
    ]);
    opsRepoId = repos[0]?.id ?? '';
    mobileRepoId = repos[1]?.id ?? '';
    const status = await s.as(tm, () => admin.status(tm));
    expect(status.installations).toHaveLength(1);
    expect(JSON.stringify(status)).not.toMatch(/BEGIN|PRIVATE KEY|ghs_|fake-webhook-secret|fake-client-secret/);
  });
});

describe('repository mappings', () => {
  it('maps repositories to projects (many-to-many) for authorized administrators only', async () => {
    await expect(
      s.as(pm, () => admin.createMapping(pm, { repositoryId: opsRepoId, projectId: ihdId })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await s.as(tm, () => admin.createMapping(tm, { repositoryId: opsRepoId, projectId: ihdId }));
    await s.as(tm, () => admin.createMapping(tm, { repositoryId: mobileRepoId, projectId: ihdId }));
    await expect(
      s.as(tm, () => admin.createMapping(tm, { repositoryId: opsRepoId, projectId: ihdId })),
    ).rejects.toBeInstanceOf(ConflictError);
    const runs = await s.prisma.githubSyncRun.findMany({ where: { organizationId: s.demoId } });
    expect(runs.map((run) => run.type).sort()).toEqual(['INITIAL_SYNC', 'INITIAL_SYNC']);
    await expect(s.as(tm, () => admin.requestSync(tm, opsRepoId))).rejects.toBeInstanceOf(GithubSyncInProgressError);
  });
});

describe('initial sync', () => {
  it('imports open pull requests and the 90-day history with review and check summaries', async () => {
    fake.addPull({
      repoId: 7001,
      title: 'Ancient cleanup',
      state: 'closed',
      created: Date.now() - 200 * DAY,
      headRef: 'chore/old',
    });
    fake.addPull({ repoId: 7001, title: 'MOB-5 share push token handling', headRef: 'feature/push' });
    for (let i = 0; i < 130; i += 1) {
      fake.addPull({ repoId: 7002, title: `Mobile change ${String(i)}`, state: 'closed', created: Date.now() - DAY });
    }
    const tokensBefore = fake.tokensIssued;
    expect(await drain(await activeRun(opsRepoId))).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(await drain(await activeRun(mobileRepoId))).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    expect(fake.tokensIssued - tokensBefore).toBeLessThanOrEqual(1);

    const numbers = (
      await s.prisma.githubPullRequest.findMany({ where: { repositoryId: opsRepoId }, select: { number: true } })
    ).map((row) => row.number);
    expect(numbers.sort()).toEqual([1, 2, 3, 5]);
    expect(await s.prisma.githubPullRequest.count({ where: { repositoryId: mobileRepoId } })).toBe(130);

    const first = await pull(opsRepoId, 1);
    expect(first).toMatchObject({ state: 'OPEN', reviewState: 'REVIEW_REQUIRED', checksState: 'SUCCESS' });
    expect((await pull(opsRepoId, 2)).checksState).toBe('PENDING');
    expect((await pull(opsRepoId, 3)).state).toBe('MERGED');
    const repo = await s.prisma.githubRepository.findUniqueOrThrow({ where: { id: opsRepoId } });
    expect(repo.syncState).toBe('COMPLETED');
    expect(repo.lastFullSyncAt).not.toBeNull();
  });

  it('confirms only verified Jira keys and keeps the rest as suggestions', async () => {
    const first = await pull(opsRepoId, 1);
    expect(first.jiraKeys).toEqual(['OPS-1']);
    const links = await s.prisma.githubPrJiraLink.findMany({ where: { pullRequestId: first.id } });
    expect(links).toEqual([
      expect.objectContaining({ issueId: opsIssueId, state: 'CONFIRMED', source: 'BRANCH_NAME' }),
    ]);
    // OPS-2 is mentioned but not cached: an unverified key, never a link and never an invented issue.
    const second = await pull(opsRepoId, 2);
    expect(second.jiraKeys).toEqual(['OPS-2']);
    expect(await s.prisma.githubPrJiraLink.count({ where: { pullRequestId: second.id } })).toBe(0);
    // MOB-5 is cached but belongs to another project's Jira mapping: a suggestion only.
    const cross = await pull(opsRepoId, 5);
    expect(await s.prisma.githubPrJiraLink.findMany({ where: { pullRequestId: cross.id } })).toEqual([
      expect.objectContaining({ issueId: mobIssueId, state: 'SUGGESTED', source: 'TITLE' }),
    ]);
  });

  it('shows the project tab from the cache with signals, and only to project members', async () => {
    const overview = await s.as(pm, () => projects.overview(pm, ihdId));
    expect(overview.repositories.map((repo) => repo.fullName).sort()).toEqual([
      'acme-org/mobile-app',
      'acme-org/ops-platform',
    ]);
    expect(overview.signals).toMatchObject({ open: 3, draft: 1 });
    expect(overview.canLink).toBe(true);
    const requests = fake.requests.length;
    await s.as(pm, () => projects.listPulls(pm, ihdId, { state: 'MERGED' }));
    expect(fake.requests.length).toBe(requests);
    await expect(s.as(field, () => projects.overview(field, tmpId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(field, () => projects.overview(field, ihdId))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(employee, () => projects.overview(employee, ihdId))).rejects.toSatisfy(
      (error) => error instanceof NotFoundError || error instanceof ForbiddenError,
    );
  });
});

describe('webhooks', () => {
  it('rejects missing, wrong and altered signatures before storing anything', async () => {
    const before = await s.prisma.githubWebhookDelivery.count();
    const valid = await fake.emitPullRequest(7001, 1, 'edited', {});
    expect(valid.status).toBe(202);
    expect(await processDelivery(valid.deliveryId)).toBe('pull_unchanged');
    expect(
      (await fake.sendWebhook('pull_request', { action: 'opened', installation: { id: 1001 } }, { signature: null }))
        .status,
    ).toBe(401);
    expect(
      (await fake.sendWebhook('pull_request', { action: 'opened', installation: { id: 1001 } }, { secret: 'wrong' }))
        .status,
    ).toBe(401);
    expect(
      (await fake.sendWebhook('pull_request', { action: 'opened', installation: { id: 1001 } }, { tamper: true }))
        .status,
    ).toBe(401);
    expect(
      (
        await fake.sendWebhook(
          'pull_request',
          { action: 'opened', installation: { id: 1001 } },
          { signature: `sha1=${'0'.repeat(40)}` },
        )
      ).status,
    ).toBe(401);
    expect(await s.prisma.githubWebhookDelivery.count()).toBe(before + 1);
  });

  it('rejects malformed payloads and headers', async () => {
    const raw = Buffer.from('{not json');
    const base = { event: 'pull_request', deliveryId: 'malformed-1', targetType: 'integration' };
    expect(await intake.receive({ ...base, rawBody: raw, signature: webhookSignature(WEBHOOK_SECRET, raw) })).toEqual({
      status: 400,
      outcome: 'invalid_payload',
    });
    const body = Buffer.from(JSON.stringify({ installation: { id: 'not-a-number' } }));
    expect(
      (await intake.receive({ ...base, rawBody: body, signature: webhookSignature(WEBHOOK_SECRET, body) })).status,
    ).toBe(400);
    const ok = Buffer.from(JSON.stringify({ installation: { id: 1001 } }));
    expect(
      (
        await intake.receive({
          ...base,
          deliveryId: 'bad id with spaces',
          rawBody: ok,
          signature: webhookSignature(WEBHOOK_SECRET, ok),
        })
      ).status,
    ).toBe(400);
  });

  it('ignores unknown installations, unsupported events and repositories outside the installation', async () => {
    const unknown = await fake.sendWebhook('pull_request', {
      action: 'opened',
      installation: { id: 999_999 },
      repository: { id: 7001 },
      pull_request: { number: 1 },
    });
    expect(unknown.status).toBe(200);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { deliveryId: unknown.deliveryId } })).toBe(0);
    const unsupported = await fake.sendWebhook('issues', { action: 'opened', installation: { id: 1001 } });
    expect(unsupported.status).toBe(200);
    expect(await delivery(unsupported.deliveryId)).toMatchObject({ status: 'IGNORED', outcome: 'unsupported_event' });
    // A delivery for Northwind's installation naming a demo repository: stored under Northwind, ignored.
    const foreign = await fake.sendWebhook('pull_request', {
      action: 'opened',
      installation: { id: 2002 },
      repository: { id: 7001 },
      pull_request: { number: 1 },
    });
    expect(foreign.status).toBe(200);
    expect(await delivery(foreign.deliveryId)).toMatchObject({
      organizationId: s.northwindId,
      status: 'IGNORED',
      outcome: 'unknown_repository',
    });
    const docs = fake.addPull({ repoId: 7003, title: 'Docs update' });
    const unmapped = await fake.emitPullRequest(7003, docs.number, 'opened');
    expect(await delivery(unmapped.deliveryId)).toMatchObject({ status: 'IGNORED', outcome: 'unmapped' });
  });

  it('deduplicates by X-GitHub-Delivery and never applies a replay twice', async () => {
    fake.updatePull(7001, 1, { title: 'Fix Safari login redirect (v2)' });
    const sent = await fake.emitPullRequest(7001, 1, 'edited');
    expect(sent.status).toBe(202);
    expect((await fake.emitPullRequest(7001, 1, 'edited', { deliveryId: sent.deliveryId })).status).toBe(200);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { deliveryId: sent.deliveryId } })).toBe(1);
    expect(await processDelivery(sent.deliveryId)).toBe('pull_updated');
    expect((await pull(opsRepoId, 1)).title).toBe('Fix Safari login redirect (v2)');
    expect(await processDelivery(sent.deliveryId)).toBe('duplicate');
    const replay = await fake.emitPullRequest(7001, 1, 'edited', { deliveryId: sent.deliveryId });
    expect(JSON.parse(replay.body)).toEqual({ status: 200, outcome: 'duplicate' });
  });

  it('re-queues a manual redelivery of a delivery whose processing failed', async () => {
    const sent = await fake.emitPullRequest(7001, 2, 'synchronize');
    fake.fail({ match: 'GET /repos/acme-org/ops-platform/pulls/2', kind: 'server_error', times: 2 });
    await expect(processDelivery(sent.deliveryId)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await delivery(sent.deliveryId)).toMatchObject({ status: 'FAILED', errorCode: 'github_unavailable' });
    expect(
      JSON.parse((await fake.emitPullRequest(7001, 2, 'synchronize', { deliveryId: sent.deliveryId })).body),
    ).toEqual({ status: 202, outcome: 'queued' });
    expect(await processDelivery(sent.deliveryId)).toMatch(/^pull_(updated|unchanged)$/);
    expect((await delivery(sent.deliveryId)).status).toBe('PROCESSED');
  });

  it('never lets an older snapshot overwrite a newer one', async () => {
    const stored = await pull(opsRepoId, 1);
    const future = new Date(Date.now() + 365 * DAY);
    await s.prisma.githubPullRequest.update({ where: { id: stored.id }, data: { ghUpdatedAt: future } });
    fake.updatePull(7001, 1, { title: 'An older edit arriving late' });
    const sent = await fake.emitPullRequest(7001, 1, 'edited');
    expect(await processDelivery(sent.deliveryId)).toBe('pull_stale');
    const after = await pull(opsRepoId, 1);
    expect(after.title).toBe('Fix Safari login redirect (v2)');
    expect(after.ghUpdatedAt.getTime()).toBe(future.getTime());
    await s.prisma.githubPullRequest.update({ where: { id: stored.id }, data: { ghUpdatedAt: stored.ghUpdatedAt } });
  });

  it('updates the review summary from review events', async () => {
    fake.addReview(7001, 1, 'reviewer-one', 'CHANGES_REQUESTED');
    expect(await processDelivery((await fake.emitReview(7001, 1)).deliveryId)).toMatch(/^pull_/);
    expect((await pull(opsRepoId, 1)).reviewState).toBe('CHANGES_REQUESTED');
    fake.addReview(7001, 1, 'reviewer-one', 'APPROVED');
    await processDelivery((await fake.emitReview(7001, 1)).deliveryId);
    expect((await pull(opsRepoId, 1)).reviewState).toBe('APPROVED');
  });

  it('updates the checks summary from check and status events', async () => {
    const current = fake.findPull(7001, 1);
    if (current === null) {
      throw new Error('missing fake pull');
    }
    fake.setChecks(current.headSha, [{ status: 'completed', conclusion: 'failure' }], []);
    expect(await processDelivery((await fake.emitCheckRun(7001, current.headSha)).deliveryId)).toBe('checks_updated');
    expect((await pull(opsRepoId, 1)).checksState).toBe('FAILURE');
    fake.setChecks(current.headSha, [{ status: 'completed', conclusion: 'success' }], ['pending']);
    await processDelivery((await fake.emitStatus(7001, current.headSha, 'pending')).deliveryId);
    expect((await pull(opsRepoId, 1)).checksState).toBe('PENDING');
  });

  it('coalesces a backlog of check and review events into the refresh that already covers them', async () => {
    const current = fake.findPull(7001, 1);
    if (current === null) {
      throw new Error('missing fake pull');
    }
    const backdate = async (deliveryId: string) => {
      const row = await delivery(deliveryId);
      await s.prisma.githubWebhookDelivery.update({
        where: { id: row.id },
        data: { receivedAt: new Date(Date.now() - 60_000) },
      });
      return deliveryId;
    };
    const detailCalls = () => fake.requests.filter((line) => /\/(reviews|check-runs|status)\b/.test(line)).length;

    const before = detailCalls();
    expect(await processDelivery(await backdate((await fake.emitCheckRun(7001, current.headSha)).deliveryId))).toBe(
      'checks_current',
    );
    expect(await processDelivery(await backdate((await fake.emitReview(7001, 1)).deliveryId))).toMatch(/^pull_/);
    expect(detailCalls()).toBe(before);

    fake.setChecks(current.headSha, [{ status: 'completed', conclusion: 'success' }], []);
    expect(await processDelivery((await fake.emitCheckRun(7001, current.headSha)).deliveryId)).toBe('checks_updated');
    expect(detailCalls()).toBeGreaterThan(before);
    expect((await pull(opsRepoId, 1)).checksState).toBe('SUCCESS');
  });

  it('keeps one repository row across renames', async () => {
    fake.renameRepo(7001, 'ops-platform-next');
    expect(await processDelivery((await fake.emitRepository(7001, 'renamed')).deliveryId)).toBe('repository_updated');
    const rows = await s.prisma.githubRepository.findMany({ where: { organizationId: s.demoId, githubRepoId: 7001n } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: opsRepoId, fullName: 'acme-org/ops-platform-next' });
    fake.updatePull(7001, 2, { title: 'Speed up CSV export (renamed repo)' });
    await processDelivery((await fake.emitPullRequest(7001, 2, 'edited')).deliveryId);
    expect((await pull(opsRepoId, 2)).title).toBe('Speed up CSV export (renamed repo)');
  });
});

describe('reconciliation and rate limits', () => {
  it('reconciles what webhooks missed', async () => {
    fake.addPull({ repoId: 7001, title: 'Missed webhook OPS-7', headRef: 'fix/missed' });
    fake.updatePull(7001, 2, { draft: false });
    const totals = await scheduler.queueReconciliation(60_000, new Date(Date.now() + 60 * 60 * 1000));
    expect(totals.queued).toBe(2);
    const runId = await activeRun(opsRepoId);
    expect((await s.prisma.githubSyncRun.findUniqueOrThrow({ where: { id: runId } })).type).toBe('RECONCILIATION');
    expect(await drain(runId)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    const missed = await pull(opsRepoId, 6);
    expect(missed.jiraKeys).toEqual(['OPS-7']);
    expect((await pull(opsRepoId, 2)).draft).toBe(false);
    await drain(await activeRun(mobileRepoId));
  });

  it('pauses the installation on rate limits and resumes after the reset', async () => {
    const run = await s.as(tm, () => admin.requestSync(tm, opsRepoId));
    fake.fail({ match: '/pulls?', kind: 'secondary_rate_limit', times: 5, retryAfterSeconds: 2 });
    const limited = await system(() => engine.runSlice(run.id));
    expect(limited.kind).toBe('retry_later');
    expect(await runtime.coordination.pausedUntil(installationId)).not.toBeNull();
    expect((await system(() => engine.runSlice(run.id))).kind).toBe('retry_later');
    fake.failures.length = 0;
    skewMs += 3_000;
    expect(await drain(run.id)).toEqual({ kind: 'finished', status: 'SUCCEEDED' });
    skewMs = 0;
  });

  it('renews a rejected installation token once (401)', async () => {
    fake.expireInstallationTokens();
    fake.updatePull(7001, 1, { title: 'After token expiry' });
    await processDelivery((await fake.emitPullRequest(7001, 1, 'edited')).deliveryId);
    expect((await pull(opsRepoId, 1)).title).toBe('After token expiry');
  });

  it('records permanent per-record failures without failing the run', async () => {
    const run = await s.as(tm, () => admin.requestSync(tm, mobileRepoId));
    fake.fail({ match: 'GET /repos/acme-org/mobile-app/pulls?', kind: 'forbidden', times: 10 });
    const outcome = await drain(run.id);
    expect(outcome.kind).toBe('finished');
    const detail = await s.as(tm, () => admin.getRun(tm, run.id));
    expect(['FAILED', 'PARTIALLY_FAILED']).toContain(detail.run.status);
    expect(JSON.stringify(detail)).not.toMatch(/ghs_|Bearer|BEGIN/);
    fake.failures.length = 0;
  });
});

describe('manual links and the ticket panel', () => {
  let ticketId: string;

  it('lets project link managers confirm, dismiss and link cached issues of the same project only', async () => {
    const cross = await pull(opsRepoId, 5);
    const link = await s.prisma.githubPrJiraLink.findFirstOrThrow({ where: { pullRequestId: cross.id } });
    // MOB-5 belongs to TMP's Jira mapping: it cannot be confirmed from IHD.
    await expect(s.as(pm, () => projects.confirmLink(pm, ihdId, link.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(gm, () => projects.searchJiraIssues(gm, ihdId, 'OPS'))).rejects.toBeInstanceOf(ForbiddenError);
    const options = await s.as(pm, () => projects.searchJiraIssues(pm, ihdId, 'ops'));
    expect(options.map((option) => option.key).sort()).toEqual(['OPS-1', 'OPS-7']);
    const second = await pull(opsRepoId, 2);
    const ops7 = options.find((option) => option.key === 'OPS-7');
    const view = await s.as(pm, () => projects.linkJiraIssue(pm, ihdId, second.id, ops7?.id ?? ''));
    expect(view.jiraLinks.some((jira) => jira.state === 'CONFIRMED' && jira.source === 'MANUAL')).toBe(true);
    await expect(s.as(pm, () => projects.linkJiraIssue(pm, ihdId, second.id, ops7?.id ?? ''))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(s.as(pm, () => projects.linkJiraIssue(pm, ihdId, second.id, mobIssueId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await auditActions(second.id)).toContain('github.pr_link.linked');
    // A dismissed suggestion is never recreated by inference.
    const missed = await pull(opsRepoId, 6);
    const inferred = await s.prisma.githubPrJiraLink.findFirstOrThrow({ where: { pullRequestId: missed.id } });
    await s.as(pm, () => projects.dismissLink(pm, ihdId, inferred.id));
    fake.updatePull(7001, 6, { title: 'Missed webhook OPS-7 (edited)' });
    await processDelivery((await fake.emitPullRequest(7001, 6, 'edited')).deliveryId);
    expect((await s.prisma.githubPrJiraLink.findUniqueOrThrow({ where: { id: inferred.id } })).state).toBe('DISMISSED');
  });

  it('shows pull requests reached through Jira links and direct links on the ticket', async () => {
    const ticket = await s.as(tier, () =>
      supportTickets.create(tier, {
        title: 'Customers stuck in a Safari login loop',
        description: 'Customer cannot sign in.',
        severity: 'HIGH',
        impact: 'SINGLE_USER',
        projectId: ihdId,
        source: 'FIELD',
      }),
    );
    ticketId = ticket.id;
    await s.prisma.supportTicketJiraLink.create({
      data: {
        organizationId: s.demoId,
        ticketId,
        issueId: opsIssueId,
        linkType: 'RELATED',
        createdVia: 'LINKED_EXISTING',
      },
    });
    expect((await s.as(tier, () => tickets.panel(tier, ticketId))).visible).toBe(false);
    const panel = await s.as(pm, () => tickets.panel(pm, ticketId));
    expect(panel).toMatchObject({ visible: true, available: true, canLink: true });
    expect(panel.pulls.map((item) => [item.number, item.via])).toEqual([[1, ['JIRA']]]);
    const options = await s.as(pm, () => tickets.searchPulls(pm, ticketId, 'export'));
    const second = options.find((option) => option.number === 2);
    const linked = await s.as(pm, () => tickets.linkPull(pm, ticketId, second?.id ?? ''));
    expect(linked.pulls.find((item) => item.number === 2)?.via).toEqual(['MANUAL']);
    await expect(s.as(tier, () => tickets.linkPull(tier, ticketId, second?.id ?? ''))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  describe('tenant isolation', () => {
    let foreign: { repoId: string; pullId: string; runId: string; issueId: string; projectId: string };

    beforeAll(async () => {
      const org = s.northwindId;
      const nwInstallation = await s.prisma.githubInstallation.findFirstOrThrow({ where: { organizationId: org } });
      const repo = await s.prisma.githubRepository.create({
        data: {
          organizationId: org,
          installationId: nwInstallation.id,
          githubRepoId: 9001n,
          nodeId: 'R_nw',
          ownerLogin: 'other-org',
          name: 'secret',
          fullName: 'other-org/secret',
          private: true,
          htmlUrl: 'https://github.com/other-org/secret',
        },
      });
      const pr = await s.prisma.githubPullRequest.create({
        data: {
          organizationId: org,
          repositoryId: repo.id,
          githubPrId: 9001001n,
          nodeId: 'PR_nw',
          number: 1,
          title: 'Northwind secret change',
          state: 'OPEN',
          headRef: 'secret',
          baseRef: 'main',
          headSha: 'a'.repeat(40),
          htmlUrl: 'https://github.com/other-org/secret/pull/1',
          ghCreatedAt: new Date(),
          ghUpdatedAt: new Date(),
        },
      });
      const run = await s.prisma.githubSyncRun.create({
        data: { organizationId: org, installationId: nwInstallation.id, repositoryId: repo.id, type: 'INITIAL_SYNC' },
      });
      const nwProject = await s.prisma.project.create({
        data: { organizationId: org, number: 901, code: 'NWG', name: 'Northwind GitHub project' },
      });
      const connection = await s.prisma.jiraConnection.create({
        data: {
          organizationId: org,
          cloudId: 'nw-gh-cloud',
          siteUrl: 'https://nw.atlassian.net',
          siteName: 'NW',
          status: 'DISCONNECTED',
          disconnectedAt: new Date(),
        },
      });
      const mapping = await s.prisma.jiraProjectMapping.create({
        data: {
          organizationId: org,
          connectionId: connection.id,
          projectId: nwProject.id,
          jiraProjectId: '51001',
          jiraProjectKey: 'OPS',
          jiraProjectName: 'NW ops',
        },
      });
      const issue = await s.prisma.jiraIssue.create({
        data: {
          organizationId: org,
          connectionId: connection.id,
          mappingId: mapping.id,
          jiraIssueId: '99001',
          issueKey: 'OPS-1',
          jiraProjectId: '51001',
          summary: 'Northwind issue',
          issueType: 'Bug',
          statusName: 'To Do',
          statusCategory: 'TODO',
          jiraCreatedAt: new Date(),
          jiraUpdatedAt: new Date(),
          url: 'https://nw.atlassian.net/browse/OPS-1',
          syncHash: 'x',
        },
      });
      foreign = { repoId: repo.id, pullId: pr.id, runId: run.id, issueId: issue.id, projectId: nwProject.id };
    });

    it('never reads or changes another organization’s GitHub data through the services', async () => {
      await expect(
        s.as(tm, () => admin.createMapping(tm, { repositoryId: foreign.repoId, projectId: ihdId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        s.as(tm, () => admin.createMapping(tm, { repositoryId: opsRepoId, projectId: foreign.projectId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(s.as(tm, () => admin.getRun(tm, foreign.runId))).rejects.toBeInstanceOf(NotFoundError);
      await expect(s.as(tm, () => admin.requestSync(tm, foreign.repoId))).rejects.toBeInstanceOf(NotFoundError);
      const nwInstallation = await s.prisma.githubInstallation.findFirstOrThrow({
        where: { organizationId: s.northwindId },
      });
      await expect(s.as(tm, () => admin.disconnect(tm, nwInstallation.id, 1))).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await s.as(tm, () => admin.listRepositories(tm, { includeUnavailable: true }))).some(
          (repo) => repo.id === foreign.repoId,
        ),
      ).toBe(false);
      expect(
        (await s.as(tm, () => admin.listDeliveries(tm, {}))).items.some(
          (item) => item.event === 'pull_request' && item.outcome === 'unknown_repository',
        ),
      ).toBe(false);
      const second = await pull(opsRepoId, 2);
      await expect(
        s.as(pm, () => projects.linkJiraIssue(pm, ihdId, foreign.pullId, opsIssueId)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        s.as(pm, () => projects.linkJiraIssue(pm, ihdId, second.id, foreign.issueId)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(s.as(pm, () => tickets.linkPull(pm, ticketId, foreign.pullId))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await s.as(pm, () => tickets.searchPulls(pm, ticketId, 'secret'))).length).toBe(0);
      expect((await s.as(pm, () => projects.searchJiraIssues(pm, ihdId, 'Northwind'))).length).toBe(0);
      const pulls = await s.as(pm, () => projects.listPulls(pm, ihdId, {}));
      expect(pulls.items.some((item) => item.id === foreign.pullId)).toBe(false);
      expect(await system(() => engine.runSlice(foreign.runId))).toEqual({ kind: 'skipped' });
    });

    it('rejects cross-organization references in every GitHub table (composite foreign keys)', async () => {
      const demo = s.demoId;
      const fk = { code: 'P2003' };
      const second = await pull(opsRepoId, 2);
      await expect(
        s.prisma.githubRepositoryMapping.create({
          data: { organizationId: demo, repositoryId: foreign.repoId, projectId: ihdId },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubRepositoryMapping.create({
          data: { organizationId: demo, repositoryId: opsRepoId, projectId: foreign.projectId },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubPrJiraLink.create({
          data: {
            organizationId: demo,
            pullRequestId: second.id,
            issueId: foreign.issueId,
            source: 'MANUAL',
            state: 'CONFIRMED',
            decidedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubPrJiraLink.create({
          data: {
            organizationId: demo,
            pullRequestId: foreign.pullId,
            issueId: opsIssueId,
            source: 'MANUAL',
            state: 'CONFIRMED',
            decidedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.supportTicketGithubLink.create({
          data: { organizationId: demo, ticketId, pullRequestId: foreign.pullId },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubSyncRun.create({
          data: { organizationId: demo, installationId, repositoryId: foreign.repoId, type: 'RECONCILIATION' },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubSyncFailure.create({
          data: {
            organizationId: demo,
            runId: foreign.runId,
            errorCode: 'x',
            classification: 'PERMANENT',
            message: 'x',
          },
        }),
      ).rejects.toMatchObject(fk);
      await expect(
        s.prisma.githubPullRequest.create({
          data: {
            organizationId: demo,
            repositoryId: foreign.repoId,
            githubPrId: 1n,
            nodeId: 'x',
            number: 99,
            title: 'x',
            state: 'OPEN',
            headRef: 'x',
            baseRef: 'main',
            headSha: 'b'.repeat(40),
            htmlUrl: 'https://x',
            ghCreatedAt: new Date(),
            ghUpdatedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject(fk);
    });

    it('refuses unscoped queries through the tenant guard', async () => {
      await expect(system(() => s.tenantDb.githubPullRequest.findMany({ where: { number: 1 } }))).rejects.toThrow();
      await expect(
        system(() => s.tenantDb.githubInstallation.findFirst({ where: { organizationId: s.northwindId } })),
      ).rejects.toThrow();
    });
  });
});

describe('installation and repository lifecycle', () => {
  it('stops syncing a repository whose access was removed, keeping history and mappings', async () => {
    const before = await s.prisma.githubPullRequest.count({ where: { repositoryId: mobileRepoId } });
    fake.removeRepo(1001, 7002);
    expect(await processDelivery((await fake.emitInstallationRepositories(1001, 'removed', [7002])).deliveryId)).toBe(
      'installation_synced',
    );
    const repo = await s.prisma.githubRepository.findUniqueOrThrow({ where: { id: mobileRepoId } });
    expect(repo.status).toBe('REMOVED');
    expect(await s.prisma.githubPullRequest.count({ where: { repositoryId: mobileRepoId } })).toBe(before);
    expect(
      await s.prisma.githubRepositoryMapping.count({ where: { repositoryId: mobileRepoId, removedAt: null } }),
    ).toBe(1);
    const overview = await s.as(pm, () => projects.overview(pm, ihdId));
    expect(overview.repositories.find((item) => item.id === mobileRepoId)?.health).toBe('UNAVAILABLE');
    await expect(s.as(tm, () => admin.requestSync(tm, mobileRepoId))).rejects.toBeInstanceOf(
      GithubInstallationInactiveError,
    );
    const late = await fake.sendWebhook('pull_request', {
      action: 'edited',
      installation: { id: 1001 },
      repository: { id: 7002 },
      pull_request: { number: 1 },
    });
    expect(await delivery(late.deliveryId)).toMatchObject({ status: 'IGNORED', outcome: 'repository_unavailable' });
    expect(await auditActions(mobileRepoId)).toContain('github.repository.access_removed');
  });

  it('pauses everything while suspended and notifies administrators', async () => {
    fake.suspend(1001);
    expect(await processDelivery((await fake.emitInstallation(1001, 'suspend')).deliveryId)).toBe(
      'installation_suspended',
    );
    expect((await s.prisma.githubInstallation.findUniqueOrThrow({ where: { id: installationId } })).status).toBe(
      'SUSPENDED',
    );
    const notices = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, eventType: 'notification.requested', aggregateId: installationId },
      select: { payload: true },
    });
    const admins = await s.prisma.rolePermission.count({
      where: { organizationId: s.demoId, permissionKey: 'integration.manage', scope: 'ORG' },
    });
    expect(admins).toBeGreaterThan(0);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((notice) => JSON.stringify(notice.payload).includes('GITHUB_INSTALLATION_SUSPENDED'))).toBe(
      true,
    );
    const sent = await fake.emitPullRequest(7001, 1, 'edited');
    expect(await processDelivery(sent.deliveryId)).toBe('installation_inactive');
    expect((await s.as(pm, () => projects.overview(pm, ihdId))).repositories[0]?.health).toBe('SUSPENDED');
    fake.unsuspend(1001);
    expect(await processDelivery((await fake.emitInstallation(1001, 'unsuspend')).deliveryId)).toBe(
      'installation_synced',
    );
    expect((await s.prisma.githubInstallation.findUniqueOrThrow({ where: { id: installationId } })).status).toBe(
      'ACTIVE',
    );
  });

  it('applies retention to technical records only, audited, never to links or audit history', async () => {
    await expect(
      s.as(tm, () => retention.set(tm, 'WEBHOOK_DELIVERIES', { retainDays: 7, version: null })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await s.as(orgAdmin, () => retention.set(orgAdmin, 'WEBHOOK_DELIVERIES', { retainDays: 7, version: null }));
    await s.db.psql(
      'postgres',
      `UPDATE github_webhook_deliveries SET received_at = now() - interval '30 days' WHERE organization_id = '${s.demoId}';`,
    );
    const pending = await s.prisma.githubWebhookDelivery.create({
      data: { organizationId: s.demoId, installationId, deliveryId: 'still-pending', event: 'pull_request' },
    });
    await s.db.psql(
      'postgres',
      `UPDATE github_webhook_deliveries SET received_at = now() - interval '30 days' WHERE id = '${pending.id}';`,
    );
    const counts = async () => ({
      prLinks: await s.prisma.githubPrJiraLink.count(),
      ticketLinks: await s.prisma.supportTicketGithubLink.count(),
      ticketJira: await s.prisma.supportTicketJiraLink.count(),
      pulls: await s.prisma.githubPullRequest.count(),
      runs: await s.prisma.githubSyncRun.count(),
    });
    const before = await counts();
    const deliveriesBefore = await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.demoId } });
    const totals = await purger.purgeAll(500);
    expect(totals.purged).toBe(deliveriesBefore - 1);
    expect(await s.prisma.githubWebhookDelivery.findMany({ where: { organizationId: s.demoId } })).toEqual([
      expect.objectContaining({ id: pending.id }),
    ]);
    expect(await counts()).toEqual(before);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.northwindId } })).toBeGreaterThan(0);
    expect(await auditActions('WEBHOOK_DELIVERIES')).toEqual(['retention.policy.created', 'retention.records_purged']);
    const denied = await s.db.psql('ops_app', `DELETE FROM github_webhook_deliveries WHERE id = '${pending.id}';`);
    expect(denied.output).toMatch(/permission denied/);
    const auditDenied = await s.db.psql('ops_app', 'DELETE FROM audit_logs;');
    expect(auditDenied.output).toMatch(/permission denied|append-only/);
  });

  it('purges each organization only under its own policy and tenant context', async () => {
    const nwInstallation = await s.prisma.githubInstallation.findFirstOrThrow({
      where: { organizationId: s.northwindId },
      select: { id: true },
    });
    const aged = await s.prisma.githubWebhookDelivery.create({
      data: {
        organizationId: s.northwindId,
        installationId: nwInstallation.id,
        deliveryId: 'nw-aged',
        event: 'pull_request',
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });
    await s.db.psql(
      'postgres',
      `UPDATE github_webhook_deliveries SET received_at = now() - interval '30 days' WHERE id = '${aged.id}';`,
    );
    const demoBefore = await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.demoId } });
    const nwBefore = await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.northwindId } });

    // Northwind has no policy: its aged row survives the demo organization's purge.
    await purger.purgeAll(500);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { id: aged.id } })).toBe(1);

    // With its own policy, only Northwind's aged row goes; the demo organization is untouched.
    await s.prisma.retentionPolicy.create({
      data: { organizationId: s.northwindId, category: 'WEBHOOK_DELIVERIES', retainDays: 7 },
    });
    const totals = await purger.purgeAll(500);
    expect(totals).toMatchObject({ organizations: 2, failedOrganizations: 0 });
    expect(await s.prisma.githubWebhookDelivery.count({ where: { id: aged.id } })).toBe(0);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.northwindId } })).toBe(nwBefore - 1);
    expect(await s.prisma.githubWebhookDelivery.count({ where: { organizationId: s.demoId } })).toBe(demoBefore);
    const purgeAudits = await s.prisma.auditLog.findMany({
      where: { action: 'retention.records_purged', entityId: 'WEBHOOK_DELIVERIES' },
      select: { organizationId: true, metadata: true },
    });
    expect(purgeAudits.filter((row) => row.organizationId === s.northwindId)).toEqual([
      { organizationId: s.northwindId, metadata: { category: 'WEBHOOK_DELIVERIES', count: 1 } },
    ]);
  });

  it('marks an uninstalled installation deleted; history stays and nothing is remapped', async () => {
    fake.uninstall(1001);
    expect(await processDelivery((await fake.emitInstallation(1001, 'deleted')).deliveryId)).toBe(
      'installation_deleted',
    );
    const row = await s.prisma.githubInstallation.findUniqueOrThrow({ where: { id: installationId } });
    expect(row.status).toBe('DELETED');
    expect(await s.prisma.githubRepository.count({ where: { installationId, status: 'AVAILABLE' } })).toBe(0);
    expect(await s.prisma.githubPullRequest.count({ where: { repositoryId: opsRepoId } })).toBeGreaterThan(0);
    const late = await fake.sendWebhook('pull_request', {
      action: 'edited',
      installation: { id: 1001 },
      repository: { id: 7001 },
      pull_request: { number: 1 },
    });
    expect(await delivery(late.deliveryId)).toMatchObject({ status: 'IGNORED', outcome: 'installation_inactive' });
    await expect(s.as(tm, () => admin.refreshInstallation(tm, installationId))).rejects.toBeInstanceOf(
      GithubInstallationInactiveError,
    );
  });
});

describe('secret hygiene', () => {
  it('never persists installation tokens, the private key or the webhook secret anywhere', async () => {
    expect(issuedTokens.length).toBeGreaterThan(0);
    const keyBody = PEM.split('\n')[1] ?? 'unreachable';
    const needles = [...issuedTokens, keyBody, WEBHOOK_SECRET, CLIENT_SECRET, 'ghu_fake'];
    const tables = [
      'github_installations',
      'github_repositories',
      'github_repository_mappings',
      'github_pull_requests',
      'github_pr_jira_links',
      'github_webhook_deliveries',
      'github_sync_runs',
      'github_sync_failures',
      'support_ticket_github_links',
      'audit_logs',
      'outbox_events',
      'notifications',
      'project_activity',
    ];
    for (const table of tables) {
      for (const needle of needles) {
        const result = await s.db.psql(
          'postgres',
          `SELECT count(*) FROM ${table} t WHERE t::text LIKE '%' || $q$${needle}$q$ || '%';`,
        );
        expect(`${table}:${result.output.trim()}`).toBe(`${table}:0`);
      }
    }
  });
});
