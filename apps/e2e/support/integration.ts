import { randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

import { contextFor, csrfToken, stepUp } from './auth.js';
import type { DemoUser, UserSession } from './auth.js';
import { E2E_WEB_URL } from './ports.js';

/**
 * Shared helpers of the integration suites (Phase 4 Jira, Phase 5 GitHub): direct API calls with a
 * browser context's session, the deterministic fakes' control routes, and idempotent fixtures that
 * let every test establish the integration state it needs regardless of order.
 */

export const IHD = 'Internal Helpdesk Upgrade';
/** Fake Jira fixture (packages/core/src/testing/fake-jira.ts): the OPS project id. */
export const OPS_ID = '20001';

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; run the suite through playwright.config.ts (global setup).`);
  }
  return value;
}

async function control<T>(page: Page, base: string, path: string, data?: unknown): Promise<T> {
  const url = `${base}/__fake${path}`;
  const response = data === undefined ? await page.request.get(url) : await page.request.post(url, { data });
  expect(response.status(), `fake ${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** Control route of the fake Atlassian server. */
export function fakeJira<T>(page: Page, path: string, data?: unknown): Promise<T> {
  return control<T>(page, requiredUrl('E2E_FAKE_JIRA_URL'), path, data);
}

/** Control route of the fake GitHub server. */
export function fakeGithub<T>(page: Page, path: string, data?: unknown): Promise<T> {
  return control<T>(page, requiredUrl('E2E_FAKE_GITHUB_URL'), path, data);
}

export async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

export async function send<T>(
  page: Page,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    headers: {
      origin: E2E_WEB_URL,
      'x-csrf-token': await csrfToken(page),
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return response.status() === 204 ? (undefined as T) : ((await response.json()) as { data: T }).data;
}

export async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `GET ${path}: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

export async function asUser<T>(browser: Browser, user: DemoUser, run: (page: Page) => Promise<T>): Promise<T> {
  const session = await contextFor(browser, user);
  try {
    return await run(session.page);
  } finally {
    await session.close();
  }
}

export async function projectId(page: Page, name: string): Promise<string> {
  const rows = await get<{ id: string; name: string }[]>(page, `/api/v1/projects?q=${encodeURIComponent(name)}`);
  const id = rows.find((project) => project.name === name)?.id;
  expect(id, `project ${name}`).toBeDefined();
  return id ?? '';
}

export interface MappingRef {
  readonly id: string;
  readonly project: { readonly id: string; readonly code: string };
  readonly jiraProject: { readonly id: string; readonly key: string };
  readonly importState: string;
}

interface JiraStatus {
  readonly connection: {
    readonly id: string;
    readonly status: string;
    readonly webhook: { readonly state: string };
  } | null;
}

/** OAuth round trip with the browser context's cookies (authorize at the fake, then our callback). */
async function consentViaApi(page: Page, connectionId: string | null): Promise<void> {
  const { authorizeUrl } = await send<{ authorizeUrl: string }>(
    page,
    'POST',
    '/api/v1/integrations/jira/connect',
    connectionId === null ? {} : { connectionId },
  );
  const authorize = await page.request.get(authorizeUrl, { maxRedirects: 0 });
  expect(authorize.status()).toBe(302);
  const back = new URL(authorize.headers().location ?? '');
  const callback = await page.request.get(`${back.pathname}${back.search}`, { maxRedirects: 0 });
  expect(callback.status()).toBe(302);
  expect(callback.headers().location ?? '').toContain('jira=connected');
}

export async function waitForImport(page: Page, jiraProjectId: string): Promise<MappingRef> {
  let mapping: MappingRef | undefined;
  await expect
    .poll(
      async () => {
        const rows = await get<MappingRef[]>(page, '/api/v1/integrations/jira/mappings');
        mapping = rows.find((row) => row.jiraProject.id === jiraProjectId);
        return mapping?.importState;
      },
      { timeout: 60_000 },
    )
    .toBe('COMPLETED');
  if (mapping === undefined) {
    throw new Error(`No mapping for Jira project ${jiraProjectId}`);
  }
  return mapping;
}

/**
 * Jira connected (ACTIVE, webhooks registered) with IHD mapped to OPS and imported. Idempotent; runs
 * as the org administrator, who holds `integration.manage`.
 */
export async function ensureJira(browser: Browser): Promise<MappingRef> {
  return asUser(browser, 'org.admin', async (page) => {
    const status = await get<JiraStatus>(page, '/api/v1/integrations/jira');
    if (status.connection?.status !== 'ACTIVE') {
      await consentViaApi(page, status.connection?.id ?? null);
    }
    const rows = await get<MappingRef[]>(page, '/api/v1/integrations/jira/mappings');
    if (!rows.some((row) => row.jiraProject.id === OPS_ID)) {
      await send(page, 'POST', '/api/v1/integrations/jira/mappings', {
        projectId: await projectId(page, IHD),
        jiraProjectId: OPS_ID,
        blockedStatuses: ['Blocked'],
      });
    }
    const mapping = await waitForImport(page, OPS_ID);
    await expect
      .poll(async () => (await get<JiraStatus>(page, '/api/v1/integrations/jira')).connection?.webhook.state, {
        timeout: 60_000,
      })
      .toBe('ACTIVE');
    return mapping;
  });
}

/** Fake GitHub fixture (packages/core/src/testing/fake-github.ts). */
export const INSTALLATION = '1001';
export const OPS_PLATFORM = { id: 7001, fullName: 'acme-org/ops-platform' } as const;
export const MOBILE_APP = { id: 7002, fullName: 'acme-org/mobile-app' } as const;
export const WEBSITE = { id: 7003, fullName: 'acme-org/website' } as const;

export interface InstallationRef {
  readonly id: string;
  readonly githubInstallationId: string;
  readonly status: string;
}

export interface RepositoryRef {
  readonly id: string;
  readonly fullName: string;
  readonly status: string;
  readonly mappings: readonly {
    readonly id: string;
    readonly version: number;
    readonly project: { readonly id: string };
  }[];
  readonly lastRun: { readonly status: string } | null;
}

interface WebhookResult {
  readonly status: number;
}

/** The technical manager (integration.manage) with a fresh second factor, as administration requires. */
export async function managerSession(browser: Browser, options: BrowserContextOptions = {}): Promise<UserSession> {
  const session = await contextFor(browser, 'manager', options);
  await stepUp(session.page, 'manager');
  return session;
}

export async function asManager<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  const session = await managerSession(browser);
  try {
    return await run(session.page);
  } finally {
    await session.close();
  }
}

/** GitHub's install page and user authorization, followed with the context's cookies. */
export async function installViaApi(page: Page): Promise<void> {
  const { installUrl } = await send<{ installUrl: string }>(page, 'POST', '/api/v1/integrations/github/install');
  const installed = await page.request.get(installUrl, { maxRedirects: 0 });
  expect(installed.status()).toBe(302);
  const setup = new URL(installed.headers().location ?? '');
  const step = await page.request.get(`${setup.pathname}${setup.search}`, { maxRedirects: 0 });
  expect(step.status()).toBe(302);
  const authorized = await page.request.get(step.headers().location ?? '', { maxRedirects: 0 });
  expect(authorized.status()).toBe(302);
  const callback = new URL(authorized.headers().location ?? '');
  const back = await page.request.get(`${callback.pathname}${callback.search}`, { maxRedirects: 0 });
  expect(back.status()).toBe(302);
  expect(back.headers().location ?? '').toContain('github=installed');
}

export async function installation(page: Page): Promise<InstallationRef | undefined> {
  const status = await get<{ installations: InstallationRef[] }>(page, '/api/v1/integrations/github');
  return status.installations.find((row) => row.githubInstallationId === INSTALLATION);
}

export async function repositories(page: Page): Promise<RepositoryRef[]> {
  return get<RepositoryRef[]>(page, '/api/v1/integrations/github/repositories?includeUnavailable=true');
}

export async function repository(page: Page, fullName: string): Promise<RepositoryRef | undefined> {
  return (await repositories(page)).find((repo) => repo.fullName === fullName);
}

export async function emit(page: Page, data: Record<string, unknown>): Promise<void> {
  const result = await fakeGithub<WebhookResult>(page, '/webhooks/emit', data);
  expect(result.status, `webhook ${JSON.stringify(data)}`).toBeLessThan(300);
}

export async function waitForInstallation(page: Page, status: string): Promise<void> {
  await expect.poll(async () => (await installation(page))?.status, { timeout: 60_000 }).toBe(status);
}

export async function waitForRepository(page: Page, fullName: string, status: string): Promise<void> {
  await expect.poll(async () => (await repository(page, fullName))?.status, { timeout: 60_000 }).toBe(status);
}

/** Maps the repository to the project (unless it already is) and waits for the latest run to succeed. */
export async function ensureMapped(page: Page, fullName: string, project: string): Promise<RepositoryRef> {
  let repo = await repository(page, fullName);
  if (repo === undefined) {
    throw new Error(`${fullName} was not discovered`);
  }
  if (!repo.mappings.some((mapping) => mapping.project.id === project)) {
    await send(page, 'POST', '/api/v1/integrations/github/mappings', { repositoryId: repo.id, projectId: project });
  }
  await expect
    .poll(
      async () => {
        repo = await repository(page, fullName);
        return repo?.lastRun?.status;
      },
      { timeout: 60_000 },
    )
    .toBe('SUCCEEDED');
  return repo;
}

/**
 * The App installed and ACTIVE, every fixture repository available, and ops-platform mapped to IHD
 * with its initial sync done. Repairs a suspension or removed access left by an interrupted test.
 * Runs as the technical manager, who holds `integration.manage`.
 */
export async function ensureGithub(browser: Browser): Promise<{ ihd: string }> {
  return asManager(browser, async (page) => {
    const current = await installation(page);
    if (current?.status === 'SUSPENDED') {
      await fakeGithub(page, '/installations/unsuspend', { installationId: Number(INSTALLATION) });
      await emit(page, { event: 'installation', action: 'unsuspend', installationId: Number(INSTALLATION) });
    } else if (current?.status !== 'ACTIVE') {
      await installViaApi(page);
    }
    await waitForInstallation(page, 'ACTIVE');
    for (const repo of [OPS_PLATFORM, MOBILE_APP, WEBSITE]) {
      await expect
        .poll(async () => (await repository(page, repo.fullName)) !== undefined, { timeout: 60_000 })
        .toBe(true);
      if ((await repository(page, repo.fullName))?.status !== 'AVAILABLE') {
        await fakeGithub(page, '/repos/add', { repoId: repo.id });
        await emit(page, { event: 'installation_repositories', action: 'added', repoId: repo.id });
        await waitForRepository(page, repo.fullName, 'AVAILABLE');
      }
    }
    const ihd = await projectId(page, IHD);
    await ensureMapped(page, OPS_PLATFORM.fullName, ihd);
    return { ihd };
  });
}
