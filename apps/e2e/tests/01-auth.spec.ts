import { expect, test } from '../support/test.js';

import { SESSION_COOKIE } from '@company-ops/shared';

import { completeKeycloakLogin, contextFor, keycloakUrl, signIn } from '../support/auth.js';
import { E2E_WEB_URL } from '../support/ports.js';

test.describe('authentication', () => {
  test('Keycloak login returns to the requested page in the authenticated shell', async ({ page, context }) => {
    await page.goto('/people');
    await expect(page).toHaveURL((url) => url.href.startsWith(keycloakUrl()));
    await expect(page.locator('#username')).toBeVisible();

    const landed = await completeKeycloakLogin(page, 'gm');
    expect(landed.pathname).toBe('/people');
    await expect(page.getByRole('heading', { level: 1, name: 'Employees' })).toBeVisible();
    await expect(page.getByTestId('active-organization')).toHaveText('Demo Company');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    const cookies = await context.cookies(E2E_WEB_URL);
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    // No tokens or session identifiers are readable by page scripts.
    const exposed = await page.evaluate(() => ({
      cookie: document.cookie,
      storage: [window.localStorage, window.sessionStorage]
        .flatMap((store) => Array.from({ length: store.length }, (_, index) => store.getItem(store.key(index) ?? '')))
        .join('\n'),
    }));
    expect(exposed.cookie).not.toContain(SESSION_COOKIE);
    expect(`${exposed.cookie}${exposed.storage}`).not.toMatch(/eyJ[\w-]+\.eyJ/);
  });

  test('/me reflects the signed-in user, memberships and MFA state', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    const response = await page.request.get('/api/v1/me');
    expect(response.status()).toBe(200);
    const me = (await response.json()) as {
      data: {
        user: { displayName: string };
        activeOrganization: { name: string };
        memberships: { name: string }[];
        mfa: { satisfied: boolean };
      };
    };
    expect(me.data.user.displayName).toBe('George Manager');
    expect(me.data.activeOrganization.name).toBe('Demo Company');
    expect(me.data.memberships.map((membership) => membership.name).sort()).toEqual([
      'Demo Company',
      'Northwind Trading',
    ]);
    expect(me.data.mfa.satisfied).toBe(false);
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menu')).toContainText('George Manager');
    await close();
  });

  test('sign out ends the app session and the Keycloak session', async ({ page, context }) => {
    await signIn(page, 'employee');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    // Keycloak end-session → post-logout redirect to the app → no session → back to the Keycloak login form.
    await expect(page).toHaveURL((url) => url.href.startsWith(keycloakUrl()));
    await expect(page.locator('#username')).toBeVisible();

    const cookies = await context.cookies(E2E_WEB_URL);
    expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE)).toBe(false);
    const me = await page.request.get(`${E2E_WEB_URL}/api/v1/me`);
    expect(me.status()).toBe(401);
  });
});

test.describe('unauthenticated and unauthorized access', () => {
  test('API calls without a session are rejected with 401', async ({ request }) => {
    const response = await request.get('/api/v1/me');
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.requestId).not.toBe('');
  });

  test('a Keycloak user without an active membership gets an explanation and no session', async ({ page, context }) => {
    await page.goto('/');
    const landed = await completeKeycloakLogin(page, 'outsider');
    expect(landed.pathname).toBe('/sign-in');
    expect(landed.searchParams.get('authError')).toBe('no_active_membership');
    await expect(page.locator('main [role="alert"]')).toContainText('does not have access to any active organization');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    const cookies = await context.cookies(E2E_WEB_URL);
    expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE)).toBe(false);
  });

  test('a disabled member cannot sign in', async ({ page }) => {
    await page.goto('/');
    const landed = await completeKeycloakLogin(page, 'disabled');
    expect(landed.pathname).toBe('/sign-in');
    expect(landed.searchParams.get('authError')).toBe('no_active_membership');
  });

  test('an ended session shows the session-expired screen instead of failing silently', async ({ browser }) => {
    const { context, page, close } = await contextFor(browser, 'employee');
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
    await context.clearCookies();
    await page.getByLabel('Phone').fill('+20 100 000 9999');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Your session has ended' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/api/v1/auth/login?returnTo=%2Fprofile',
    );
    await close();
  });
});
