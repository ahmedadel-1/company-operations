import { AxeBuilder } from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** WCAG 2.2 AA (UI_UX.md §7): fails with the rule ids and offending selectors. */
export async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
  );
  expect(violations, `axe violations on ${label}`).toEqual([]);
}

/** No page-level horizontal scrolling (UI_UX.md §2); wide tables scroll inside their own wrapper. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${label}`).toBeLessThanOrEqual(0);
}
