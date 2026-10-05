import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeGithub, startFakeGithubServer } from '@company-ops/core/testing';
import type { FakeGithubServer } from '@company-ops/core/testing';
import {
  errorEnvelopeSchema,
  githubDeliveryPageResponseSchema,
  githubInstallResponseSchema,
  githubIntegrationStatusResponseSchema,
  githubProjectOverviewResponseSchema,
  githubRepositoryListResponseSchema,
  githubRepositoryResponseSchema,
  githubWebhookAckResponseSchema,
  retentionPolicyListResponseSchema,
  retentionPreviewResponseSchema,
  ticketGithubPanelResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 5 (GitHub) endpoints over real HTTP against the fake GitHub server: the verified
 * installation flow (redirects only, never tokens), MFA and permission gates, the HMAC-verified
 * webhook receiver on the exact raw body (size cap, CSRF exemption, dedupe), mappings, the project
 * tab, the ticket panel and retention policies. Bodies are validated against the shared contracts
 * and scanned for secrets.
 */
const APP_ID = '424242';
const CLIENT_ID = 'Iv23liApiTestClient';
const CLIENT_SECRET = 'api-test-github-client-secret-0123';
const WEBHOOK_SECRET = 'api-test-github-webhook-secret-0123';
const MAX_BYTES = 4096;
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY_LINE = PEM.split('\n')[1] ?? 'unreachable';

const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  technicalManager: 'seed-demo-emp-00006',
  tier: 'seed-demo-emp-00019',
  fieldTmp: 'seed-demo-emp-00024',
  pm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f0a',
} as const;

const concurrentQueryWarnings: string[] = [];
const onWarning = (warning: Error): void => {
  if (warning.message.includes('already executing a query')) {
    concurrentQueryWarnings.push(`${expect.getState().currentTestName ?? 'setup'}: ${warning.message}`);
  }
};
process.on('warning', onWarning);

let stack: ApiStack;
let fake: FakeGithub;
let fakeServer: FakeGithubServer;
let orgA: string;
let tm: TestSession;
let admin: TestSession;
let gm: TestSession;
let employee: TestSession;
let tier: TestSession;
let fieldTmp: TestSession;
let pm: TestSession;

function call(
  path: string,
  session: TestSession | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (session !== null) {
    headers.set('cookie', session.cookie);
    if (method !== 'GET' && init.csrf !== false) {
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
    redirect: 'manual',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(KEY_LINE);
  expect(text).not.toContain(WEBHOOK_SECRET);
  expect(text).not.toContain(CLIENT_SECRET);
  expect(text).not.toMatch(/ghs_|ghu_|BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
}

async function ok<T>(response: Response, schema: { parse(value: unknown): T }, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  assertNoSecrets(text);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack/i);
  assertNoSecrets(text);
  return envelope.error.code;
}

function redirectTarget(response: Response): URL {
  expect(response.status).toBe(302);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return new URL(response.headers.get('location') ?? '');
}

/** Drives GitHub's install page and user authorization the way a browser would. */
async function installFlow(session: TestSession, setupSession: TestSession = session): Promise<URL> {
  const { data } = await ok(
    await call('/integrations/github/install', session, { method: 'POST' }),
    githubInstallResponseSchema,
  );
  expect(data.installUrl.startsWith(fakeServer.url)).toBe(true);
  const installed = await fetch(data.installUrl, { redirect: 'manual' });
  const setupReturn = new URL(installed.headers.get('location') ?? '');
  expect(setupReturn.pathname).toBe('/api/v1/integrations/github/setup');
  const step = await call(`/integrations/github/setup${setupReturn.search}`, setupSession);
  const next = redirectTarget(step);
  if (next.origin === PUBLIC_URL) {
    return next;
  }
  const authorized = await fetch(next.toString(), { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location') ?? '');
  expect(callback.pathname).toBe('/api/v1/integrations/github/callback');
  return redirectTarget(await call(`/integrations/github/callback${callback.search}`, setupSession));
}

function signedPost(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${stack.baseUrl}/api/v1/webhooks/github`, {
    method: 'POST',
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
  });
}

const sign = (body: string): string => `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

const hookHeaders = (body: string, delivery: string, event = 'installation'): Record<string, string> => ({
  'content-type': 'application/json',
  'x-github-event': event,
  'x-github-delivery': delivery,
  'x-github-hook-installation-target-type': 'integration',
  'x-hub-signature-256': sign(body),
});

async function projectId(code: string): Promise<string> {
  return (await stack.prisma.project.findFirstOrThrow({ where: { organizationId: orgA, code }, select: { id: true } }))
    .id;
}

beforeAll(async () => {
  fake = new FakeGithub({
    privateKeyPem: PEM,
    appId: APP_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    slug: 'company-ops-api-test',
    webhookSecret: WEBHOOK_SECRET,
    setupUrl: `${PUBLIC_URL}/api/v1/integrations/github/setup`,
  });
  fakeServer = await startFakeGithubServer(fake);
  stack = await startApiStack({
    issuer: 'http://127.0.0.1:9/realms/company-ops',
    overrides: {
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
      GITHUB_APP_SLUG: 'company-ops-api-test',
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_API_BASE_URL: fakeServer.url,
      GITHUB_WEB_BASE_URL: fakeServer.url,
      GITHUB_WEBHOOK_MAX_BYTES: String(MAX_BYTES),
      RATE_LIMIT_GITHUB_PER_MINUTE: '1000',
    },
  });
  fake.webhookUrl = `${stack.baseUrl}/api/v1/webhooks/github`;
  orgA = await seed(stack);
  tm = await createSession(stack, SUBJECT.technicalManager, orgA, { mfa: true });
  admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
  gm = await createSession(stack, SUBJECT.gm, orgA);
  employee = await createSession(stack, SUBJECT.employee, orgA);
  tier = await createSession(stack, SUBJECT.tier, orgA);
  fieldTmp = await createSession(stack, SUBJECT.fieldTmp, orgA);
  pm = await createSession(stack, SUBJECT.pm, orgA);
}, 300_000);

afterAll(async () => {
  process.off('warning', onWarning);
  await stack.stop();
  await fakeServer.close();
});

describe('administration gates', () => {
  it('reports configuration without secrets to integration managers only', async () => {
    const { data } = await ok(await call('/integrations/github', tm), githubIntegrationStatusResponseSchema);
    expect(data).toMatchObject({
      configured: true,
      canInstall: true,
      webhookUrl: `${PUBLIC_URL}/api/v1/webhooks/github`,
      setupUrl: `${PUBLIC_URL}/api/v1/integrations/github/setup`,
      callbackUrl: `${PUBLIC_URL}/api/v1/integrations/github/callback`,
      installations: [],
    });
    expect(data.requiredPermissions).toEqual({
      metadata: 'read',
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
    });
    expect(await failure(await call('/integrations/github', employee), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/integrations/github', gm), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/integrations/github', pm), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/integrations/github', null), 401)).toBe('UNAUTHENTICATED');
  });

  it('requires a fresh MFA for every administrative route, including the setup return', async () => {
    const withoutMfa = await createSession(stack, SUBJECT.technicalManager, orgA);
    expect(await failure(await call('/integrations/github', withoutMfa), 401)).toBe('MFA_REQUIRED');
    expect(await failure(await call('/integrations/github/install', withoutMfa, { method: 'POST' }), 401)).toBe(
      'MFA_REQUIRED',
    );
    expect(
      await failure(
        await call('/integrations/github/setup?installation_id=1001&setup_action=install', withoutMfa),
        401,
      ),
    ).toBe('MFA_REQUIRED');
    expect(await failure(await call('/integrations/github/repositories', withoutMfa), 401)).toBe('MFA_REQUIRED');
    expect(
      await failure(
        await call('/organization/retention-policies', await createSession(stack, SUBJECT.admin, orgA)),
        401,
      ),
    ).toBe('MFA_REQUIRED');
  });

  it('protects state-changing routes with CSRF', async () => {
    expect(await failure(await call('/integrations/github/install', tm, { method: 'POST', csrf: false }), 403)).toBe(
      'CSRF_INVALID',
    );
  });
});

describe('installation setup', () => {
  it('never binds from a bare or forged installation_id', async () => {
    const bare = redirectTarget(await call('/integrations/github/setup?installation_id=1001&setup_action=install', tm));
    expect(Object.fromEntries(bare.searchParams)).toEqual({ github: 'error', reason: 'github_setup_invalid' });
    const forged = redirectTarget(
      await call('/integrations/github/setup?installation_id=1001&setup_action=install&state=forged', tm),
    );
    expect(forged.searchParams.get('reason')).toBe('github_setup_invalid');
    expect(await failure(await call('/integrations/github/setup?installation_id=1%20OR%201', tm), 400)).toBe(
      'VALIDATION_FAILED',
    );
    expect(await stack.prisma.githubInstallation.count()).toBe(0);
  });

  it('refuses a state minted for another session', async () => {
    const otherTab = await createSession(stack, SUBJECT.technicalManager, orgA, { mfa: true });
    const landed = await installFlow(tm, otherTab);
    expect(Object.fromEntries(landed.searchParams)).toEqual({ github: 'error', reason: 'github_setup_invalid' });
    expect(await stack.prisma.githubInstallation.count()).toBe(0);
  });

  it('redirects authorization refusals and malformed callbacks back to the admin page', async () => {
    const denied = redirectTarget(await call('/integrations/github/callback?error=access_denied&state=x', tm));
    expect(denied.pathname).toBe('/admin/integrations/github');
    expect(Object.fromEntries(denied.searchParams)).toEqual({ github: 'error', reason: 'authorization_denied' });
    const missing = redirectTarget(await call('/integrations/github/callback?code=abc', tm));
    expect(missing.searchParams.get('reason')).toBe('invalid_callback');
  });

  it('binds a verified installation, revokes the user token and never returns tokens', async () => {
    const revoked = fake.revokedUserTokens;
    const landed = await installFlow(tm);
    expect(Object.fromEntries(landed.searchParams)).toEqual({ github: 'installed' });
    expect(fake.revokedUserTokens).toBe(revoked + 1);
    const { data } = await ok(await call('/integrations/github', tm), githubIntegrationStatusResponseSchema);
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0]).toMatchObject({ accountLogin: 'acme-org', status: 'ACTIVE' });
    // Returning to the setup URL again only refreshes the existing binding.
    const again = redirectTarget(await call('/integrations/github/setup?installation_id=1001&setup_action=update', tm));
    expect(again.searchParams.get('github')).toBe('refreshed');
  });
});

describe('webhook receiver', () => {
  it('accepts a signed delivery on the exact raw bytes without a session or CSRF token', async () => {
    const body = '{\n  "action": "new_permissions_accepted",\n  "installation": { "id": 1001 }\n}';
    const response = await signedPost(body, hookHeaders(body, 'api-delivery-1'));
    expect(response.headers.get('cache-control')).toContain('no-store');
    const { data } = await ok(response, githubWebhookAckResponseSchema, 202);
    expect(data.outcome).toBe('queued');
    const duplicate = await signedPost(body, hookHeaders(body, 'api-delivery-1'));
    expect((await ok(duplicate, githubWebhookAckResponseSchema, 200)).data.outcome).toBe('duplicate');
    expect(await stack.prisma.githubWebhookDelivery.count({ where: { deliveryId: 'api-delivery-1' } })).toBe(1);
  });

  it('verifies the raw body even with an unexpected content type', async () => {
    const body = JSON.stringify({ action: 'new_permissions_accepted', installation: { id: 1001 } });
    const headers = { ...hookHeaders(body, 'api-delivery-text'), 'content-type': 'text/plain' };
    expect((await signedPost(body, headers)).status).toBe(202);
  });

  it('rejects missing, wrong, SHA-1 and altered signatures with the error envelope', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1001 } });
    const base = hookHeaders(body, 'api-delivery-bad');
    const unsigned: Record<string, string> = Object.fromEntries(
      Object.entries(base).filter(([name]) => name !== 'x-hub-signature-256'),
    );
    expect(await failure(await signedPost(body, unsigned), 401)).toBe('UNAUTHENTICATED');
    expect(
      await failure(await signedPost(body, { ...base, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }), 401),
    ).toBe('UNAUTHENTICATED');
    expect(
      await failure(
        await signedPost(body, {
          ...unsigned,
          'x-hub-signature': `sha1=${createHmac('sha1', WEBHOOK_SECRET).update(body).digest('hex')}`,
        }),
        401,
      ),
    ).toBe('UNAUTHENTICATED');
    expect(await failure(await signedPost(`${body} `, base), 401)).toBe('UNAUTHENTICATED');
    expect(await stack.prisma.githubWebhookDelivery.count({ where: { deliveryId: 'api-delivery-bad' } })).toBe(0);
    const viaFake = await fake.sendWebhook(
      'installation',
      { action: 'created', installation: { id: 1001 } },
      { tamper: true },
    );
    expect(viaFake.status).toBe(401);
  });

  it('rejects malformed payloads', async () => {
    const body = '{"installation":';
    expect(await failure(await signedPost(body, hookHeaders(body, 'api-delivery-malformed')), 400)).toBe(
      'VALIDATION_FAILED',
    );
    const ok2 = JSON.stringify({ installation: { id: 1001 } });
    expect(await failure(await signedPost(ok2, hookHeaders(ok2, 'id with spaces')), 400)).toBe('VALIDATION_FAILED');
  });

  it('refuses oversized bodies before verifying or parsing them, declared or streamed', async () => {
    const big = JSON.stringify({ installation: { id: 1001 }, padding: 'x'.repeat(MAX_BYTES) });
    expect(await failure(await signedPost(big, hookHeaders(big, 'api-delivery-big')), 413)).toBe('VALIDATION_FAILED');
    const chunks = [new TextEncoder().encode(big.slice(0, 2000)), new TextEncoder().encode(big.slice(2000))];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(next);
        }
      },
    });
    const streamed = await signedPost(stream, hookHeaders(big, 'api-delivery-stream')).catch(() => null);
    if (streamed !== null) {
      expect(streamed.status).toBe(413);
    }
    expect(
      await stack.prisma.githubWebhookDelivery.count({ where: { deliveryId: { startsWith: 'api-delivery-big' } } }),
    ).toBe(0);
  });

  it('acknowledges deliveries for unknown installations without storing them', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 777_777 } });
    expect(
      (await ok(await signedPost(body, hookHeaders(body, 'api-delivery-unknown')), githubWebhookAckResponseSchema)).data
        .outcome,
    ).toBe('ignored');
    expect(await stack.prisma.githubWebhookDelivery.count({ where: { deliveryId: 'api-delivery-unknown' } })).toBe(0);
  });

  it('shows a redacted delivery log to administrators', async () => {
    const page = await ok(await call('/integrations/github/webhook-deliveries', tm), githubDeliveryPageResponseSchema);
    expect(page.data.length).toBeGreaterThan(0);
    expect(Object.keys(page.data[0] ?? {})).not.toContain('payload');
  });
});

describe('mappings, project tab and ticket panel', () => {
  let repositoryId: string;
  let ihd: string;

  beforeAll(async () => {
    const installation = await stack.prisma.githubInstallation.findFirstOrThrow({ where: { organizationId: orgA } });
    const repo = await stack.prisma.githubRepository.create({
      data: {
        organizationId: orgA,
        installationId: installation.id,
        githubRepoId: 7001n,
        nodeId: 'R_fake7001',
        ownerLogin: 'acme-org',
        name: 'ops-platform',
        fullName: 'acme-org/ops-platform',
        private: true,
        htmlUrl: 'https://github.com/acme-org/ops-platform',
      },
    });
    repositoryId = repo.id;
    ihd = await projectId('IHD');
  });

  it('maps a repository to a project once, for integration managers only', async () => {
    const list = await ok(await call('/integrations/github/repositories', tm), githubRepositoryListResponseSchema);
    expect(list.data.map((repo) => repo.fullName)).toEqual(['acme-org/ops-platform']);
    expect(
      await failure(
        await call('/integrations/github/mappings', pm, { method: 'POST', body: { repositoryId, projectId: ihd } }),
        403,
      ),
    ).toBe('FORBIDDEN');
    const mapped = await ok(
      await call('/integrations/github/mappings', tm, { method: 'POST', body: { repositoryId, projectId: ihd } }),
      githubRepositoryResponseSchema,
      201,
    );
    expect(mapped.data.mappings.map((mapping) => mapping.project.id)).toEqual([ihd]);
    expect(
      await failure(
        await call('/integrations/github/mappings', tm, { method: 'POST', body: { repositoryId, projectId: ihd } }),
        409,
      ),
    ).toBe('CONFLICT');
    expect(
      await failure(
        await call('/integrations/github/mappings', tm, {
          method: 'POST',
          body: { repositoryId, projectId: randomUUID() },
        }),
        404,
      ),
    ).toBe('NOT_FOUND');
    expect(
      await failure(
        await call('/integrations/github/mappings', tm, {
          method: 'POST',
          body: { repositoryId: 'nope', projectId: ihd },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('serves the project tab from the cache to project members only', async () => {
    const overview = await ok(await call(`/projects/${ihd}/github`, pm), githubProjectOverviewResponseSchema);
    expect(overview.data.repositories.map((repo) => repo.fullName)).toEqual(['acme-org/ops-platform']);
    expect(overview.data.configured).toBe(true);
    const tmp = await projectId('TMP');
    // Members without github.view are refused before any lookup, so no project's existence leaks.
    for (const id of [tmp, ihd, randomUUID()]) {
      expect(await failure(await call(`/projects/${id}/github`, fieldTmp), 403)).toBe('FORBIDDEN');
    }
    expect(await failure(await call(`/projects/${randomUUID()}/github`, pm), 404)).toBe('NOT_FOUND');
    expect(await failure(await call(`/projects/${ihd}/github/jira-issues?q=OPS`, gm), 403)).toBe('FORBIDDEN');
  });

  it('hides the ticket panel from members without github.view', async () => {
    const ticket = await stack.prisma.supportTicket.findFirstOrThrow({
      where: { organizationId: orgA, projectId: ihd },
      select: { id: true },
    });
    const hidden = await ok(await call(`/support/tickets/${ticket.id}/github`, tier), ticketGithubPanelResponseSchema);
    expect(hidden.data).toMatchObject({ visible: false, pulls: [] });
    const visible = await ok(await call(`/support/tickets/${ticket.id}/github`, pm), ticketGithubPanelResponseSchema);
    expect(visible.data).toMatchObject({ visible: true, available: true, canLink: true });
  });
});

describe('retention policies', () => {
  it('lets only organization settings managers with MFA configure bounded retention', async () => {
    const empty = await ok(await call('/organization/retention-policies', admin), retentionPolicyListResponseSchema);
    expect(empty.data.map((policy) => [policy.category, policy.retainDays])).toEqual([
      ['WEBHOOK_DELIVERIES', null],
      ['SYNC_FAILURES', null],
      ['ATTENDANCE_COORDINATES', null],
    ]);
    expect(
      await failure(
        await call('/organization/retention-policies/WEBHOOK_DELIVERIES', admin, {
          method: 'PUT',
          body: { retainDays: 3, version: null },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await call('/organization/retention-policies/WEBHOOK_DELIVERIES', tm, {
          method: 'PUT',
          body: { retainDays: 30, version: null },
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
    const saved = await ok(
      await call('/organization/retention-policies/WEBHOOK_DELIVERIES', admin, {
        method: 'PUT',
        body: { retainDays: 30, version: null },
      }),
      retentionPolicyListResponseSchema,
    );
    const policy = saved.data.find((item) => item.category === 'WEBHOOK_DELIVERIES');
    expect(policy?.retainDays).toBe(30);
    expect(
      await failure(
        await call('/organization/retention-policies/WEBHOOK_DELIVERIES', admin, {
          method: 'PUT',
          body: { retainDays: 60, version: null },
        }),
        409,
      ),
    ).toBe('VERSION_CONFLICT');
    const removed = await ok(
      await call(`/organization/retention-policies/WEBHOOK_DELIVERIES?version=${String(policy?.version ?? 0)}`, admin, {
        method: 'DELETE',
      }),
      retentionPolicyListResponseSchema,
    );
    expect(removed.data.find((item) => item.category === 'WEBHOOK_DELIVERIES')?.retainDays).toBeNull();
  });

  it('shows a dry-run count of what a policy would remove, deleting nothing', async () => {
    const stored = await stack.prisma.githubWebhookDelivery.findFirst({
      where: { organizationId: orgA },
      select: { id: true, status: true, processedAt: true, receivedAt: true },
    });
    if (stored === null) {
      throw new Error('expected a delivery from the webhook tests');
    }
    const before = await stack.prisma.githubWebhookDelivery.count({ where: { organizationId: orgA } });
    const preview = (days: number, session = admin) =>
      call(`/organization/retention-policies/WEBHOOK_DELIVERIES/preview?retainDays=${String(days)}`, session);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await stack.prisma.githubWebhookDelivery.update({
      where: { id: stored.id },
      data: { status: 'RECEIVED', processedAt: null, receivedAt: monthAgo },
    });
    const pending = await ok(await preview(7), retentionPreviewResponseSchema);
    await stack.prisma.githubWebhookDelivery.update({
      where: { id: stored.id },
      data: { status: 'PROCESSED', processedAt: monthAgo },
    });
    try {
      const old = await ok(await preview(7), retentionPreviewResponseSchema);
      expect(old.data).toEqual({ category: 'WEBHOOK_DELIVERIES', retainDays: 7, eligible: pending.data.eligible + 1 });
      expect((await ok(await preview(60), retentionPreviewResponseSchema)).data.eligible).toBe(0);
      expect(await failure(await preview(3), 400)).toBe('VALIDATION_FAILED');
      expect(await failure(await preview(30, tm), 403)).toBe('FORBIDDEN');
      expect(await stack.prisma.githubWebhookDelivery.count({ where: { organizationId: orgA } })).toBe(before);
    } finally {
      await stack.prisma.githubWebhookDelivery.update({
        where: { id: stored.id },
        data: { status: stored.status, processedAt: stored.processedAt, receivedAt: stored.receivedAt },
      });
    }
  });
});

describe('test-only surface', () => {
  it('exposes none of the test double control routes through the API', async () => {
    for (const path of ['/__fake/state', '/__fake/reset', '/integrations/github/__fake/state']) {
      expect((await call(path, admin)).status).toBe(404);
    }
    expect((await fetch(`${stack.baseUrl}/__fake/state`)).status).toBe(404);
  });
});

describe('database access', () => {
  it('never issues concurrent queries on a request transaction connection', async () => {
    // Node emits a deprecation once per process, so this covers every request made above.
    await new Promise((resolve) => setImmediate(resolve));
    expect(concurrentQueryWarnings).toEqual([]);
  });
});
