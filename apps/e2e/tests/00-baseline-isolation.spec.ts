import { contextFor } from '../support/auth.js';
import { grantSystemRoleForTest, restoreBaseline } from '../support/baseline.js';
import { expect, test } from '../support/test.js';

interface Me {
  readonly data: { readonly permissions: readonly { readonly key: string; readonly scopes: readonly string[] }[] };
}

const scopesOf = async (request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> }, key: string) => {
  const me = (await (await request.get('/api/v1/me')).json()) as Me;
  return me.data.permissions.find((permission) => permission.key === key)?.scopes ?? [];
};

/**
 * Regression for spec-order coupling: a grant made by one spec (03 grants `employee` the Support agent
 * role) used to leak into later specs. The per-file baseline restore must remove it, and live sessions
 * must pick the change up through `authz_version`.
 */
test('the seeded authorization baseline is restored, and live sessions follow it', async ({ browser }) => {
  const runDir = process.env.E2E_RUN_DIR ?? '';
  const employee = await contextFor(browser, 'employee');
  expect(await scopesOf(employee.page.request, 'project.view')).not.toContain('ORG');

  await grantSystemRoleForTest('demo', 'employee@demo.company-ops.test', 'SUPPORT_AGENT');
  await expect.poll(() => scopesOf(employee.page.request, 'project.view')).toContain('ORG');

  const drift = await restoreBaseline(runDir);
  expect(drift.memberRoles).toBe(1);
  await expect.poll(() => scopesOf(employee.page.request, 'project.view')).not.toContain('ORG');
  // Restoring an unchanged baseline is a no-op.
  expect(await restoreBaseline(runDir)).toEqual({
    organizations: 0,
    members: 0,
    memberRoles: 0,
    profiles: 0,
    teamMembers: 0,
  });
  await employee.close();
});
