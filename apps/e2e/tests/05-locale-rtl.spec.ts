import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';

import { LOCALE_COOKIE } from '@company-ops/shared';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor } from '../support/auth.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  nav: { mainNavigation: string; home: string };
};

test('switching to Arabic renders the shell right-to-left and persists the choice', async ({ browser }) => {
  const { context, page, close } = await contextFor(browser, 'hr');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', 'ltr');

  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitemradio', { name: 'العربية' }).click();
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  const sidebar = page.getByRole('navigation', { name: ar.nav.mainNavigation });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('link', { name: ar.nav.home })).toBeVisible();

  // Logical layout: the sidebar sits on the right edge in RTL.
  const box = await sidebar.boundingBox();
  const viewport = page.viewportSize();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(viewport?.width);
  await expectNoHorizontalOverflow(page, 'home (ar)');
  await expectNoAxeViolations(page, 'home (ar)');

  // Saved on the member profile, so it survives a reload and a new browser context.
  await page.reload();
  await expect(html).toHaveAttribute('dir', 'rtl');
  const fresh = await browser.newContext({ baseURL: E2E_WEB_URL, storageState: await context.storageState() });
  await fresh.clearCookies({ name: LOCALE_COOKIE });
  const freshPage = await fresh.newPage();
  await freshPage.goto('/');
  await expect(freshPage.locator('html')).toHaveAttribute('dir', 'rtl');
  await fresh.close();

  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitemradio', { name: 'English' }).click();
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(html).toHaveAttribute('lang', 'en');
  await close();
});
