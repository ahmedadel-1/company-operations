import { expect, test } from '../support/test.js';

import { completeKeycloakLogin, contextFor } from '../support/auth.js';

test('a privileged action without a recent second factor asks for step-up and succeeds afterwards', async ({
  browser,
}) => {
  const { page, close } = await contextFor(browser, 'hr');
  const me = (await (await page.request.get('/api/v1/me')).json()) as { data: { mfa: { satisfied: boolean } } };
  expect(me.data.mfa.satisfied).toBe(false);

  const createEmployee = async (): Promise<void> => {
    await page.goto('/people');
    await page.getByRole('button', { name: 'New employee' }).click();
    const dialog = page.getByRole('dialog', { name: 'New employee' });
    await dialog.getByLabel('Name', { exact: true }).fill('Step Up Tester');
    await dialog.getByRole('button', { name: 'Create' }).click();
  };

  await createEmployee();
  const mfaDialog = page.getByRole('dialog', { name: "Verify it's you to continue" });
  await expect(mfaDialog).toBeVisible();
  await mfaDialog.getByRole('link', { name: 'Verify now' }).click();
  const returned = await completeKeycloakLogin(page, 'hr');
  expect(returned.pathname).toBe('/people');

  const after = (await (await page.request.get('/api/v1/me')).json()) as { data: { mfa: { satisfied: boolean } } };
  expect(after.data.mfa.satisfied).toBe(true);

  await createEmployee();
  const created = page.getByRole('dialog', { name: 'New employee' });
  await expect(created.getByText('Employee created.')).toBeVisible();
  await expect(created.getByText('Invitation link')).toBeVisible();
  await close();
});
