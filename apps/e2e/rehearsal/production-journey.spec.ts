import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { totp } from '../support/auth.js';

/**
 * Production-stack rehearsal journey (scripts/release/rehearse.ts journey). Runs against the rehearsal
 * stack's real images, proxy, production Keycloak realm and production validation: the first ORG_ADMIN
 * redeems the bootstrap invitation, enrolls a second factor through step-up, and the authenticated shell,
 * dashboard and live-update stream work through the proxy.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; run through scripts/release/rehearse.ts journey`);
  }
  return value;
}

const baseUrl = required('REHEARSAL_URL');
const keycloak = `${baseUrl}/auth/`;
const username = required('REHEARSAL_USER');
const password = readFileSync(required('REHEARSAL_PASSWORD_FILE'), 'utf8').trim();
const invitation = readFileSync(required('REHEARSAL_INVITATION_FILE'), 'utf8').trim();
const totpFile = required('REHEARSAL_TOTP_FILE');
let totpSecret: string | null = existsSync(totpFile) ? readFileSync(totpFile, 'utf8').trim() : null;
let lastStep = -1;

/** Same-origin API call from the page (the browser resolves the rehearsal host names, Node does not). */
async function api(page: Page, path: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    return { status: response.status, body: (await response.json()) as unknown };
  }, path);
}

interface MeBody {
  readonly data: {
    readonly activeOrganization: { readonly slug: string };
    readonly permissions: readonly { readonly key: string }[];
    readonly mfa: { readonly satisfied: boolean };
  };
}

async function code(): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((resolve) => setTimeout(resolve, (lastStep + 1) * 30_000 - Date.now() + 250));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  if (totpSecret === null) {
    throw new Error('no TOTP secret enrolled');
  }
  return totp(totpSecret, step);
}

async function completeKeycloak(page: Page): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await page.waitForURL((url) => url.href.startsWith(keycloak) || !url.pathname.startsWith('/api/'));
    if (!page.url().startsWith(keycloak)) {
      return;
    }
    const before = page.url();
    const user = page.locator('#username');
    const enrolment = page.locator('input[name="totpSecret"]');
    const otp = page.locator('#otp');
    await expect(user.or(enrolment).or(otp).first()).toBeAttached();
    if (await user.isVisible()) {
      await user.fill(username);
      await page.locator('#password').fill(password);
      await page.locator('#kc-login').click();
    } else if ((await enrolment.count()) > 0) {
      totpSecret = await enrolment.inputValue();
      writeFileSync(totpFile, totpSecret, { mode: 0o600 });
      await page.locator('#totp').fill(await code());
      await page.locator('#userLabel').fill('rehearsal');
      await page.locator('#saveTOTPBtn').click();
    } else {
      await otp.fill(await code());
      await page.locator('#kc-login').click();
    }
    await page.waitForURL((url) => url.href !== before);
  }
  throw new Error(`sign-in did not return to the app (last URL ${page.url()})`);
}

test('first administrator signs in through the production stack, steps up and receives live updates', async ({
  page,
  context,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto(invitation);
  await completeKeycloak(page);
  await expect(page.getByTestId('user-menu')).toBeVisible();

  const me = await api(page, '/api/v1/me');
  expect(me.status).toBe(200);
  const meBody = me.body as MeBody;
  expect(meBody.data.activeOrganization.slug).toBe('rehearsal');
  expect(meBody.data.permissions.map((permission) => permission.key)).toContain('role.manage');

  await page.goto('/api/v1/auth/step-up?returnTo=%2F');
  await completeKeycloak(page);
  await expect(page.getByTestId('user-menu')).toBeVisible();
  const afterStepUp = await api(page, '/api/v1/me');
  expect((afterStepUp.body as MeBody).data.mfa.satisfied).toBe(true);

  const stream = page.waitForResponse((response) => response.url().endsWith('/api/v1/notifications/events/stream'));
  await page.goto('/');
  expect((await stream).status()).toBe(200);
  await expect(page.locator('main')).toBeVisible();

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-ops_sid');
  expect(session?.secure).toBe(true);
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  writeFileSync(required('REHEARSAL_SESSION_FILE'), session?.value ?? '', { mode: 0o600 });
  expect(violations).toEqual([]);
});
