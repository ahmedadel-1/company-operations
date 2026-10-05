import { expect, test } from '../support/test.js';

import { contextFor, csrfToken } from '../support/auth.js';
import { E2E_WEB_URL } from '../support/ports.js';

test.describe('privileged actions', () => {
  test('an organization admin (MFA) changes settings, creates a department and grants a role; the change is audited and notified', async ({
    browser,
  }) => {
    const admin = await contextFor(browser, 'org.admin');
    const page = admin.page;
    const nav = page.getByRole('navigation', { name: 'Main navigation' });

    await nav.getByRole('link', { name: 'Organization' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Organization settings' })).toBeVisible();
    const saturday = page.getByRole('checkbox', { name: 'Saturday' });
    const wasChecked = await saturday.isChecked();
    await saturday.setChecked(!wasChecked);
    await page.locator('form').filter({ has: saturday }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Organization settings saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Saturday' })).toBeChecked({ checked: !wasChecked });

    await nav.getByRole('link', { name: 'Departments' }).click();
    await page.getByRole('button', { name: 'New department' }).click();
    const dialog = page.getByRole('dialog', { name: 'New department' });
    await dialog.getByLabel('Name').fill('Quality Assurance');
    await dialog.getByLabel('Code').fill('QA');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('list', { name: 'Departments' })).toContainText('Quality Assurance (QA)');

    await nav.getByRole('link', { name: 'Employees' }).click();
    await page.getByLabel('Search', { exact: true }).fill('Emad');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('link', { name: 'Emad Employee' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Emad Employee' })).toBeVisible();
    await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Support agent' });
    await page.getByRole('button', { name: 'Grant role' }).click();
    await expect(page.getByText('Role granted.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Roles' })).toContainText('Support agent');

    await nav.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    await page.getByLabel('Action').fill('role.granted');
    await page.getByRole('button', { name: 'Apply' }).click();
    const grantRow = page
      .getByRole('table')
      .getByRole('row')
      .filter({ hasText: 'role.granted' })
      .filter({ hasText: 'Olivia Admin' });
    await expect(grantRow.first()).toBeVisible();
    await grantRow.first().getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('dialog', { name: 'Audit event' })).toBeVisible();
    await page.keyboard.press('Escape');
    await admin.close();

    // The grant reaches the employee through the outbox, the worker and the notification inbox.
    const employee = await contextFor(browser, 'employee');
    await expect(async () => {
      await employee.page.reload();
      await expect(employee.page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 45_000 });
    await employee.page.goto('/notifications');
    await expect(employee.page.getByText('You were granted the role Support agent.')).toBeVisible();
    await employee.close();
  });
});

test.describe('lower-privilege user', () => {
  test('an employee sees no admin navigation, gets an access-denied page and is refused by the API', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'employee');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
    for (const adminLink of ['Organization', 'Roles', 'Job titles', 'Audit log', 'System jobs']) {
      await expect(nav.getByRole('link', { name: adminLink })).toHaveCount(0);
    }

    await page.goto('/admin/organization');
    await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: "You don't have access" })).toBeVisible();

    // The server enforces the same rules when the UI is bypassed.
    const headers = { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' };
    const settings = await page.request.patch('/api/v1/organization', { headers, data: { name: 'Taken over' } });
    expect(settings.status()).toBe(403);
    expect(((await settings.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    const department = await page.request.post('/api/v1/departments', { headers, data: { name: 'Rogue', code: 'RG' } });
    expect(department.status()).toBe(403);
    const audit = await page.request.get('/api/v1/audit/events');
    expect(audit.status()).toBe(403);
    await close();
  });
});
