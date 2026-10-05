import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import {
  asUser,
  ensureJira,
  fakeJira as fake,
  get,
  IHD,
  OPS_ID,
  projectId,
  send,
  settled,
} from '../support/integration.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  jira: { ticket: { link: string }; project: { sourceOfTruth: string } };
  projects: { tabs: { jira: string } };
};

const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const POS = 'Retail POS Rollout';
/** Fake Jira fixture (packages/core/src/testing/fake-jira.ts): project ids and the seeded issues. */
const MOB_ID = '20002';
const SITE_URL = 'https://fake-jira.example.test';

/**
 * Phase 4 against the deterministic Atlassian double started by global setup (never a real Jira
 * site). Every test establishes the Jira state it needs through `ensureJira` (connect + map IHD to
 * OPS + wait for the import) and creates its own tickets and fake issues, so the scenarios pass in
 * any order and never depend on another test's grants or data.
 */
const uniqueTitle = (label: string): string => `E2E Jira ${label} ${RUN}`;

interface TicketRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
}

interface IssueRef {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
}

async function createTicket(page: Page, title: string, project: string = IHD): Promise<TicketRef> {
  return send<TicketRef>(page, 'POST', '/api/v1/support/tickets', {
    title,
    description: `Steps to reproduce for ${title}.`,
    severity: 'MEDIUM',
    impact: 'SINGLE_USER',
    source: 'INTERNAL',
    projectId: await projectId(page, project),
  });
}

/** A new issue in the fake OPS project, pulled into the cache through a live search, then linked. */
async function linkNewIssue(
  page: Page,
  ticket: TicketRef,
  summary: string,
  statusName = 'In Progress',
): Promise<IssueRef> {
  const created = await fake<{ id: string; key: string }>(page, '/issues', {
    projectId: OPS_ID,
    summary,
    statusName,
    statusCategory: 'indeterminate',
  });
  const results = await get<IssueRef[]>(
    page,
    `/api/v1/support/tickets/${ticket.id}/jira/search?source=jira&q=${encodeURIComponent(created.key)}`,
  );
  const issue = results.find((row) => row.key === created.key);
  if (issue === undefined) {
    throw new Error(`Live search did not return ${created.key}`);
  }
  await send(page, 'POST', `/api/v1/support/tickets/${ticket.id}/jira/links`, {
    issueId: issue.id,
    linkType: 'RELATED',
  });
  return issue;
}

async function openTicket(page: Page, ticket: TicketRef): Promise<void> {
  await page.goto(`/support/tickets/${ticket.id}`);
  await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test.describe('Phase 4 Jira integration', () => {
  test('1-2. the integration manager opens Jira settings and completes the OAuth connection', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'org.admin');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Jira integration' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Jira integration' })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByText(`OAuth redirect URI: ${E2E_WEB_URL}/api/v1/integrations/jira/callback`)).toBeVisible();

    // Consent goes through the Atlassian authorize page (the fake approves) and back to the callback.
    const connect = page.getByRole('button', { name: 'Connect Jira' });
    const reauthorize = page.getByRole('button', { name: 'Reauthorize' });
    await expect(connect.or(reauthorize)).toBeVisible();
    await ((await connect.isVisible()) ? connect : reauthorize).click();
    await page.waitForURL(/\/admin\/integrations\/jira\?jira=connected/);
    await expect(page.getByRole('status').filter({ hasText: 'Jira connected.' })).toBeVisible();
    const connection = page.getByTestId('jira-connection');
    await expect(connection).toContainText('Fake Jira');
    await expect(connection).toContainText(SITE_URL);
    await expect(
      connection
        .locator('div')
        .filter({ hasText: /^Status/ })
        .locator('dd'),
    ).toHaveText('Connected');
    // Tokens never reach the browser.
    const body = await page.request.get('/api/v1/integrations/jira');
    expect(await body.text()).not.toMatch(/access_token|refresh_token|fake-access|fake-refresh/);
    await close();
  });

  test('3-6. maps a project, imports it with progress and fills the project Jira tab', async ({ browser }) => {
    await ensureJira(browser);
    const blockedSummary = uniqueTitle('waiting on vendor');
    const { page, close } = await contextFor(browser, 'org.admin');
    await fake(page, '/issues', {
      projectId: MOB_ID,
      summary: blockedSummary,
      statusName: 'Blocked',
      statusCategory: 'indeterminate',
    });
    for (let index = 0; index < 6; index += 1) {
      await fake(page, '/issues', { projectId: MOB_ID, summary: `${uniqueTitle('mobile backlog')} #${String(index)}` });
    }
    const pos = await projectId(page, POS);

    await page.goto('/admin/integrations/jira');
    await settled(page);
    await page.getByRole('button', { name: 'Add mapping' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add mapping' });
    await dialog.getByLabel('Project', { exact: true }).selectOption(pos);
    await dialog.getByLabel('Search Jira projects').fill('MOB');
    const jiraProject = dialog.getByLabel('Jira project', { exact: true });
    await expect(jiraProject.locator(`option[value="${MOB_ID}"]`)).toHaveCount(1);
    await jiraProject.selectOption(MOB_ID);
    await dialog.getByLabel(/^Blocked statuses/).fill('Blocked');
    await dialog.getByRole('button', { name: 'Add mapping' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('status').filter({ hasText: 'Mapped MOB → POS. The initial import has been queued.' }),
    ).toBeVisible();

    // Progress is pushed while the worker imports; it ends at 100 % and the mapping reads "Imported".
    const row = page.getByTestId('jira-mapping').filter({ hasText: 'MOB · Mobile App' });
    await expect(row.getByRole('progressbar', { name: 'Sync progress for MOB' })).toHaveAttribute(
      'aria-valuenow',
      '100',
      {
        timeout: 60_000,
      },
    );
    await expect(row).toContainText('Imported');
    await expect(row).toContainText('8 issues');

    await page.getByRole('link', { name: 'Sync history' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Jira sync history' })).toBeVisible();
    const run = page.getByTestId('jira-run').filter({ hasText: 'MOB → POS' }).first();
    await expect(run).toContainText('Initial import');
    await expect(run).toContainText('Succeeded');

    await page.goto(`/projects/${pos}#jira`);
    await expect(page.getByRole('tab', { name: 'Jira' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByText('Jira is the source of truth. This is a synced, read-only view.')).toBeVisible();
    const stat = (label: string) =>
      page
        .locator('dl > div')
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator('dd');
    await expect(stat('Open issues')).toHaveText('8');
    await expect(stat('Blocked')).toHaveText('1');
    const recent = page.getByRole('list', { name: 'Recently updated issues' });
    await expect(recent).toContainText(blockedSummary);
    const deepLink = recent.getByRole('link', { name: /^Open MOB-\d+ in Jira \(opens in a new tab\)$/ }).first();
    await expect(deepLink).toHaveAttribute('href', new RegExp(`^${SITE_URL}/browse/MOB-\\d+$`));
    await expect(deepLink).toHaveAttribute('target', '_blank');
    await close();
  });

  test('7-10. a support agent searches Jira, links an issue and sees it with a deep link', async ({ browser }) => {
    await ensureJira(browser);
    const { page, close } = await contextFor(browser, 'support');
    const ticket = await createTicket(page, uniqueTitle('Safari sign-in'));
    await openTicket(page, ticket);
    const panel = page.getByTestId('ticket-jira');
    await expect(panel).toContainText('No linked Jira issues.');

    await panel.getByRole('button', { name: 'Link issue' }).click();
    const dialog = page.getByRole('dialog', { name: `Link a Jira issue to ${ticket.key}` });
    // Synced (cached) issues first, then live from Jira.
    await dialog.getByLabel('Search issues').fill('Safari');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    const results = dialog.getByRole('list', { name: 'Search results' });
    await expect(results).toContainText('Login fails on Safari');
    await dialog.getByLabel('Source').selectOption('jira');
    await dialog.getByLabel('Search issues').fill('CSV');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(results).toContainText('Export to CSV times out');
    await dialog.getByLabel('Search issues').fill('Safari');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await dialog.getByLabel('Link type').selectOption('CAUSED_BY');
    await results.getByRole('button', { name: 'Link OPS-1' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Linked OPS-1.' })).toBeVisible();

    const link = panel.getByTestId('jira-link').filter({ hasText: 'OPS-1' });
    await expect(link).toContainText('Login fails on Safari');
    await expect(link).toContainText('In Progress');
    await expect(link).toContainText('Caused by');
    const deepLink = link.getByRole('link', { name: 'Open OPS-1 in Jira (opens in a new tab)' });
    await expect(deepLink).toHaveAttribute('href', `${SITE_URL}/browse/OPS-1`);
    await expect(deepLink).toHaveAttribute('rel', /noopener/);
    await expect(page.getByTestId('ticket-history')).toContainText('Sara Support · Linked Jira issue OPS-1');
    await close();
  });

  test('11-12. creates a Jira issue from a ticket; internal notes and attachments never reach Jira', async ({
    browser,
  }) => {
    await ensureJira(browser);
    const secret = `Internal triage secret ${RUN}`;
    const { page, close } = await contextFor(browser, 'support');
    const ticket = await createTicket(page, uniqueTitle('Create from ticket'));
    await send(page, 'POST', `/api/v1/support/tickets/${ticket.id}/comments`, {
      body: secret,
      visibility: 'INTERNAL_NOTE',
    });
    await openTicket(page, ticket);

    const panel = page.getByTestId('ticket-jira');
    await panel.getByRole('button', { name: 'Create issue' }).click();
    const dialog = page.getByRole('dialog', { name: `Create a Jira issue from ${ticket.key}` });
    await expect(dialog).toContainText('Internal notes and attachments are never sent.');
    await expect(dialog.getByLabel('Issue type')).toHaveValue('10001');
    await expect(dialog.getByLabel('Issue type').locator('option')).toHaveText(['Bug', 'Task']);
    await expect(dialog.getByLabel('Summary')).toHaveValue(ticket.title);
    await dialog.getByRole('button', { name: 'Create in Jira' }).click();
    await expect(dialog).toBeHidden();
    const created = page.getByRole('status').filter({ hasText: /^Created OPS-\d+ in Jira\.$/ });
    await expect(created).toBeVisible();
    const key = /OPS-\d+/.exec((await created.textContent()) ?? '')?.[0] ?? '';

    const link = panel.getByTestId('jira-link').filter({ hasText: key });
    await expect(link).toContainText('Created from this ticket');
    await expect(link).toContainText('Fix tracked by');
    await expect(page.getByTestId('ticket-history')).toContainText(`Sara Support · Created Jira issue ${key}`);

    // Exactly what was sent to Jira: summary + description + a link back, never the internal note.
    const state = await fake<{ createdIssues: { key: string; fields: Record<string, unknown> }[] }>(page, '/state');
    const sent = state.createdIssues.filter((issue) => issue.fields.summary === ticket.title);
    expect(sent.map((issue) => issue.key)).toEqual([key]);
    const payload = JSON.stringify(sent[0]?.fields);
    expect(payload).not.toContain(secret);
    expect(payload).not.toMatch(/attachment/i);
    expect(payload).toContain(`/support/tickets/${ticket.id}`);
    // Creating the issue never changes the ticket's status.
    expect((await get<TicketRef>(page, `/api/v1/support/tickets/${ticket.id}`)).status).toBe(ticket.status);
    await close();
  });

  test('13. a Jira status change arrives by webhook as a signal and leaves the ticket lifecycle alone', async ({
    browser,
  }) => {
    await ensureJira(browser);
    const { page, close } = await contextFor(browser, 'support');
    const ticket = await createTicket(page, uniqueTitle('Status signal'));
    const issue = await linkNewIssue(page, ticket, uniqueTitle('status probe'));
    await openTicket(page, ticket);
    const link = page.getByTestId('jira-link').filter({ hasText: issue.key });
    await expect(link).toContainText('In Progress');

    await fake(page, '/issues/update', { issue: issue.key, statusName: 'Done', statusCategory: 'done' });
    const emitted = await fake<{ deliveries: { status: number }[] }>(page, '/webhooks/emit', {
      issue: issue.key,
      event: 'jira:issue_updated',
    });
    expect(emitted.deliveries.map((delivery) => delivery.status)).toContain(202);

    await expect(async () => {
      await page.reload();
      await expect(link).toContainText('Done', { timeout: 2_000 });
      await expect(page.getByTestId('ticket-history')).toContainText(
        'System · Jira status changed from In Progress to Done',
        {
          timeout: 2_000,
        },
      );
    }).toPass({ timeout: 60_000 });
    const after = await get<TicketRef>(page, `/api/v1/support/tickets/${ticket.id}`);
    expect(after.status).toBe(ticket.status);
    await close();
  });

  test('14. unlinking follows policy: viewers see links, only link holders unlink', async ({ browser }) => {
    await ensureJira(browser);
    const { ticket, issue } = await asUser(browser, 'support', async (page) => {
      const created = await createTicket(page, uniqueTitle('Unlink policy'));
      return { ticket: created, issue: await linkNewIssue(page, created, uniqueTitle('unlink probe')) };
    });

    // The general manager holds jira.view only: the link is visible, but there is nothing to change.
    await asUser(browser, 'gm', async (page) => {
      await openTicket(page, ticket);
      const panel = page.getByTestId('ticket-jira');
      await expect(panel.getByTestId('jira-link')).toContainText(issue.key);
      await expect(panel.getByRole('button', { name: `Unlink ${issue.key}` })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Link issue' })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Create issue' })).toHaveCount(0);
    });

    const { page, close } = await contextFor(browser, 'support');
    await openTicket(page, ticket);
    await page.getByRole('button', { name: `Unlink ${issue.key}` }).click();
    await expect(page.getByRole('status').filter({ hasText: `Unlinked ${issue.key}.` })).toBeVisible();
    await expect(page.getByTestId('jira-link')).toHaveCount(0);
    await expect(page.getByTestId('ticket-history')).toContainText(`Sara Support · Unlinked Jira issue ${issue.key}`);
    await close();
  });

  test('15. members without the permission cannot manage Jira or see the Development panel', async ({ browser }) => {
    await ensureJira(browser);
    await asUser(browser, 'gm', async (page) => {
      await expect(
        page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Jira integration' }),
      ).toHaveCount(0);
      await page.goto('/admin/integrations/jira');
      await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
      await page.goto('/admin/integrations/jira/sync');
      await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
      const response = await page.request.post('/api/v1/integrations/jira/mappings', {
        headers: { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' },
        data: { projectId: await projectId(page, IHD), jiraProjectId: MOB_ID },
      });
      expect(response.status()).toBe(403);
    });
    await asUser(browser, 'field', async (page) => {
      const ticket = await send<TicketRef>(page, 'POST', '/api/v1/support/tickets', {
        title: uniqueTitle('Field report'),
        description: 'Camera offline at gate 2.',
        severity: 'LOW',
        impact: 'SINGLE_USER',
      });
      await openTicket(page, ticket);
      await expect(page.getByTestId('ticket-history')).toBeVisible();
      await expect(page.getByTestId('ticket-jira')).toHaveCount(0);
      const panel = await get<{ visible: boolean; links: unknown[] }>(
        page,
        `/api/v1/support/tickets/${ticket.id}/jira`,
      );
      expect(panel).toMatchObject({ visible: false, links: [] });
    });
  });

  for (const width of WIDTHS) {
    test(`16. responsive layout and axe on the Jira screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      await ensureJira(browser);
      const ticket = await asUser(browser, 'support', async (page) => {
        const created = await createTicket(page, uniqueTitle(`Axe ${String(width)}`));
        await linkNewIssue(
          page,
          created,
          `${uniqueTitle('axe probe')} with a deliberately long summary to check wrapping at ${String(width)} px`,
        );
        return created;
      });

      const admin = await contextFor(browser, 'org.admin', { viewport });
      for (const path of ['/admin/integrations/jira', '/admin/integrations/jira/sync']) {
        await admin.page.goto(path);
        await settled(admin.page);
        await expectNoHorizontalOverflow(admin.page, `${path} at ${String(width)} px`);
        await expectNoAxeViolations(admin.page, `${path} at ${String(width)} px`);
      }
      await admin.page.goto('/admin/integrations/jira');
      await settled(admin.page);
      await admin.page.getByRole('button', { name: 'Add mapping' }).click();
      await expect(admin.page.getByRole('dialog', { name: 'Add mapping' })).toBeVisible();
      await expectNoAxeViolations(admin.page, `add mapping dialog at ${String(width)} px`);
      const ihd = await projectId(admin.page, IHD);
      await admin.page.goto(`/projects/${ihd}#jira`);
      await expect(admin.page.getByRole('tab', { name: 'Jira' })).toHaveAttribute('aria-selected', 'true');
      await expect(admin.page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(admin.page.getByText('Open issues', { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(admin.page, `project Jira tab at ${String(width)} px`);
      await expectNoAxeViolations(admin.page, `project Jira tab at ${String(width)} px`);
      await admin.close();

      const agent = await contextFor(browser, 'support', { viewport });
      await openTicket(agent.page, ticket);
      await expect(agent.page.getByTestId('jira-link')).toHaveCount(1);
      await expectNoHorizontalOverflow(agent.page, `ticket Jira panel at ${String(width)} px`);
      await expectNoAxeViolations(agent.page, `ticket Jira panel at ${String(width)} px`);
      await agent.page.getByTestId('ticket-jira').getByRole('button', { name: 'Link issue' }).click();
      const linkDialog = agent.page.getByRole('dialog', { name: `Link a Jira issue to ${ticket.key}` });
      await expect(linkDialog.getByRole('list', { name: 'Search results' })).toBeVisible();
      await expectNoAxeViolations(agent.page, `link dialog at ${String(width)} px`);
      await linkDialog.getByRole('button', { name: 'Close' }).click();
      await agent.page.getByTestId('ticket-jira').getByRole('button', { name: 'Create issue' }).click();
      await expect(agent.page.getByRole('dialog', { name: `Create a Jira issue from ${ticket.key}` })).toBeVisible();
      await expectNoAxeViolations(agent.page, `create issue dialog at ${String(width)} px`);
      await agent.close();
    });
  }

  test('17. RTL: the Jira panel and project tab render right-to-left in Arabic', async ({ browser }) => {
    await ensureJira(browser);
    const ticket = await asUser(browser, 'support', async (page) => {
      const created = await createTicket(page, uniqueTitle('RTL'));
      await linkNewIssue(page, created, uniqueTitle('rtl probe'));
      return created;
    });
    // The IHD project manager holds jira.* for IHD only (project scope).
    const { page, close } = await contextFor(browser, 'pm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await openTicket(page, ticket);
      const panel = page.getByTestId('ticket-jira');
      await expect(panel.getByTestId('jira-link')).toHaveCount(1);
      await expect(panel.getByRole('button', { name: ar.jira.ticket.link })).toBeVisible();
      await expectNoHorizontalOverflow(page, 'ticket Jira panel (ar)');
      await expectNoAxeViolations(page, 'ticket Jira panel (ar)');

      await page.goto(`/projects/${await projectId(page, IHD)}#jira`);
      await expect(page.getByRole('tab', { name: ar.projects.tabs.jira })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.getByText(ar.jira.project.sourceOfTruth)).toBeVisible();
      await expectNoHorizontalOverflow(page, 'project Jira tab (ar)');
      await expectNoAxeViolations(page, 'project Jira tab (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });
});
