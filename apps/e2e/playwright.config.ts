import { defineConfig, devices } from '@playwright/test';

import { E2E_WEB_URL } from './support/ports.js';

/**
 * Real-browser end-to-end tests against a disposable stack started by `support/global-setup.ts`:
 * PostgreSQL, Redis and Keycloak containers, plus the built API, worker and web app as processes.
 * Tests share one Keycloak instance and per-user TOTP enrolment, so they run serially.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
