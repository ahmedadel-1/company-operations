import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';

import { SESSION_COOKIE } from '@company-ops/shared';

import { E2E_WEB_URL } from './ports.js';

export type DemoUser =
  'org.admin' | 'gm' | 'hr' | 'employee' | 'disabled' | 'outsider' | 'field' | 'manager' | 'support' | 'pm';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; run the suite through playwright.config.ts (global setup).`);
  }
  return value;
}

export const keycloakUrl = (): string => requiredEnv('E2E_KEYCLOAK_URL');
const demoPassword = (): string => requiredEnv('E2E_DEMO_PASSWORD');
const runDir = (): string => requiredEnv('E2E_RUN_DIR');

interface TotpState {
  readonly secret: string;
  readonly lastStep: number;
}

/**
 * TOTP secrets created during enrolment and the last time step used per user. Persisted in the run
 * directory so a restarted Playwright worker can still sign in users who already enrolled.
 */
function readTotp(): Record<string, TotpState> {
  const file = join(runDir(), 'totp.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, TotpState>) : {};
}

function writeTotp(user: DemoUser, state: TotpState): void {
  writeFileSync(join(runDir(), 'totp.json'), JSON.stringify({ ...readTotp(), [user]: state }));
}

const TOTP_STEP_MS = 30_000;

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) as configured in the realm OTP policy. */
export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/** A code for a time step not used before by this user (Keycloak rejects reused OTP codes). */
async function freshCode(user: DemoUser, secret: string, lastStep: number): Promise<string> {
  let step = Math.floor(Date.now() / TOTP_STEP_MS);
  if (step <= lastStep) {
    await new Promise((resolve) => setTimeout(resolve, (lastStep + 1) * TOTP_STEP_MS - Date.now() + 250));
    step = Math.floor(Date.now() / TOTP_STEP_MS);
  }
  writeTotp(user, { secret, lastStep: step });
  return totp(secret, step);
}

/**
 * Completes whatever Keycloak pages appear (password, TOTP enrolment, OTP) until the browser is back
 * on the web app outside `/api/`. Returns the final URL.
 */
export async function completeKeycloakLogin(page: Page, user: DemoUser): Promise<URL> {
  const kc = keycloakUrl();
  for (let step = 0; step < 8; step += 1) {
    await page.waitForURL(
      (url) => url.href.startsWith(kc) || (url.href.startsWith(E2E_WEB_URL) && !url.pathname.startsWith('/api/')),
    );
    const current = new URL(page.url());
    if (!current.href.startsWith(kc)) {
      return current;
    }
    const before = page.url();
    const username = page.locator('#username');
    const enrolment = page.locator('input[name="totpSecret"]');
    const otp = page.locator('#otp');
    await expect(username.or(enrolment).or(otp).first()).toBeAttached();
    if (await username.isVisible()) {
      await username.fill(user);
      await page.locator('#password').fill(demoPassword());
      await page.locator('#kc-login').click();
    } else if ((await enrolment.count()) > 0) {
      const secret = await enrolment.inputValue();
      await page.locator('#totp').fill(await freshCode(user, secret, -1));
      await page.locator('#userLabel').fill('e2e');
      await page.locator('#saveTOTPBtn').click();
    } else {
      const state = readTotp()[user];
      if (state === undefined) {
        throw new Error(`Keycloak asks ${user} for an OTP but no TOTP secret was enrolled in this run.`);
      }
      await otp.fill(await freshCode(user, state.secret, state.lastStep));
      await page.locator('#kc-login').click();
    }
    await page.waitForURL((url) => url.href !== before);
  }
  throw new Error(`Sign-in for ${user} did not return to the app (last URL ${page.url()})`);
}

/** Signs in through the real browser flow starting at an app path; waits for the authenticated shell. */
export async function signIn(page: Page, user: DemoUser, path = '/'): Promise<void> {
  await page.goto(path);
  await completeKeycloakLogin(page, user);
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

const storageStates = new Map<DemoUser, Awaited<ReturnType<BrowserContext['storageState']>>>();

export interface UserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Saves the (possibly rotated) session cookie for the next test, then closes the context. */
  readonly close: () => Promise<void>;
}

/**
 * A browser context with a session for `user`, signing in once per user and worker and reusing the
 * cookies afterwards. The API rotates the session id when the member's grants change, so contexts
 * must be closed with `close()`. Tests that end the session (logout) use `signIn` in their own context.
 */
export async function contextFor(
  browser: Browser,
  user: DemoUser,
  options: BrowserContextOptions = {},
): Promise<UserSession> {
  const cached = storageStates.get(user);
  const context = await browser.newContext({
    baseURL: E2E_WEB_URL,
    locale: 'en-US',
    ...options,
    ...(cached === undefined ? {} : { storageState: cached }),
  });
  const page = await context.newPage();
  if (cached === undefined) {
    await signIn(page, user);
    storageStates.set(user, await context.storageState());
  } else {
    await page.goto('/');
    await expect(page.getByTestId('user-menu')).toBeVisible();
  }
  return {
    context,
    page,
    close: async () => {
      const state = await context.storageState();
      if (state.cookies.some((cookie) => cookie.name === SESSION_COOKIE)) {
        storageStates.set(user, state);
      } else {
        storageStates.delete(user);
      }
      await context.close();
    },
  };
}

/**
 * Satisfies the API's MFA requirement for privileged routes: when the session has no recent second
 * factor, goes through the step-up sign-in (OTP, enrolling on first use) and back to the app.
 */
export async function stepUp(page: Page, user: DemoUser): Promise<void> {
  const me = await page.request.get('/api/v1/me');
  expect(me.status()).toBe(200);
  if (((await me.json()) as { data: { mfa: { satisfied: boolean } } }).data.mfa.satisfied) {
    return;
  }
  await page.goto('/api/v1/auth/step-up?returnTo=%2F');
  await completeKeycloakLogin(page, user);
  await expect(page.getByTestId('user-menu')).toBeVisible();
}

/** Reads the CSRF token for direct API calls made with the context's session cookie. */
export async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/auth/csrf');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { csrfToken: string } }).data.csrfToken;
}
