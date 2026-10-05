import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Browser, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import type { DemoUser } from '../support/auth.js';
import { makeApprovalOverdueForTest, setManagerForTest } from '../support/baseline.js';
import {
  asUser,
  emit,
  ensureGithub,
  ensureJira,
  fakeGithub,
  fakeJira,
  get,
  IHD,
  OPS_ID,
  OPS_PLATFORM,
  projectId,
  settled,
} from '../support/integration.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  dashboard: { needsAttention: string; executive: { pageTitle: string }; support: { pageTitle: string } };
  search: { placeholder: string };
};

const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const TMP = 'Traffic Management Platform';
const CAMERA_TICKET = 'Gate 3 camera feed drops every few minutes';
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true } as const;

/**
 * Phase 8 dashboards, Needs Attention, global search, the setup checklist and notification
 * preferences. Earlier spec files leave tickets, requests and projects behind, so no number is
 * hard-coded: every tile is checked against the list its link opens (paged to the end), against the
 * API, or against a change the test makes itself. Jira and GitHub use the deterministic fakes.
 */
interface RequestRef {
  readonly id: string;
  readonly key: string;
}

interface SearchBody {
  readonly groups: readonly {
    readonly type: string;
    readonly items: readonly { readonly id: string; readonly key: string | null; readonly title: string }[];
  }[];
}

interface ProjectsDashboardBody {
  readonly development: {
    readonly jira: { readonly open: number } | null;
    readonly github: { readonly open: number } | null;
  };
}

interface SetupChecklistBody {
  readonly items: readonly { readonly key: string; readonly done: boolean }[];
}

interface PreferencesBody {
  readonly items: readonly { readonly category: string; readonly email: boolean; readonly inApp: boolean }[];
}

/** Heading shown and every skeleton replaced by data. */
async function loaded(page: Page): Promise<void> {
  await settled(page);
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await loaded(page);
}

async function metricValue(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(`${testId}-value`).textContent()) ?? '';
  expect(text, `${testId} value`).toMatch(/^\d+$/);
  return Number(text);
}

/** Rows of a list screen after paging to the end ("Load more" until it disappears). */
async function listedRows(page: Page, testId: string): Promise<number> {
  await loaded(page);
  const rows = page.getByTestId(testId);
  const more = page.getByRole('button', { name: 'Load more', exact: true });
  while (await more.isVisible()) {
    const before = await rows.count();
    await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
    await expect(page.locator('.animate-pulse')).toHaveCount(0);
  }
  return rows.count();
}

/** Clicks a tile and checks that the list it opens holds exactly the number the tile showed. */
async function expectTileMatchesList(page: Page, tile: string, url: RegExp, rowTestId: string): Promise<number> {
  const value = await metricValue(page, tile);
  await expect(page.getByTestId(tile)).toHaveAccessibleName(new RegExp(`: ${String(value)}\\. Open the list$`));
  await page.getByTestId(tile).click();
  await expect(page).toHaveURL(url);
  expect(await listedRows(page, rowTestId), `${tile} = rows of ${page.url()}`).toBe(value);
  return value;
}

async function seededTypeId(page: Page, key: string): Promise<string> {
  const catalog = await get<{ id: string; key: string }[]>(page, '/api/v1/request-types');
  const id = catalog.find((type) => type.key === key)?.id;
  expect(id, `request type ${key}`).toBeDefined();
  return id ?? '';
}

async function submitWorkFromHome(page: Page, reason: string): Promise<RequestRef> {
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  const response = await page.request.post('/api/v1/requests', {
    headers: {
      origin: E2E_WEB_URL,
      'x-csrf-token': await csrfToken(page),
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    data: {
      requestTypeId: await seededTypeId(page, 'work_from_home'),
      formData: { dates: { start: `2027-05-${day}`, end: `2027-05-${day}` }, reason },
      submit: true,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: RequestRef }).data;
}

/**
 * A request of Emad Employee whose pending approval belongs to Paul (`pm`), made overdue. Paul's inbox
 * is small, so the item is never pushed out of the bounded Needs Attention rules by older work.
 */
async function overdueApprovalForPaul(browser: Browser, label: string): Promise<RequestRef> {
  const previous = await setManagerForTest('demo', 'EMP-00004', 'EMP-00041');
  try {
    const request = await asUser(browser, 'employee', (page) => submitWorkFromHome(page, `Dashboard ${label} ${RUN}`));
    await makeApprovalOverdueForTest(request.id);
    return request;
  } finally {
    await setManagerForTest('demo', 'EMP-00004', previous);
  }
}

async function search(page: Page, text: string): Promise<void> {
  if (await page.getByTestId('search-trigger').isVisible()) {
    await page.getByTestId('search-trigger').click();
  } else {
    await page.getByRole('button', { name: 'Open search' }).click();
  }
  const dialog = page.getByTestId('search-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('search-input').fill(text);
  await expect(dialog.getByText(/^\d+ results?$|^No results you can open\.$/)).toBeVisible();
}

async function searchApi(page: Page, text: string): Promise<SearchBody> {
  return get<SearchBody>(page, `/api/v1/search?q=${encodeURIComponent(text)}`);
}

async function noVisibleTable(page: Page, label: string): Promise<void> {
  await expect(page.locator('table:visible'), `${label}: no table on a phone`).toHaveCount(0);
}

test.describe('Phase 8: dashboards, Needs Attention, search and the operational home', () => {
  test('1. employee home: own numbers that open their lists, no management cards', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'employee');
    try {
      await open(page, '/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Emad');
      await expect(page.getByTestId('quick-actions').getByRole('link', { name: 'New request' })).toBeVisible();
      await expect(page.getByTestId('needs-attention')).toBeVisible();
      await expect(page.getByTestId('dashboard-freshness')).toContainText('Updated');
      await expect(page.getByTestId('home-insights')).toHaveCount(0);
      await expect(page.getByTestId('metric-assigned-tickets')).toHaveCount(0);
      await expectTileMatchesList(page, 'metric-my-requests', /\/requests\?status=/, 'request-row');
      await open(page, '/');
      await expectTileMatchesList(page, 'metric-my-tickets', /\/support\?view=/, 'ticket-row');
    } finally {
      await close();
    }
  });

  test('2. field employee mobile home at 375 px: quick actions first, cards only', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field', PHONE);
    try {
      await open(page, '/');
      const actions = page.getByTestId('quick-actions');
      await expect(actions.getByRole('link').first()).toHaveAttribute('href', '/attendance');
      await expect(actions.getByRole('link', { name: 'Report issue' })).toBeVisible();
      await expect(page.getByTestId('home-my-work')).toBeVisible();
      await expect(page.getByTestId('home-attendance')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
      await noVisibleTable(page, 'field home');
      await expectNoHorizontalOverflow(page, 'field home at 375 px');
      await actions.getByRole('button', { name: 'Search' }).click();
      await expect(page.getByTestId('search-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-dialog')).toBeHidden();
      await expectNoAxeViolations(page, 'field home at 375 px');
    } finally {
      await close();
    }
  });

  test('3. support dashboard: queue numbers, personal assignment and a trend with its values as text', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'support');
    try {
      await open(page, '/dashboards/support');
      await expect(page.getByRole('heading', { level: 1, name: 'Support dashboard' })).toBeVisible();
      for (const tile of ['open', 'new', 'assigned', 'critical', 'at-risk', 'breached', 'escalated', 'resolved']) {
        await expect(page.getByTestId(`metric-support-${tile}`)).toBeVisible();
      }
      const trend = page.getByTestId('trend-support_flow');
      await expect(trend.getByRole('img')).toHaveAccessibleName(/^Last 30 days: Created \d+, Resolved \d+$/);
      await trend.getByLabel('Time range').selectOption('7d');
      await expect(trend.getByRole('img')).toHaveAccessibleName(/^Last 7 days: Created \d+, Resolved \d+$/);
      await trend.getByText('Show the values').click();
      await expect(trend.locator('details li')).toHaveCount(7);
      await expect(trend).toContainText('(Africa/Cairo)');
    } finally {
      await close();
    }
  });

  test('4. project manager dashboard: only managed projects on the watchlist', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'pm');
    try {
      await open(page, '/dashboards/projects');
      await expect(page.getByRole('heading', { level: 1, name: 'Projects dashboard' })).toBeVisible();
      const watchlist = page.getByTestId('watch-project');
      await expect(watchlist.filter({ hasText: IHD })).toHaveCount(1);
      await expect(watchlist.filter({ hasText: TMP })).toHaveCount(0);
      await expect(page.getByTestId('metric-projects-missing-reports')).toContainText('Past the due time');
      await watchlist.filter({ hasText: IHD }).getByRole('link').click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+#overview$/);
      await expect(page.getByRole('heading', { level: 1, name: IHD })).toBeVisible();
    } finally {
      await close();
    }
  });

  test('5. executive dashboard: every section, with the same numbers as the role dashboards', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    try {
      await open(page, '/dashboards/executive');
      await expect(page.getByRole('heading', { level: 1, name: 'Executive dashboard' })).toBeVisible();
      for (const section of ['executive-attendance', 'executive-projects', 'executive-support', 'needs-attention']) {
        await expect(page.getByTestId(section)).toBeVisible();
      }
      await expect(page.getByTestId('trend-support_flow')).toBeVisible();
      await expect(page.getByTestId('trend-attendance_presence')).toBeVisible();
      const open_ = await metricValue(page, 'metric-support-open');
      const active = await metricValue(page, 'metric-projects-active');
      await open(page, '/dashboards/support');
      expect(await metricValue(page, 'metric-support-open')).toBe(open_);
      await open(page, '/dashboards/projects');
      expect(await metricValue(page, 'metric-projects-active')).toBe(active);
    } finally {
      await close();
    }
  });

  test('6. attendance tile opens the team day with exactly the employees it counts', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'hr');
    try {
      await open(page, '/dashboards/team');
      await expect(page.getByRole('heading', { level: 1, name: 'Team dashboard' })).toBeVisible();
      const count = await expectTileMatchesList(
        page,
        'metric-attendance-employees',
        /\/attendance\/team\?date=\d{4}-\d{2}-\d{2}#day$/,
        'team-day-row',
      );
      expect(count).toBeGreaterThan(30);
      await expect(page.locator('#team-day-bucket')).toHaveValue('');
    } finally {
      await close();
    }
  });

  test('7. overdue approvals tile opens the overdue inbox with the same items', async ({ browser }) => {
    const request = await overdueApprovalForPaul(browser, 'tile');
    const { page, close } = await contextFor(browser, 'pm');
    try {
      await open(page, '/');
      expect(await metricValue(page, 'metric-approvals-overdue')).toBeGreaterThanOrEqual(1);
      await expectTileMatchesList(page, 'metric-approvals-overdue', /\/approvals\?overdue=true$/, 'approval-item');
      await expect(page.getByTestId('approval-item').filter({ hasText: request.key })).toHaveCount(1);
    } finally {
      await close();
    }
  });

  test('8. support tile opens the ticket queue with exactly the tickets it counts', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'support');
    try {
      await open(page, '/dashboards/support');
      await expectTileMatchesList(page, 'metric-support-open', /\/support\?view=open$/, 'ticket-row');
      await open(page, '/dashboards/support');
      await expectTileMatchesList(
        page,
        'metric-support-breached',
        /\/support\?view=open&slaState=BREACHED$/,
        'ticket-row',
      );
      await expect(page.getByRole('combobox', { name: 'SLA', exact: true })).toHaveValue('BREACHED');
      await expect(page.getByTestId('linked-filter')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('9. project health tile opens the project list with exactly the projects it counts', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    try {
      await open(page, '/dashboards/projects');
      const active = await expectTileMatchesList(page, 'metric-projects-active', /\/projects\?status=/, 'project-row');
      expect(active).toBeGreaterThanOrEqual(3);
      await expect(page.getByTestId('project-row').filter({ hasText: TMP })).toHaveCount(1);
      await expect(page.getByTestId('linked-filter')).toBeVisible();
      await open(page, '/dashboards/projects');
      await expectTileMatchesList(
        page,
        'metric-projects-needs-attention',
        /\/projects\?status=[A-Z_%2C,]+&health=NEEDS_ATTENTION$/,
        'project-row',
      );
    } finally {
      await close();
    }
  });

  test('10. Jira numbers come from the synchronized cache, with freshness, and follow the next sync', async ({
    browser,
  }) => {
    await ensureJira(browser);
    const { page, close } = await contextFor(browser, 'pm');
    try {
      const ihd = await projectId(page, IHD);
      await open(page, '/dashboards/projects');
      const jira = page.getByTestId('dev-jira');
      await expect(jira.getByTestId('integration-freshness')).toContainText('Last sync');
      const before = await metricValue(page, 'metric-jira-open');
      const api = await get<ProjectsDashboardBody>(page, '/api/v1/dashboard/projects');
      expect(api.development.jira?.open).toBe(before);
      await expect(jira.getByRole('link', { name: new RegExp(IHD) })).toHaveAttribute('href', `/projects/${ihd}#jira`);

      // A new issue in Jira without a webhook: the dashboard never asks Jira, so the number stays.
      const issue = await fakeJira<{ id: string }>(page, '/issues', {
        projectId: OPS_ID,
        summary: `Dashboard cache ${RUN}`,
      });
      await page.getByRole('button', { name: 'Refresh' }).click();
      await loaded(page);
      expect(await metricValue(page, 'metric-jira-open')).toBe(before);

      // The webhook syncs it into the cache, which invalidates the Jira numbers.
      await fakeJira(page, '/webhooks/emit', { issue: issue.id, event: 'jira:issue_created' });
      await expect(async () => {
        await page.getByRole('button', { name: 'Refresh' }).click();
        await loaded(page);
        expect(await metricValue(page, 'metric-jira-open')).toBe(before + 1);
      }).toPass({ timeout: 60_000 });
    } finally {
      await close();
    }
  });

  test('11. GitHub numbers come from the synchronized cache, with freshness, and follow the next sync', async ({
    browser,
  }) => {
    const { ihd } = await ensureGithub(browser);
    const { page, close } = await contextFor(browser, 'pm');
    try {
      await open(page, '/dashboards/projects');
      const github = page.getByTestId('dev-github');
      await expect(github.getByTestId('integration-freshness')).toContainText('Last sync');
      const before = await metricValue(page, 'metric-github-open');
      const api = await get<ProjectsDashboardBody>(page, '/api/v1/dashboard/projects');
      expect(api.development.github?.open).toBe(before);
      await expect(github.getByRole('link', { name: new RegExp(IHD) })).toHaveAttribute(
        'href',
        `/projects/${ihd}#github`,
      );

      const pull = await fakeGithub<{ number: number }>(page, '/pulls', {
        repoId: OPS_PLATFORM.id,
        title: `Dashboard cache ${RUN}`,
      });
      await page.getByRole('button', { name: 'Refresh' }).click();
      await loaded(page);
      expect(await metricValue(page, 'metric-github-open')).toBe(before);

      await emit(page, { event: 'pull_request', action: 'opened', repoId: OPS_PLATFORM.id, number: pull.number });
      await expect(async () => {
        await page.getByRole('button', { name: 'Refresh' }).click();
        await loaded(page);
        expect(await metricValue(page, 'metric-github-open')).toBe(before + 1);
      }).toPass({ timeout: 60_000 });
    } finally {
      await close();
    }
  });

  test('12. Needs Attention item opens the request behind it', async ({ browser }) => {
    const request = await overdueApprovalForPaul(browser, 'attention');
    const { page, close } = await contextFor(browser, 'pm');
    try {
      const item = page.getByTestId('attention-item').filter({ hasText: `${request.key}: approval overdue` });
      await expect(async () => {
        await open(page, '/');
        const all = page.getByRole('button', { name: /^Show all \d+$/ });
        if (await all.isVisible()) await all.click();
        await expect(item).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 60_000 });
      await expect(item).toHaveAttribute('data-type', 'APPROVAL_OVERDUE');
      await expect(item).toHaveAttribute('data-severity', 'HIGH');
      await expect(item).toContainText('The approval passed its due time.');
      await item.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/requests/${request.id}$`));
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${request.key} · `) })).toBeVisible();
    } finally {
      await close();
    }
  });

  test('13. cards the member cannot open are hidden and the screens and API refuse them', async ({ browser }) => {
    const employee = await contextFor(browser, 'employee');
    try {
      const { page } = employee;
      await open(page, '/');
      await expect(page.getByTestId('home-insights')).toHaveCount(0);
      for (const name of ['Support dashboard', 'Projects dashboard', 'Team dashboard', 'Executive dashboard']) {
        await expect(page.getByRole('link', { name })).toHaveCount(0);
      }
      for (const path of ['/dashboards/executive', '/dashboards/support', '/dashboards/projects', '/dashboards/team']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
        await expect(page.locator('[data-testid^="metric-"]')).toHaveCount(0);
      }
      for (const route of ['executive', 'support', 'projects', 'team']) {
        expect((await page.request.get(`/api/v1/dashboard/${route}`)).status(), route).toBe(403);
      }
      expect((await page.request.get('/api/v1/organization/setup-checklist')).status()).toBe(403);
    } finally {
      await employee.close();
    }
    const pm = await contextFor(browser, 'pm');
    try {
      await open(pm.page, '/');
      const insights = pm.page.getByTestId('home-insights');
      await expect(insights.getByRole('link', { name: 'Projects dashboard' })).toBeVisible();
      await expect(insights.getByRole('link', { name: 'Executive dashboard' })).toHaveCount(0);
      expect((await pm.page.request.get('/api/v1/dashboard/executive')).status()).toBe(403);
    } finally {
      await pm.close();
    }
  });

  test('14. search finds a project the member can open and Enter opens it', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'pm');
    try {
      await open(page, '/');
      await page.keyboard.press('Control+k');
      await expect(page.getByTestId('search-dialog')).toBeVisible();
      await page.getByTestId('search-input').fill('Helpdesk Upgrade');
      const projects = page.getByTestId('search-group-projects');
      await expect(projects.getByTestId('search-result').filter({ hasText: IHD })).toHaveCount(1);
      await expect(page.getByTestId('search-input')).toHaveAttribute('aria-expanded', 'true');
      await page.getByTestId('search-input').press('Enter');
      await expect(page.getByTestId('search-dialog')).toBeHidden();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
      await expect(page.getByRole('heading', { level: 1, name: IHD })).toBeVisible();
    } finally {
      await close();
    }
  });

  test('15. search never shows a project outside the member scope', async ({ browser }) => {
    await asUser(browser, 'gm', async (page) => {
      expect((await searchApi(page, 'Traffic Management')).groups.find((g) => g.type === 'projects')?.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: TMP })]),
      );
    });
    const { page, close } = await contextFor(browser, 'pm');
    try {
      await open(page, '/');
      await search(page, 'Traffic Management');
      await expect(page.getByTestId('search-group-projects')).toHaveCount(0);
      await expect(page.getByTestId('search-dialog')).not.toContainText(TMP);
      const body = await searchApi(page, 'Traffic Management');
      expect(body.groups.flatMap((group) => group.items).some((item) => item.title === TMP)).toBe(false);
    } finally {
      await close();
    }
  });

  test('16. search finds a ticket by title and by its key', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'support');
    try {
      await open(page, '/');
      await search(page, 'camera feed drops');
      const hit = page
        .getByTestId('search-group-tickets')
        .getByTestId('search-result')
        .filter({ hasText: CAMERA_TICKET });
      await expect(hit).toHaveCount(1);
      const key = /SUP-\d+/.exec((await hit.textContent()) ?? '')?.[0] ?? '';
      expect(key).toMatch(/^SUP-\d+$/);
      await hit.click();
      await expect(page).toHaveURL(/\/support\/tickets\/[0-9a-f-]+$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(CAMERA_TICKET);
      await search(page, key);
      await expect(page.getByTestId('search-group-tickets').getByTestId('search-result').first()).toContainText(key);
    } finally {
      await close();
    }
  });

  test('17. search finds a request by key for its requester and approver, not for a peer', async ({ browser }) => {
    const request = await asUser(browser, 'org.admin', (page) => submitWorkFromHome(page, `Search ${RUN}`));
    const { page, close } = await contextFor(browser, 'org.admin');
    try {
      await open(page, '/');
      await search(page, request.key);
      const hit = page
        .getByTestId('search-group-requests')
        .getByTestId('search-result')
        .filter({ hasText: request.key });
      await expect(hit).toHaveCount(1);
      await hit.click();
      await expect(page).toHaveURL(new RegExp(`/requests/${request.id}$`));
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${request.key} · `) })).toBeVisible();
    } finally {
      await close();
    }
    // George Manager approves Olivia's requests; Emad Employee is unrelated to them.
    await asUser(browser, 'gm', async (page) => {
      const requests = (await searchApi(page, request.key)).groups.find((group) => group.type === 'requests');
      expect(requests?.items.map((item) => item.id)).toContain(request.id);
    });
    await asUser(browser, 'employee', async (page) => {
      const body = await searchApi(page, request.key);
      expect(body.groups.flatMap((group) => group.items).some((item) => item.id === request.id)).toBe(false);
    });
  });

  test('18. setup checklist reflects the organization state, including a connected Jira', async ({ browser }) => {
    await ensureJira(browser);
    const { page, close } = await contextFor(browser, 'org.admin');
    try {
      const state = await get<SetupChecklistBody>(page, '/api/v1/organization/setup-checklist');
      await open(page, '/admin/setup');
      await expect(page.getByRole('heading', { level: 1, name: 'Setup checklist' })).toBeVisible();
      const items = page.getByTestId('setup-item');
      await expect(items).toHaveCount(state.items.length);
      for (const item of state.items) {
        await expect(items.and(page.locator(`[data-key="${item.key}"]`))).toHaveAttribute(
          'data-done',
          item.done ? 'true' : 'false',
        );
      }
      await expect(page.locator('[data-testid="setup-item"][data-key="jira"]')).toHaveAttribute('data-done', 'true');
      await expect(page.locator('[data-testid="setup-item"][data-key="departments"]')).toHaveAttribute(
        'data-done',
        'true',
      );
      await page.getByRole('link', { name: 'Review Departments' }).click();
      await expect(page).toHaveURL(/\/departments$/);
    } finally {
      await close();
    }
  });

  test('19. notification preference change is saved per member; security notices stay locked', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'employee');
    const toggle = page.getByTestId('pref-PROJECTS-EMAIL');
    try {
      await open(page, '/notifications/preferences');
      await expect(page.getByRole('heading', { level: 1, name: 'Notification preferences' })).toBeVisible();
      await expect(page.getByTestId('pref-ACCESS-IN_APP')).toBeDisabled();
      await expect(page.getByTestId('pref-ACCESS-IN_APP')).toBeChecked();
      await expect(page.locator('[data-testid="preference-row"][data-category="ACCESS"]')).toContainText('Always on');
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(page.getByText('Preferences saved.')).toBeVisible();
      await page.reload();
      await loaded(page);
      await expect(toggle).not.toBeChecked();
      const mine = await get<PreferencesBody>(page, '/api/v1/notifications/preferences');
      expect(mine.items.find((item) => item.category === 'PROJECTS')?.email).toBe(false);
      await asUser(browser, 'hr', async (other) => {
        const theirs = await get<PreferencesBody>(other, '/api/v1/notifications/preferences');
        expect(theirs.items.find((item) => item.category === 'PROJECTS')?.email).toBe(true);
      });
      const refused = await page.request.put('/api/v1/notifications/preferences', {
        headers: { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' },
        data: { items: [{ category: 'ACCESS', channel: 'IN_APP', enabled: false }] },
      });
      expect(refused.status()).toBe(400);
    } finally {
      if (!(await toggle.isChecked())) {
        await toggle.check();
        await expect(page.getByText('Preferences saved.')).toBeVisible();
      }
      await close();
    }
  });

  test('20. phone layout at 375 px: dashboards as cards, tiles open card lists, search from the header', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'gm', PHONE);
    try {
      for (const path of [
        '/',
        '/dashboards/executive',
        '/dashboards/support',
        '/dashboards/projects',
        '/dashboards/team',
      ]) {
        await open(page, path);
        await noVisibleTable(page, path);
        await expectNoHorizontalOverflow(page, `${path} at 375 px`);
      }
      await page.getByTestId('metric-attendance-employees').click();
      await loaded(page);
      await expect(page.getByTestId('team-day-card').first()).toBeVisible();
      await noVisibleTable(page, 'team day');
      await open(page, '/');
      await search(page, 'Traffic Management');
      await expect(page.getByTestId('search-group-projects')).toContainText(TMP);
      await expectNoHorizontalOverflow(page, 'search at 375 px');
    } finally {
      await close();
    }
  });

  test('21. Arabic: dashboards and search right to left', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await open(page, '/dashboards/executive');
      await expect(page.getByRole('heading', { level: 1, name: ar.dashboard.executive.pageTitle })).toBeVisible();
      await expect(page.getByTestId('needs-attention')).toContainText(ar.dashboard.needsAttention);
      await expectNoHorizontalOverflow(page, '/dashboards/executive (ar)');
      await expectNoAxeViolations(page, '/dashboards/executive (ar)');
      await open(page, '/dashboards/support');
      await expect(page.getByRole('heading', { level: 1, name: ar.dashboard.support.pageTitle })).toBeVisible();
      await page.keyboard.press('Control+k');
      await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', ar.search.placeholder);
      await page.getByTestId('search-input').fill('Traffic');
      await expect(page.getByTestId('search-group-projects')).toContainText(TMP);
      await expectNoAxeViolations(page, 'search (ar)');
    } finally {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search-dialog')).toBeHidden();
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  for (const width of WIDTHS) {
    test(`22. accessibility and layout of the Phase 8 screens at ${String(width)} px`, async ({ browser }) => {
      test.setTimeout(240_000);
      const viewport = { width, height: 900 };
      const label = (name: string): string => `${name} at ${String(width)} px`;
      const sessions: readonly [DemoUser, readonly string[]][] = [
        ['gm', ['/', '/dashboards/executive', '/dashboards/support', '/dashboards/projects', '/dashboards/team']],
        ['org.admin', ['/admin/setup', '/notifications/preferences']],
      ];
      for (const [user, paths] of sessions) {
        const { page, close } = await contextFor(browser, user, { viewport });
        try {
          for (const path of paths) {
            await open(page, path);
            await expectNoHorizontalOverflow(page, label(`${user} ${path}`));
            await expectNoAxeViolations(page, label(`${user} ${path}`));
          }
          if (user === 'gm') {
            await search(page, 'Traffic');
            await expectNoAxeViolations(page, label('search dialog'));
          }
        } finally {
          await close();
        }
      }
    });
  }
});

test.describe('Phase 8: dashboard writes are refused without the session protections', () => {
  test('preference update without CSRF is refused and nothing changes', async ({ browser }) => {
    await asUser(browser, 'employee', async (page) => {
      const before = await get<PreferencesBody>(page, '/api/v1/notifications/preferences');
      const response = await page.request.put('/api/v1/notifications/preferences', {
        headers: { origin: E2E_WEB_URL, 'content-type': 'application/json' },
        data: { items: [{ category: 'SUPPORT', channel: 'EMAIL', enabled: false }] },
      });
      expect(response.status()).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CSRF_INVALID');
      expect(await get<PreferencesBody>(page, '/api/v1/notifications/preferences')).toEqual(before);
    });
  });
});
