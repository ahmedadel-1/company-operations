import { defineConfig, devices } from '@playwright/test';

/**
 * Production-stack rehearsal journey (scripts/release/rehearse.ts journey): runs against an already
 * running rehearsal stack, never a real deployment. Host names resolve to the local proxy and the
 * rehearsal's self-signed certificate is accepted.
 */
const url = process.env.REHEARSAL_URL ?? 'https://ops.rehearsal.test:8443';

export default defineConfig({
  testDir: './rehearsal',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: url,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    locale: 'en-US',
    launchOptions: {
      args: ['--host-resolver-rules=MAP ops.rehearsal.test 127.0.0.1, MAP files.rehearsal.test 127.0.0.1'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
