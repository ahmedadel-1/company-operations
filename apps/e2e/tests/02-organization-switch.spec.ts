import { expect, test } from '../support/test.js';

import { signIn } from '../support/auth.js';

test('a member of two organizations switches the active organization', async ({ page }) => {
  // Own sign-in: switching changes server-side session state that other tests must not inherit.
  await signIn(page, 'gm', '/people');
  const activeOrganization = page.getByTestId('active-organization');
  await expect(activeOrganization).toHaveText('Demo Company');
  const demoEmployeeHref = await page.getByRole('link', { name: 'Olivia Admin' }).getAttribute('href');
  const demoEmployeeId = demoEmployeeHref?.split('/').pop() ?? '';
  expect(demoEmployeeId).not.toBe('');

  await page.getByTestId('user-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Organizations')).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Demo Company' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Northwind Trading' }).click();

  await expect(activeOrganization).toHaveText('Northwind Trading');
  await expect(page).toHaveURL((url) => url.pathname === '/');
  const me = (await (await page.request.get('/api/v1/me')).json()) as {
    data: { activeOrganization: { name: string } };
  };
  expect(me.data.activeOrganization.name).toBe('Northwind Trading');

  // Tenant data follows the session: Northwind's directory, none of the demo company's people.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Employees' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Employees' })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Olivia Admin' })).toHaveCount(0);

  // A record of the other organization is invisible, not forbidden, from the new active organization.
  const crossTenant = await page.request.get(`/api/v1/employees/${demoEmployeeId}`);
  expect(crossTenant.status()).toBe(404);
  expect(((await crossTenant.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

  await page.reload();
  await expect(activeOrganization).toHaveText('Northwind Trading');

  await page.getByTestId('user-menu').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Demo Company' }).click();
  await expect(activeOrganization).toHaveText('Demo Company');
});
