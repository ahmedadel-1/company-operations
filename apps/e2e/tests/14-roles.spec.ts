import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import { E2E_WEB_URL } from '../support/ports.js';

const ROLE = 'Records clerk';
const WIDTHS = [375, 768, 1024, 1440] as const;
const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  roles: { title: string; new: string };
};

test.describe.serial('custom roles', () => {
  test('an organization admin creates a custom role, grants it, and it takes effect for the holder', async ({
    browser,
  }) => {
    const admin = await contextFor(browser, 'org.admin');
    const page = admin.page;
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Roles' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
    const adminRole = page.getByTestId('role-item').filter({ hasText: 'Organization admin' });
    await expect(adminRole).toContainText('The organization admin role cannot be changed.');
    await expect(adminRole.getByRole('button', { name: /^(Edit|Delete):/ })).toHaveCount(0);
    await expectNoAxeViolations(page, 'roles page');

    await page.getByRole('button', { name: 'New role' }).click();
    const dialog = page.getByRole('dialog', { name: 'New role' });
    await dialog.getByLabel('Role name').fill(ROLE);
    await dialog.getByLabel('department.manage').selectOption({ label: 'Organization' });
    await expectNoAxeViolations(page, 'new role dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const item = page.getByTestId('role-item').filter({ hasText: ROLE });
    await expect(item).toContainText('Custom role');
    await expect(item).toContainText('1 permission');

    // Editing keeps the grant and adds one; system roles keep their name.
    await item.getByRole('button', { name: `Edit: ${ROLE}` }).click();
    const edit = page.getByRole('dialog', { name: `Edit: ${ROLE}` });
    await expect(edit.getByLabel('department.manage')).toHaveValue('ORG');
    await edit.getByLabel('employee.view_contact').selectOption({ label: 'Department' });
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    await expect(item).toContainText('2 permissions');
    await page
      .getByTestId('role-item')
      .filter({ has: page.getByRole('heading', { name: 'Support agent', exact: true }) })
      .getByRole('button', { name: 'Edit: Support agent' })
      .click();
    const system = page.getByRole('dialog', { name: 'Edit: Support agent' });
    await expect(
      system.getByText('System roles keep their name; only their permissions can be changed.'),
    ).toBeVisible();
    await expect(system.getByLabel('Role name')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/people');
    await page.getByLabel('Search', { exact: true }).fill('Emad');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('link', { name: 'Emad Employee' }).click();
    await page.getByLabel('Role', { exact: true }).selectOption({ label: ROLE });
    await page.getByRole('button', { name: 'Grant role' }).click();
    await expect(page.getByText('Role granted.')).toBeVisible();
    await admin.close();

    const employee = await contextFor(browser, 'employee');
    const nav = employee.page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Job titles' })).toBeVisible();
    await nav.getByRole('link', { name: 'Job titles' }).click();
    await expect(employee.page.getByRole('heading', { level: 1, name: 'Job titles' })).toBeVisible();
    await employee.close();
  });

  test('a role in use cannot be deleted; after the grant is revoked it can, and the holder loses the access', async ({
    browser,
  }) => {
    const admin = await contextFor(browser, 'org.admin');
    const page = admin.page;
    await page.goto('/admin/roles');
    const item = page.getByTestId('role-item').filter({ hasText: ROLE });
    await item.getByRole('button', { name: `Delete: ${ROLE}` }).click();
    const confirm = page.getByRole('dialog', { name: `Delete role "${ROLE}"?` });
    await confirm.getByRole('button', { name: 'Delete role' }).click();
    await expect(confirm.getByRole('alert')).toContainText('This conflicts with the current state.');
    await page.keyboard.press('Escape');
    await expect(item).toBeVisible();

    await page.goto('/people');
    await page.getByLabel('Search', { exact: true }).fill('Emad');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('link', { name: 'Emad Employee' }).click();
    await page.getByRole('button', { name: `Revoke ${ROLE}` }).click();
    await expect(page.getByText('Role revoked.')).toBeVisible();

    await page.goto('/admin/roles');
    await page
      .getByTestId('role-item')
      .filter({ hasText: ROLE })
      .getByRole('button', { name: `Delete: ${ROLE}` })
      .click();
    await page
      .getByRole('dialog', { name: `Delete role "${ROLE}"?` })
      .getByRole('button', { name: 'Delete role' })
      .click();
    await expect(page.getByTestId('role-item').filter({ hasText: ROLE })).toHaveCount(0);
    await admin.close();

    const employee = await contextFor(browser, 'employee');
    await expect(
      employee.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Job titles' }),
    ).toHaveCount(0);
    await employee.close();
  });

  test('the API refuses changes to the organization admin role and role management by non-admins', async ({
    browser,
  }) => {
    const admin = await contextFor(browser, 'org.admin');
    const roles = await admin.page.request.get('/api/v1/roles');
    expect(roles.status()).toBe(200);
    const adminRole = ((await roles.json()) as { data: { id: string; key: string | null }[] }).data.find(
      (role) => role.key === 'ORG_ADMIN',
    );
    expect(adminRole).toBeDefined();
    const adminHeaders = {
      origin: E2E_WEB_URL,
      'x-csrf-token': await csrfToken(admin.page),
      'content-type': 'application/json',
    };
    const lockAdmin = await admin.page.request.patch(`/api/v1/roles/${adminRole?.id ?? ''}`, {
      headers: adminHeaders,
      data: { permissions: [{ key: 'employee.view', scope: 'SELF' }] },
    });
    expect(lockAdmin.status()).toBe(403);
    await admin.close();

    const employee = await contextFor(browser, 'employee');
    const headers = {
      origin: E2E_WEB_URL,
      'x-csrf-token': await csrfToken(employee.page),
      'content-type': 'application/json',
    };
    const create = await employee.page.request.post('/api/v1/roles', {
      headers,
      data: { name: 'Shadow admin', permissions: [{ key: 'role.manage', scope: 'ORG' }] },
    });
    expect(create.status()).toBe(403);
    expect(((await create.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    await employee.page.goto('/admin/roles');
    await expect(employee.page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
    await employee.close();
  });

  test('the roles screen and its dialog fit every width and work right to left', async ({ browser }) => {
    test.setTimeout(180_000);
    for (const width of WIDTHS) {
      const { page, close } = await contextFor(browser, 'org.admin', { viewport: { width, height: 900 } });
      try {
        await page.goto('/admin/roles');
        await expect(page.getByTestId('role-item').first()).toBeVisible();
        await expectNoHorizontalOverflow(page, `/admin/roles at ${String(width)} px`);
        await expectNoAxeViolations(page, `/admin/roles at ${String(width)} px`);
        await page.getByRole('button', { name: 'New role' }).click();
        await expect(page.getByRole('dialog', { name: 'New role' })).toBeVisible();
        await expectNoAxeViolations(page, `new role dialog at ${String(width)} px`);
      } finally {
        await close();
      }
    }

    const { page, close } = await contextFor(browser, 'org.admin');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto('/admin/roles');
      await expect(page.getByRole('heading', { level: 1, name: ar.roles.title })).toBeVisible();
      await expectNoHorizontalOverflow(page, '/admin/roles (ar)');
      await expectNoAxeViolations(page, '/admin/roles (ar)');
      await page.getByRole('button', { name: ar.roles.new }).click();
      await expect(page.getByRole('dialog', { name: ar.roles.new })).toBeVisible();
      await expectNoAxeViolations(page, 'new role dialog (ar)');
      await page.keyboard.press('Escape');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });
});
