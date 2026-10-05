import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import {
  asManager,
  asUser,
  emit,
  ensureGithub,
  ensureJira,
  ensureMapped,
  fakeGithub as fake,
  IHD,
  INSTALLATION,
  managerSession,
  MOBILE_APP,
  OPS_PLATFORM,
  projectId,
  repository,
  send,
  settled,
  waitForInstallation,
  waitForRepository,
  WEBSITE,
} from '../support/integration.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  github: { project: { sourceOfTruth: string }; ticket: { title: string } };
  projects: { tabs: { github: string } };
};

const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const TMP = 'Traffic Management Platform';

/**
 * Phase 5 against the deterministic GitHub App double started by global setup (never a real GitHub
 * App or repository). Every test establishes the state it needs through `ensureGithub` (installed,
 * ACTIVE, repositories available, ops-platform mapped to IHD and synced) and creates its own pull
 * requests, so the scenarios pass in any order; tests that suspend or remove access restore it.
 */
const uniqueTitle = (label: string): string => `E2E GitHub ${label} ${RUN}`;

/** A new open pull request on ops-platform, announced by a signed `pull_request` webhook. */
async function openPull(
  page: Page,
  input: { title: string; headRef?: string; body?: string; checks?: readonly string[] },
): Promise<number> {
  const created = await fake<{ number: number }>(page, '/pulls', { repoId: OPS_PLATFORM.id, ...input });
  await emit(page, { event: 'pull_request', action: 'opened', repoId: OPS_PLATFORM.id, number: created.number });
  return created.number;
}

async function openGithubTab(page: Page, project: string): Promise<void> {
  // A goto that only differs by the hash is a same-document navigation and would keep stale data.
  if (new URL(page.url()).pathname === `/projects/${project}`) {
    await page.reload();
  } else {
    await page.goto(`/projects/${project}#github`);
  }
  await expect(page.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Reloads the project tab until the pull request row satisfies `check` (webhooks are processed asynchronously). */
async function expectPull(
  page: Page,
  project: string,
  title: string,
  check: (row: Locator) => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await openGithubTab(page, project);
    const row = page.getByTestId('github-pull').filter({ hasText: title });
    await expect(row).toHaveCount(1, { timeout: 2_000 });
    await check(row);
  }).toPass({ timeout: 60_000 });
}

interface TicketRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
}

async function createTicket(page: Page, title: string): Promise<TicketRef> {
  return send<TicketRef>(page, 'POST', '/api/v1/support/tickets', {
    title,
    description: `Steps to reproduce for ${title}.`,
    severity: 'MEDIUM',
    impact: 'SINGLE_USER',
    source: 'INTERNAL',
    projectId: await projectId(page, IHD),
  });
}

async function openTicket(page: Page, ticket: TicketRef): Promise<void> {
  await page.goto(`/support/tickets/${ticket.id}`);
  await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test.describe('Phase 5 GitHub integration', () => {
  test('1-2. the integration manager opens GitHub settings and installs the App through GitHub', async ({
    browser,
  }) => {
    const { page, close } = await managerSession(browser);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'GitHub integration' })
      .click();
    await settled(page);
    await expect(page.getByRole('heading', { level: 1, name: 'GitHub integration' })).toBeVisible();
    await page.getByText('App settings for GitHub').click();
    await expect(page.getByText(`${E2E_WEB_URL}/api/v1/webhooks/github`)).toBeVisible();
    await expect(page.getByText(`${E2E_WEB_URL}/api/v1/integrations/github/setup`)).toBeVisible();

    // Install page and user authorization happen on GitHub (the fake approves), then back here.
    await page.getByRole('button', { name: 'Install GitHub App' }).click();
    await page.waitForURL(/\/admin\/integrations\/github\?github=installed/);
    await expect(
      page.getByRole('status').filter({ hasText: 'The GitHub App installation is connected.' }),
    ).toBeVisible();
    const row = page.getByTestId('github-installation').filter({ hasText: 'acme-org' });
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Organization');
    // No App key, secret or token ever reaches the browser.
    const body = await (await page.request.get('/api/v1/integrations/github')).text();
    expect(body).not.toMatch(/PRIVATE KEY|ghs_|ghu_|client_secret|webhookSecret/i);
    await close();
  });

  test('3-4. maps a repository to a project; it appears on the project GitHub tab', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const { page, close } = await managerSession(browser);
    // Order independence: start from an unmapped mobile-app.
    const before = await repository(page, MOBILE_APP.fullName);
    for (const mapping of before?.mappings ?? []) {
      await send(
        page,
        'DELETE',
        `/api/v1/integrations/github/mappings/${mapping.id}?version=${String(mapping.version)}`,
      );
    }
    await page.goto('/admin/integrations/github');
    await settled(page);
    const repo = page.getByTestId('github-repository').filter({ hasText: MOBILE_APP.fullName });
    await expect(repo).toContainText('Not mapped to a project.');
    await repo.getByRole('button', { name: 'Map to project' }).click();
    const dialog = page.getByRole('dialog', { name: `Map ${MOBILE_APP.fullName} to a project` });
    await dialog.getByLabel('Project').selectOption(ihd);
    await expect(dialog).toContainText('Open pull requests and those closed in the last 90 days');
    await dialog.getByRole('button', { name: 'Map repository' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: `${MOBILE_APP.fullName} mapped to IHD. The initial sync is queued.` }),
    ).toBeVisible();
    await expect(repo.getByRole('list', { name: 'Mapped projects' })).toContainText('IHD · Internal Helpdesk Upgrade');
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('github-repository').filter({ hasText: MOBILE_APP.fullName })).toContainText(
        'Succeeded',
        { timeout: 2_000 },
      );
    }).toPass({ timeout: 60_000 });
    await close();

    await asUser(browser, 'pm', async (pm) => {
      await openGithubTab(pm, ihd);
      await expect(pm.getByText('GitHub is the source of truth.', { exact: false })).toBeVisible();
      const listed = pm.getByTestId('github-project-repository').filter({ hasText: MOBILE_APP.fullName });
      await expect(listed).toContainText('Up to date');
      await expect(
        listed.getByRole('link', { name: `Open repository ${MOBILE_APP.fullName} on GitHub (new tab)` }),
      ).toHaveAttribute('target', '_blank');
    });
  });

  test('5-8. open pull requests appear with inferred, unverified and manually confirmed Jira keys', async ({
    browser,
  }) => {
    await ensureJira(browser);
    const { ihd } = await ensureGithub(browser);
    const inferred = uniqueTitle('Fix login loop');
    const unverified = uniqueTitle('OPS-99999 cleanup');
    await asManager(browser, async (page) => {
      await openPull(page, { title: inferred, headRef: `feature/OPS-1-${RUN}`, checks: ['success'] });
      await openPull(page, { title: unverified, headRef: `chore/${RUN}` });
    });

    const { page, close } = await contextFor(browser, 'pm');
    // 5-6: the open PR is listed from the cache; OPS-1 is cached and mapped to IHD, so it is confirmed.
    await expectPull(page, ihd, inferred, async (row) => {
      await expect(row).toContainText('Open', { timeout: 2_000 });
      await expect(row.getByTestId('pull-jira-link')).toHaveAttribute('data-state', 'CONFIRMED', { timeout: 2_000 });
    });
    const confirmed = page.getByTestId('github-pull').filter({ hasText: inferred });
    await expect(confirmed.getByTestId('pull-jira-link')).toContainText('OPS-1');
    await expect(confirmed.getByTestId('pull-jira-link')).toContainText('Confirmed');
    await expect(
      confirmed.getByRole('link', { name: /^Open pull request acme-org\/ops-platform#\d+ on GitHub/ }),
    ).toHaveAttribute('rel', /noopener/);

    // 7: a key that is not in the Jira cache is never turned into a link.
    const mention = page.getByTestId('github-pull').filter({ hasText: unverified });
    await expect(mention.getByTestId('pull-unverified-keys')).toHaveText('Mentioned but not verified: OPS-99999');
    await expect(mention.getByTestId('pull-jira-link')).toHaveCount(0);

    // 8: the project manager links a cached issue of this project by hand; it shows as confirmed.
    await mention.getByRole('button', { name: /^Link a Jira issue to pull request #\d+$/ }).click();
    const dialog = page.getByRole('dialog', { name: /^Link a Jira issue to #\d+$/ });
    await dialog.getByLabel('Search this project’s Jira issues').fill('Safari');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await dialog.getByRole('button', { name: 'Link Jira issue OPS-1', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: /^Jira issue OPS-1 linked to #\d+\.$/ })).toBeVisible();
    const manual = page.getByTestId('github-pull').filter({ hasText: unverified }).getByTestId('pull-jira-link');
    await expect(manual).toHaveAttribute('data-state', 'CONFIRMED');
    await expect(manual).toContainText('linked manually');
    await close();
  });

  test('9-10. review and check changes arrive by webhook and update the summary', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const title = uniqueTitle('Review and checks');
    const number = await asManager(browser, async (page) => {
      const created = await openPull(page, { title, headRef: `feature/review-${RUN}` });
      await fake(page, '/checks', { repoId: OPS_PLATFORM.id, number: created, conclusions: ['pending'] });
      await emit(page, { event: 'check_run', repoId: OPS_PLATFORM.id, number: created });
      return created;
    });
    const { page, close } = await contextFor(browser, 'pm');
    await expectPull(page, ihd, title, async (row) => {
      await expect(row).toContainText('Checks pending', { timeout: 2_000 });
      await expect(row).toContainText('No review', { timeout: 2_000 });
    });

    await fake(page, '/reviews', { repoId: OPS_PLATFORM.id, number, state: 'CHANGES_REQUESTED' });
    await emit(page, { event: 'pull_request_review', repoId: OPS_PLATFORM.id, number });
    await fake(page, '/checks', { repoId: OPS_PLATFORM.id, number, conclusions: ['success', 'failure'] });
    await emit(page, { event: 'check_run', repoId: OPS_PLATFORM.id, number });
    await expectPull(page, ihd, title, async (row) => {
      await expect(row).toContainText('Review: Changes requested', { timeout: 2_000 });
      await expect(row).toContainText('Checks: Checks failing (1/2)', { timeout: 2_000 });
      await expect(row.getByTestId('pull-signals')).toContainText('Failing checks', { timeout: 2_000 });
    });

    await fake(page, '/reviews', { repoId: OPS_PLATFORM.id, number, state: 'APPROVED', user: 'reviewer-one' });
    await emit(page, { event: 'pull_request_review', repoId: OPS_PLATFORM.id, number });
    await fake(page, '/checks', { repoId: OPS_PLATFORM.id, number, conclusions: ['success', 'success'] });
    await emit(page, { event: 'check_run', repoId: OPS_PLATFORM.id, number });
    await expectPull(page, ihd, title, async (row) => {
      await expect(row).toContainText('Review: Approved', { timeout: 2_000 });
      await expect(row).toContainText('Checks: Checks passing (2/2)', { timeout: 2_000 });
      await expect(row.getByTestId('pull-signals')).toHaveCount(0, { timeout: 2_000 });
    });
    await close();
  });

  test('11. the ticket panel links a pull request; members without github.view never see it', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const prTitle = uniqueTitle('Ticket fix');
    await asManager(browser, async (page) => {
      await openPull(page, { title: prTitle, headRef: `fix/ticket-${RUN}` });
    });
    const ticket = await asUser(browser, 'support', (page) => createTicket(page, uniqueTitle('Ticket panel')));

    const { page, close } = await contextFor(browser, 'pm');
    await expectPull(page, ihd, prTitle, async (row) => {
      await expect(row).toContainText('Open', { timeout: 2_000 });
    });
    await openTicket(page, ticket);
    const panel = page.getByTestId('ticket-github');
    await expect(panel).toContainText('No pull requests linked yet.');
    await panel.getByRole('button', { name: 'Link pull request' }).click();
    const dialog = page.getByRole('dialog', { name: `Link a pull request to ${ticket.key}` });
    await dialog.getByLabel('Search by title or number').fill(prTitle);
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    const result = dialog
      .getByRole('list', { name: 'Pull requests' })
      .getByRole('listitem')
      .filter({ hasText: prTitle });
    await expect(result).toHaveCount(1);
    await result.getByRole('button', { name: /^Link pull request #\d+$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: /^Pull request #\d+ linked\.$/ })).toBeVisible();
    const linked = panel.getByTestId('github-pull').filter({ hasText: prTitle });
    await expect(linked).toContainText('Linked to ticket');
    await close();

    for (const user of ['support', 'field'] as const) {
      await asUser(browser, user, async (other) => {
        const panelData = await other.request.get(`/api/v1/support/tickets/${ticket.id}/github`);
        if (panelData.status() === 200) {
          expect(((await panelData.json()) as { data: { visible: boolean; pulls: unknown[] } }).data).toMatchObject({
            visible: false,
            pulls: [],
          });
        } else {
          expect([403, 404]).toContain(panelData.status());
        }
        expect(await panelData.text()).not.toContain(prTitle);
      });
    }
    await asUser(browser, 'support', async (agent) => {
      await openTicket(agent, ticket);
      await expect(agent.getByTestId('ticket-history')).toBeVisible();
      await expect(agent.getByTestId('ticket-github')).toHaveCount(0);
    });
  });

  test('12. members without integration.manage cannot reach GitHub administration', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    for (const user of ['gm', 'employee'] as const) {
      await asUser(browser, user, async (page) => {
        await expect(
          page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'GitHub integration' }),
        ).toHaveCount(0);
        await page.goto('/admin/integrations/github');
        await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
        expect((await page.request.get('/api/v1/integrations/github')).status()).toBe(403);
        expect((await page.request.get('/api/v1/integrations/github/repositories')).status()).toBe(403);
        const map = await page.request.post('/api/v1/integrations/github/mappings', {
          headers: { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' },
          data: { repositoryId: randomUUID(), projectId: ihd },
        });
        expect(map.status()).toBe(403);
      });
    }
  });

  test('13. project outsiders cannot see repository or pull request data', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const tmp = await asManager(browser, (page) => projectId(page, TMP));
    // The IHD project manager holds github.view for IHD only.
    await asUser(browser, 'pm', async (page) => {
      const response = await page.request.get(`/api/v1/projects/${tmp}/github`);
      expect([403, 404]).toContain(response.status());
      expect(await response.text()).not.toContain('acme-org');
      const pulls = await page.request.get(`/api/v1/projects/${tmp}/github/pulls`);
      expect([403, 404]).toContain(pulls.status());
    });
    // Without github.view at all: no tab, no data, whatever the project.
    await asUser(browser, 'employee', async (page) => {
      for (const id of [ihd, tmp]) {
        const response = await page.request.get(`/api/v1/projects/${id}/github`);
        expect([403, 404]).toContain(response.status());
        expect(await response.text()).not.toContain('acme-org');
      }
    });
    await asUser(browser, 'field', async (page) => {
      const response = await page.request.get(`/api/v1/projects/${tmp}/github`);
      expect([403, 404]).toContain(response.status());
      const visible = await page.request.get(`/api/v1/projects/${tmp}`);
      if (visible.status() === 200) {
        await page.goto(`/projects/${tmp}`);
        await settled(page);
        await expect(page.getByRole('tab', { name: 'GitHub' })).toHaveCount(0);
      }
    });
  });

  test('14. a suspended installation is shown and pauses sync until it is unsuspended', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const { page, close } = await managerSession(browser);
    try {
      await fake(page, '/installations/suspend', { installationId: Number(INSTALLATION) });
      await emit(page, { event: 'installation', action: 'suspend', installationId: Number(INSTALLATION) });
      await waitForInstallation(page, 'SUSPENDED');
      await page.goto('/admin/integrations/github');
      await settled(page);
      const row = page.getByTestId('github-installation').filter({ hasText: 'acme-org' });
      await expect(row).toContainText('Suspended');
      await expect(row.getByRole('alert')).toHaveText(
        'The installation is suspended on GitHub. Nothing syncs until it is unsuspended there.',
      );
      await openGithubTab(page, ihd);
      await expect(page.getByRole('status').filter({ hasText: 'Some repositories need attention' })).toBeVisible();
      await expect(
        page.getByTestId('github-project-repository').filter({ hasText: OPS_PLATFORM.fullName }),
      ).toContainText('Installation suspended');
    } finally {
      await fake(page, '/installations/unsuspend', { installationId: Number(INSTALLATION) });
      await emit(page, { event: 'installation', action: 'unsuspend', installationId: Number(INSTALLATION) });
      await waitForInstallation(page, 'ACTIVE');
      await close();
    }
  });

  test('15. a repository whose access was removed keeps its history and stops syncing', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const { page, close } = await managerSession(browser);
    try {
      await ensureMapped(page, WEBSITE.fullName, ihd);
      await fake(page, '/repos/remove', { repoId: WEBSITE.id });
      await emit(page, { event: 'installation_repositories', action: 'removed', repoId: WEBSITE.id });
      await waitForRepository(page, WEBSITE.fullName, 'REMOVED');

      await page.goto('/admin/integrations/github');
      await settled(page);
      await page.getByLabel('Show unavailable repositories').check();
      const repo = page.getByTestId('github-repository').filter({ hasText: WEBSITE.fullName });
      await expect(repo).toHaveAttribute('data-status', 'REMOVED');
      await expect(repo).toContainText('Access removed');
      await expect(repo).toContainText(
        'The App can no longer access this repository. Its history stays; nothing syncs.',
      );
      await expect(repo.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
      await expect(repo.getByRole('button', { name: 'Map to project' })).toHaveCount(0);

      await openGithubTab(page, ihd);
      const listed = page.getByTestId('github-project-repository').filter({ hasText: WEBSITE.fullName });
      await expect(listed).toContainText('Unavailable');
    } finally {
      await fake(page, '/repos/add', { repoId: WEBSITE.id });
      await emit(page, { event: 'installation_repositories', action: 'added', repoId: WEBSITE.id });
      await waitForRepository(page, WEBSITE.fullName, 'AVAILABLE');
      await close();
    }
  });

  for (const width of WIDTHS) {
    test(`16. responsive layout and axe on the GitHub screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const { ihd } = await ensureGithub(browser);
      await asManager(browser, (page) =>
        openPull(page, {
          title: `${uniqueTitle(`Axe ${String(width)}`)} with a deliberately long title to check wrapping at ${String(width)} px`,
          headRef: `feature/OPS-1-a-very-long-branch-name-for-wrapping-${String(width)}-${RUN}`,
        }),
      );
      const ticket = await asUser(browser, 'support', (page) =>
        createTicket(page, uniqueTitle(`Axe ${String(width)}`)),
      );

      const admin = await managerSession(browser, { viewport });
      await admin.page.goto('/admin/integrations/github');
      await settled(admin.page);
      await expect(admin.page.getByTestId('github-repositories')).toBeVisible();
      await expectNoHorizontalOverflow(admin.page, `GitHub admin at ${String(width)} px`);
      await expectNoAxeViolations(admin.page, `GitHub admin at ${String(width)} px`);
      await admin.page
        .getByTestId('github-repository')
        .filter({ hasText: OPS_PLATFORM.fullName })
        .getByRole('button', { name: 'Map to project' })
        .click();
      await expect(admin.page.getByRole('dialog', { name: `Map ${OPS_PLATFORM.fullName} to a project` })).toBeVisible();
      await expectNoAxeViolations(admin.page, `map dialog at ${String(width)} px`);
      await admin.close();

      const pm = await contextFor(browser, 'pm', { viewport });
      await openGithubTab(pm.page, ihd);
      await expect(pm.page.getByTestId('github-project-pulls')).toBeVisible();
      await expectNoHorizontalOverflow(pm.page, `project GitHub tab at ${String(width)} px`);
      await expectNoAxeViolations(pm.page, `project GitHub tab at ${String(width)} px`);
      await pm.page
        .getByRole('button', { name: /^Link a Jira issue to pull request #\d+$/ })
        .first()
        .click();
      await expect(pm.page.getByRole('dialog', { name: /^Link a Jira issue to #\d+$/ })).toBeVisible();
      await expectNoAxeViolations(pm.page, `link Jira issue dialog at ${String(width)} px`);
      await pm.page.keyboard.press('Escape');

      await openTicket(pm.page, ticket);
      await expect(pm.page.getByTestId('ticket-github')).toBeVisible();
      await expectNoHorizontalOverflow(pm.page, `ticket GitHub panel at ${String(width)} px`);
      await expectNoAxeViolations(pm.page, `ticket GitHub panel at ${String(width)} px`);
      await pm.page.getByTestId('ticket-github').getByRole('button', { name: 'Link pull request' }).click();
      await expect(pm.page.getByRole('dialog', { name: `Link a pull request to ${ticket.key}` })).toBeVisible();
      await expectNoAxeViolations(pm.page, `link pull request dialog at ${String(width)} px`);
      await pm.close();
    });
  }

  test('17. RTL: the project GitHub tab and ticket panel render right-to-left in Arabic', async ({ browser }) => {
    const { ihd } = await ensureGithub(browser);
    const ticket = await asUser(browser, 'support', (page) => createTicket(page, uniqueTitle('RTL')));
    const { page, close } = await contextFor(browser, 'pm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto(`/projects/${ihd}#github`);
      await expect(page.getByRole('tab', { name: ar.projects.tabs.github })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.getByText(ar.github.project.sourceOfTruth)).toBeVisible();
      // Repository names and branches stay left-to-right inside the RTL layout.
      await expect(
        page.getByTestId('github-project-repository').filter({ hasText: OPS_PLATFORM.fullName }).locator('[dir="ltr"]'),
      ).toHaveText(OPS_PLATFORM.fullName);
      await expectNoHorizontalOverflow(page, 'project GitHub tab (ar)');
      await expectNoAxeViolations(page, 'project GitHub tab (ar)');

      await openTicket(page, ticket);
      await expect(page.getByTestId('ticket-github')).toBeVisible();
      await expect(page.getByText(ar.github.ticket.title, { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page, 'ticket GitHub panel (ar)');
      await expectNoAxeViolations(page, 'ticket GitHub panel (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });
});
