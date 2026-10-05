import { test as base } from '@playwright/test';

import { restoreBaseline } from './baseline.js';

export { expect } from '@playwright/test';

function runDir(): string {
  const value = process.env.E2E_RUN_DIR;
  if (value === undefined || value === '') {
    throw new Error('E2E_RUN_DIR is not set; run the suite through playwright.config.ts (global setup).');
  }
  return value;
}

/** Spec file whose baseline was last restored in this Playwright worker. */
let restoredFor: string | undefined;

/**
 * The only `test` specs may use (lint-enforced). Before the first test of every spec file it restores
 * the seeded authorization baseline (`baseline.ts`), so a spec never sees grants, statuses or settings
 * changed by an earlier spec. Tests inside one file may still build on each other (`describe.serial`).
 */
export const test = base.extend<{ seededBaseline: undefined }>({
  seededBaseline: [
    async ({}, use, testInfo) => {
      if (restoredFor !== testInfo.file) {
        await restoreBaseline(runDir());
        restoredFor = testInfo.file;
      }
      await use(undefined);
    },
    { auto: true },
  ],
});
