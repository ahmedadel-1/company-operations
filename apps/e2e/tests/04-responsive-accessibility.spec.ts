import { expect, test } from '../support/test.js';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor } from '../support/auth.js';

const WIDTHS = [375, 768, 1024, 1440] as const;
const RESPONSIVE_PAGES = ['/', '/people', '/departments', '/admin/audit'] as const;

test.describe('responsive layout (UI_UX.md §2)', () => {
  for (const width of WIDTHS) {
    test(`navigation form, overflow and axe at ${String(width)} px`, async ({ browser }) => {
      const { page, close } = await contextFor(browser, 'org.admin', { viewport: { width, height: 900 } });
      const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
      const bottomNav = page.getByRole('navigation', { name: 'Mobile navigation' });
      if (width < 768) {
        await expect(bottomNav).toBeVisible();
        await expect(sidebar).toBeHidden();
      } else {
        await expect(sidebar).toBeVisible();
        await expect(bottomNav).toBeHidden();
        const box = await sidebar.boundingBox();
        // Icon rail on tablets, full sidebar with visible labels on desktop.
        expect(box?.width ?? 0).toBe(width < 1024 ? 64 : 240);
      }
      for (const path of RESPONSIVE_PAGES) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalOverflow(page, `${path} at ${String(width)} px`);
        await expectNoAxeViolations(page, `${path} at ${String(width)} px`);
      }
      await close();
    });
  }

  test('mobile viewport: bottom navigation, More sheet and card lists', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'org.admin', {
      viewport: { width: 375, height: 812 },
      hasTouch: true,
    });
    const bottomNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    // Members who record attendance get Attendance in the second slot; Employees moves to the More sheet.
    await expect(bottomNav.getByRole('link', { name: 'Attendance', exact: true })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Employees' })).toHaveCount(0);
    await bottomNav.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    await expectNoAxeViolations(page, 'More sheet at 375 px');
    await sheet.getByRole('link', { name: 'Employees', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Employees' })).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.getByRole('link', { name: /Olivia Admin/ })).toBeVisible();

    await bottomNav.getByRole('button', { name: 'More' }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'Departments' }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL((url) => url.pathname === '/departments');
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();

    // Touch targets of the primary navigation are at least 44 px high (UI_UX.md §7).
    for (const link of await bottomNav.getByRole('link').all()) {
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await close();
  });
});

test.describe('accessibility of every Phase 1 screen (axe, WCAG 2.2 AA)', () => {
  test('signed-in screens and dialogs', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'org.admin');
    const pages = [
      '/',
      '/profile',
      '/people',
      '/departments',
      '/teams',
      '/notifications',
      '/admin/organization',
      '/admin/roles',
      '/admin/job-titles',
      '/admin/audit',
      '/admin/jobs',
    ];
    for (const path of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoAxeViolations(page, path);
    }

    await page.goto('/people');
    await page.getByRole('link', { name: 'Emad Employee' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Emad Employee' })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectNoAxeViolations(page, 'employee detail');

    await page.goto('/teams');
    await page.getByRole('link').filter({ hasText: 'Platform Core' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Platform Core' })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectNoAxeViolations(page, 'team detail');

    await page.goto('/people');
    await page.getByRole('button', { name: 'New employee' }).click();
    await expect(page.getByRole('dialog', { name: 'New employee' })).toBeVisible();
    await expectNoAxeViolations(page, 'new employee dialog');
    await page.keyboard.press('Escape');

    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expectNoAxeViolations(page, 'account menu');
    await close();
  });

  test('public sign-in page', async ({ page }) => {
    await page.goto('/sign-in?authError=no_active_membership');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expectNoAxeViolations(page, '/sign-in');
  });
});
