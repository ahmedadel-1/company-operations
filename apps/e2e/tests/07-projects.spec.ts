import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  projects: { title: string; sections: string; tabs: { overview: string; team: string } };
};

const CUSTOMER = 'E2E Logistics';
const PROJECT = 'E2E Fleet Tracking';
const WORK = 'Installed tracking units on 12 trucks; two need a firmware update.';
/** A valid 1×1 PNG: attachments are checked by content, not by the file extension. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from('%PDF-1.7\n%e2e attachment\n');
const WIDTHS = [375, 768, 1024, 1440] as const;

/** Shared by the serial flow below: set by the create and submit steps. */
const state = { projectPath: '', reportPath: '' };

async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test.describe.serial('Phase 2 projects', () => {
  test('1. a manager opens the project list, filters it and sees the seeded projects', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Projects', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table.getByRole('link', { name: 'Traffic Management Platform' })).toBeVisible();
    await expect(table.getByRole('link', { name: 'Retail POS Rollout' })).toBeVisible();

    await page.getByLabel('Status').selectOption({ label: 'Active' });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(table.getByRole('link', { name: 'Traffic Management Platform' })).toBeVisible();
    await expect(table.getByRole('link', { name: 'Retail POS Rollout' })).toHaveCount(0);

    await page.getByLabel('Search', { exact: true }).fill('no-such-project');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No projects match these filters.')).toBeVisible();
    await close();
  });

  test('2. the manager creates a customer and a project for it', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto('/customers');
    await settled(page);
    await page.getByRole('button', { name: 'New customer' }).click();
    const customerDialog = page.getByRole('dialog', { name: 'New customer' });
    await customerDialog.getByLabel('Name', { exact: true }).fill(CUSTOMER);
    await customerDialog.getByLabel('Type').selectOption({ label: 'Private' });
    await customerDialog.getByLabel(/^Contact email/).fill('ops@e2e-logistics.example.test');
    await customerDialog.getByRole('button', { name: 'Save' }).click();
    await expect(customerDialog).toBeHidden();
    await expect(page.getByRole('table')).toContainText(CUSTOMER);

    await page.goto('/projects');
    await settled(page);
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByLabel('Name', { exact: true }).fill(PROJECT);
    await dialog.getByLabel(/^Customer/).selectOption({ label: CUSTOMER });
    const technical = dialog.getByRole('group', { name: 'Technical manager' });
    await technical.getByRole('searchbox').fill('Mina');
    await technical.getByRole('radio', { name: /Mina Manager/ }).check();
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    state.projectPath = new URL(page.url()).pathname;
    // The code comes from the organization counter when none is entered.
    await expect(page.getByText(new RegExp(`PRJ-\\d+ · ${CUSTOMER}`))).toBeVisible();
    await close();
  });

  test('3. the project detail shows its tabs, including the GitHub tab', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto(state.projectPath);
    await settled(page);
    const tabs = page.getByRole('tablist', { name: 'Project sections' });
    for (const name of ['Overview', 'Team', 'Daily reports', 'Support', 'Jira', 'GitHub', 'Activity', 'Settings']) {
      await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();
    }
    await expect(tabs.getByRole('tab', { name: /Available in a later release/ })).toHaveCount(0);
    await expect(page.getByRole('tabpanel').getByText('Mina Manager')).toBeVisible();
    await expect(page.getByText('Daily reports are optional for this project.')).toBeVisible();

    // Keyboard navigation between tabs (WAI-ARIA tabs pattern).
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Team' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
    await expectNoAxeViolations(page, 'project detail, team tab');
    await close();
  });

  test('4. the manager assigns a field employee and requires daily reports', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto(`${state.projectPath}#team`);
    await settled(page);
    const add = page.getByRole('group', { name: 'Employee' });
    await add.getByRole('searchbox').fill('Fatma');
    await add.getByRole('radio', { name: /Fatma Field/ }).check();
    await page.getByLabel('Project role', { exact: true }).selectOption({ label: 'Field' });
    await page.getByRole('button', { name: 'Add member' }).click();
    const members = page.getByTestId('project-members');
    await expect(members.getByRole('link', { name: 'Fatma Field' })).toBeVisible();
    await expect(page.getByLabel('Project role of Fatma Field')).toHaveValue('FIELD');

    await openTab(page, 'Settings');
    const required = page.getByRole('checkbox', { name: 'Daily reports are required' });
    const policy = page.locator('form').filter({ has: required });
    await required.check();
    await policy.getByRole('button', { name: 'Save' }).click();
    await expect(policy.getByText('Project saved.')).toBeVisible();
    await expectNoAxeViolations(page, 'project settings');
    await close();
  });

  test('5. the new member sees the project and is notified', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field');
    await page.goto('/projects');
    await settled(page);
    await expect(page.getByRole('link', { name: PROJECT })).toBeVisible();
    // Field employees only see projects they are assigned to.
    await expect(page.getByRole('link', { name: 'Traffic Management Platform' })).toHaveCount(0);
    await expect(async () => {
      await page.goto('/notifications');
      await expect(page.getByText(new RegExp(`You were added to ${PROJECT}`))).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await close();
  });

  test('6. an employee who is not on a project cannot see it in the UI or through the API', async ({ browser }) => {
    // The field employee holds PROJECT-scoped grants (view, submit reports) but is not on this project.
    const manager = await contextFor(browser, 'manager');
    const found = await manager.page.request.get('/api/v1/projects?q=Traffic%20Management');
    expect(found.status()).toBe(200);
    const { data } = (await found.json()) as { data: { id: string; name: string }[] };
    const id = data.find((project) => project.name === 'Traffic Management Platform')?.id ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await manager.close();

    const { page, close } = await contextFor(browser, 'field');
    await page.goto('/projects');
    await settled(page);
    await expect(page.getByRole('link', { name: PROJECT })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Traffic Management Platform' })).toHaveCount(0);
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    expect((await page.request.get(`/api/v1/projects/${id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/v1/projects/${id}/members`)).status()).toBe(404);
    expect((await page.request.get(`/api/v1/projects/${id}/activity`)).status()).toBe(404);
    const headers = { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' };
    const report = await page.request.post(`/api/v1/projects/${id}/daily-reports`, {
      headers,
      data: { systemStatus: 'NORMAL', workPerformed: 'Not my project' },
    });
    expect(report.status()).toBe(404);
    await close();
  });

  test('7. the manager activates the project and records its health with a note', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto(`${state.projectPath}#settings`);
    await settled(page);
    await page.locator('#project-status').selectOption({ label: 'Active' });
    await page.getByLabel(/^Status reason/).fill('Kick-off completed');
    await page.getByRole('button', { name: 'Change status' }).click();
    await expect(page.getByRole('button', { name: 'Change status' })).toBeDisabled();

    await page.locator('#project-health').selectOption({ label: 'At risk' });
    await page.getByLabel('Health note').fill('Firmware supplier is two weeks late.');
    await page.getByRole('button', { name: 'Update health' }).click();
    await expect(page.getByLabel('Health note')).toHaveValue('');

    await openTab(page, 'Overview');
    await expect(page.getByText('Firmware supplier is two weeks late.')).toBeVisible();
    await expect(page.getByText('Kick-off completed')).toBeVisible();
    await expect(page.getByText('Daily reports are required, due by 18:00 (project time).')).toBeVisible();
    await close();
  });

  test('8. the member submits today’s daily report', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field');
    await page.goto(`${state.projectPath}#reports`);
    await settled(page);
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Submit report' }) });
    await form.getByLabel('System status').selectOption({ label: 'Degraded' });
    await form.getByLabel('Work performed').fill(WORK);
    await form.getByLabel(/^Problems/).fill('Firmware 2.1 missing on two units.');
    await form.getByRole('button', { name: 'Submit report' }).click();
    await expect(page).toHaveURL(/\/daily-reports\/[0-9a-f-]{36}\?submitted=1$/);
    await expect(page.getByText('Report submitted. You can add photos or documents below.')).toBeVisible();
    await expect(page.getByText(WORK)).toBeVisible();
    state.reportPath = new URL(page.url()).pathname;

    // One report per person, project and day: a second submission is refused.
    await page.goto(`${state.projectPath}#reports`);
    await settled(page);
    await page.getByLabel('Work performed').fill('Second report the same day');
    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await close();
  });

  test('9. the member uploads, downloads and deletes report attachments', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field');
    await page.goto(state.reportPath);
    await settled(page);
    const input = page.getByLabel('Add a photo or document');

    await input.setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(page.getByText('This file type is not allowed. Use JPEG, PNG, WebP or PDF.')).toBeVisible();

    await input.setInputFiles({ name: 'site-photo.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('site-photo.png was uploaded.')).toBeVisible();
    const list = page.getByTestId('report-attachments');
    await expect(list).toContainText('site-photo.png');

    const downloadEvent = page.waitForEvent('download');
    await list.getByRole('button', { name: 'Download site-photo.png' }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('site-photo.png');
    const saved = await download.path();
    expect(readFileSync(saved).equals(PNG)).toBe(true);

    await page.goto(state.reportPath);
    await settled(page);
    await page.getByLabel('Add a photo or document').setInputFiles({
      name: 'wrong-upload.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await expect(page.getByText('wrong-upload.pdf was uploaded.')).toBeVisible();
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete wrong-upload.pdf' }).click();
    await expect(page.getByTestId('report-attachments')).not.toContainText('wrong-upload.pdf');
    await expect(page.getByTestId('report-attachments')).toContainText('site-photo.png');
    await expectNoAxeViolations(page, 'daily report with attachments');
    await close();

    // Attachments follow the report's access rules: a colleague without access to the project's reports
    // cannot list or fetch them.
    const outsider = await contextFor(browser, 'hr');
    const reportId = state.reportPath.split('/').at(-1) ?? '';
    const listing = await outsider.page.request.get(
      `/api/v1/attachments?ownerType=DAILY_REPORT&ownerId=${encodeURIComponent(reportId)}`,
    );
    expect([403, 404]).toContain(listing.status());
    await outsider.page.goto(state.reportPath);
    await expect(outsider.page.getByRole('heading', { name: /Not found|You don't have access/ })).toBeVisible();
    await outsider.close();
  });

  test('10. the manager sees the submitted report and can download its attachment', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto(`${state.projectPath}#reports`);
    await settled(page);
    const report = page.getByTestId('report-list').getByRole('link').filter({ hasText: 'Fatma Field' });
    await expect(report).toContainText('Degraded');
    await report.click();
    await expect(page.getByText(WORK)).toBeVisible();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download site-photo.png' }).click();
    expect((await downloadEvent).suggestedFilename()).toBe('site-photo.png');
    // Managers read reports; they cannot attach files to someone else's report.
    await expect(page.getByLabel('Add a photo or document')).toHaveCount(0);
    await close();
  });

  test('11. missing daily reports are listed for the project managers', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto('/projects');
    await settled(page);
    await page.getByRole('table').getByRole('link', { name: 'Traffic Management Platform' }).click();
    await settled(page);
    await openTab(page, 'Daily reports');
    const missing = page.getByTestId('missing-reports');
    await expect(missing).toContainText(/\d+ reports? (is|are) missing/);
    await expect(missing).toContainText('Mariam Gamal');
    await expect(missing).toContainText('Mostafa Saad');
    // Submitted reports from the seed are still listed.
    await expect(page.getByTestId('report-list')).toContainText('Mariam Gamal');

    // The new project: today's report was submitted, so nothing is missing for it.
    await page.goto(`${state.projectPath}#reports`);
    await settled(page);
    await expect(page.getByTestId('missing-reports')).toContainText('No reports are missing.');
    await close();
  });

  test('12. the activity timeline records the project history', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager');
    await page.goto(`${state.projectPath}#activity`);
    await settled(page);
    const timeline = page.getByTestId('project-activity');
    await expect(timeline).toContainText(new RegExp(`Project PRJ-\\d+ · ${PROJECT} was created.`));
    await expect(timeline).toContainText('Fatma Field joined as Field.');
    await expect(timeline).toContainText('Status changed from Planning to Active.');
    await expect(timeline).toContainText('Health changed from Healthy to At risk.');
    await expect(timeline).toContainText(/Fatma Field submitted the daily report for \d{4}-\d{2}-\d{2} \(Degraded\)\./);
    await expectNoAxeViolations(page, 'project activity');
    await close();
  });

  test('13. mobile: cards, scrollable tabs and the report form work at 375 px', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field', {
      viewport: { width: 375, height: 812 },
      hasTouch: true,
    });
    await page.goto('/projects');
    await settled(page);
    await expect(page.getByRole('table')).toBeHidden();
    const cards = page.getByRole('list', { name: 'Projects' });
    await cards.getByRole('link', { name: new RegExp(PROJECT) }).click();
    await expect(page.getByRole('heading', { level: 1, name: PROJECT })).toBeVisible();
    await openTab(page, 'Daily reports');
    await expect(page.getByRole('button', { name: 'Submit report' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'project detail at 375 px');
    await expectNoAxeViolations(page, 'project reports tab at 375 px');
    await page.goto('/daily-reports');
    await settled(page);
    await expect(page.getByRole('link', { name: new RegExp(PROJECT) })).toBeVisible();
    await expectNoHorizontalOverflow(page, '/daily-reports at 375 px');
    await close();
  });

  test('14. RTL smoke: the projects screens render right-to-left in Arabic', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto('/projects');
      await expect(page.getByRole('heading', { level: 1, name: ar.projects.title })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.getByRole('link', { name: PROJECT })).toBeVisible();
      await expectNoHorizontalOverflow(page, '/projects (ar)');
      await expectNoAxeViolations(page, '/projects (ar)');

      await page.goto(state.projectPath);
      const tabs = page.getByRole('tablist', { name: ar.projects.sections });
      await expect(tabs.getByRole('tab', { name: ar.projects.tabs.overview })).toBeVisible();
      // Arrow keys follow the reading direction: ArrowLeft moves forward in RTL.
      await tabs.getByRole('tab', { name: ar.projects.tabs.overview }).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(tabs.getByRole('tab', { name: ar.projects.tabs.team })).toBeFocused();
      await expectNoHorizontalOverflow(page, 'project detail (ar)');
      await expectNoAxeViolations(page, 'project detail (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  test('the attachment upload widget is reused for profile photos', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'field');
    await page.goto('/profile');
    await settled(page);
    await page.getByLabel('Upload a new photo').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('Photo updated.')).toBeVisible();
    const photo = page.getByTestId('employee-avatar');
    await expect(photo).toBeVisible();
    // Loaded from object storage through the pre-signed URL (CSP img-src allows the storage origin).
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expectNoAxeViolations(page, 'profile with photo');

    await page.getByRole('button', { name: 'Remove photo' }).click();
    await expect(page.getByText('Photo removed.')).toBeVisible();
    await expect(page.getByTestId('employee-avatar')).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Photo of Fatma Field' })).toHaveText('FF');
    await close();
  });

  for (const width of WIDTHS) {
    test(`responsive layout and axe on the Phase 2 screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const manager = await contextFor(browser, 'manager', { viewport });
      for (const path of ['/projects', state.projectPath, '/customers', '/daily-reports', state.reportPath]) {
        await manager.page.goto(path);
        await settled(manager.page);
        await expectNoHorizontalOverflow(manager.page, `${path} at ${String(width)} px`);
        await expectNoAxeViolations(manager.page, `${path} at ${String(width)} px`);
      }
      for (const tab of ['Team', 'Daily reports', 'Activity', 'Settings']) {
        await manager.page.goto(state.projectPath);
        await settled(manager.page);
        await openTab(manager.page, tab);
        await expectNoHorizontalOverflow(manager.page, `${tab} tab at ${String(width)} px`);
        await expectNoAxeViolations(manager.page, `${tab} tab at ${String(width)} px`);
      }
      await manager.close();

      const admin = await contextFor(browser, 'org.admin', { viewport });
      await admin.page.goto('/admin/work-locations');
      await settled(admin.page);
      await expect(admin.page.getByText('Cairo HQ').filter({ visible: true }).first()).toBeVisible();
      await expectNoHorizontalOverflow(admin.page, `/admin/work-locations at ${String(width)} px`);
      await expectNoAxeViolations(admin.page, `/admin/work-locations at ${String(width)} px`);
      await admin.close();
    });
  }
});
