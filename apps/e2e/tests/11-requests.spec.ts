import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Browser, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken, stepUp } from '../support/auth.js';
import type { DemoUser } from '../support/auth.js';
import { grantSystemRoleForTest, revokeSystemRoleForTest } from '../support/baseline.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  requests: { title: string; create: { title: string }; detail: { route: string } };
  approvals: { title: string };
};

/** A valid 1×1 PNG: attachments are checked by content, not by the file extension. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const GM_EMAIL = 'george.manager@demo.company-ops.test';

/**
 * Phase 6 requests and approvals. Requesters are Hana Resources (`hr`) and Olivia Admin (`org.admin`),
 * whose direct manager is George Manager (`gm`); Mina Manager (`manager`) acts as a specific-person
 * approver and as a delegate. Every test creates its own requests and request types (unique per run).
 * Setup goes through the public API as the acting user; the behaviour under test goes through the UI.
 */
interface RequestRef {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly version: number;
}

interface TypeRef {
  readonly id: string;
  readonly key: string;
  readonly name: { readonly en: string };
}

async function writeHeaders(page: Page): Promise<Record<string, string>> {
  return { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' };
}

async function send<T>(page: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    headers: await writeHeaders(page),
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
  return ((await response.json()) as { data: T }).data;
}

async function getData<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `GET ${path}`).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

async function asUser<T>(browser: Browser, user: DemoUser, run: (page: Page) => Promise<T>): Promise<T> {
  const session = await contextFor(browser, user);
  try {
    return await run(session.page);
  } finally {
    await session.close();
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function seededTypeId(page: Page, key: string): Promise<string> {
  const catalog = await getData<{ id: string; key: string }[]>(page, '/api/v1/request-types');
  const id = catalog.find((type) => type.key === key)?.id;
  expect(id, `request type ${key}`).toBeDefined();
  return id ?? '';
}

async function memberIdOf(page: Page, name: string): Promise<string> {
  const people = await getData<{ fullName: string; memberId: string }[]>(
    page,
    `/api/v1/employees?q=${encodeURIComponent(name)}`,
  );
  const id = people.find((person) => person.fullName === name)?.memberId;
  expect(id, `member ${name}`).toBeDefined();
  return id ?? '';
}

async function roleIdOf(page: Page, key: string): Promise<string> {
  const roles = await getData<{ id: string; key: string }[]>(page, '/api/v1/roles');
  const id = roles.find((role) => role.key === key)?.id;
  expect(id, `role ${key}`).toBeDefined();
  return id ?? '';
}

const REASON_FIELD = {
  key: 'reason',
  type: 'textarea',
  label: { en: 'Reason', ar: 'السبب' },
  required: true,
  maxLength: 500,
};
const MANAGER_STEP = {
  kind: 'APPROVAL',
  name: { en: 'Manager approval' },
  mode: 'ANY_ONE',
  approver: { type: 'DIRECT_MANAGER' },
};
const SETTINGS = {
  attachments: { requirement: 'NONE', maxFiles: 0 },
  effects: {},
  notifications: { emailApprovers: true, emailRequester: true },
};

/** Creates, publishes and activates a request type as the organization administrator (API). */
async function publishType(page: Page, label: string, content: { form: unknown; steps: unknown[] }): Promise<TypeRef> {
  await stepUp(page, 'org.admin');
  const key = `e2e_${label}_${RUN}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const created = await send<TypeRef & { draftVersion: { id: string; revision: number } }>(
    page,
    'POST',
    '/api/v1/request-admin/types',
    {
      key,
      name: { en: `E2E ${label} ${RUN}` },
      category: 'OTHER',
      icon: 'file-text',
    },
  );
  const draft = created.draftVersion;
  const saved = await send<{ revision: number }>(
    page,
    'PUT',
    `/api/v1/request-admin/types/${created.id}/versions/${draft.id}`,
    {
      ...SETTINGS,
      ...content,
      revision: draft.revision,
    },
  );
  await send(page, 'POST', `/api/v1/request-admin/types/${created.id}/versions/${draft.id}/publish`, {
    revision: saved.revision,
  });
  const current = await getData<{ version: number }>(page, `/api/v1/request-admin/types/${created.id}`);
  await send(page, 'PATCH', `/api/v1/request-admin/types/${created.id}`, { version: current.version, active: true });
  return created;
}

async function submitRequest(
  page: Page,
  requestTypeId: string,
  formData: Record<string, unknown>,
): Promise<RequestRef> {
  const response = await page.request.post('/api/v1/requests', {
    headers: { ...(await writeHeaders(page)), 'Idempotency-Key': randomUUID() },
    data: { requestTypeId, formData, submit: true },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: RequestRef }).data;
}

async function pendingApprovalId(page: Page, requestId: string): Promise<string> {
  const inbox = await getData<{ approvalId: string; request: { id: string } }[]>(page, '/api/v1/approvals?limit=100');
  const id = inbox.find((item) => item.request.id === requestId)?.approvalId;
  expect(id, `pending approval for ${requestId}`).toBeDefined();
  return id ?? '';
}

async function approveViaApi(page: Page, requestId: string): Promise<void> {
  await send(page, 'POST', `/api/v1/approvals/${await pendingApprovalId(page, requestId)}/approve`, {});
}

async function openRequest(page: Page, request: RequestRef): Promise<void> {
  await page.goto(`/requests/${request.id}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${request.key} · `) })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

function wfhData(reason: string, day = 10): Record<string, unknown> {
  const start = `2027-03-${String(day).padStart(2, '0')}`;
  return { dates: { start, end: start }, reason };
}

function inboxItem(page: Page, key: string) {
  return page.getByTestId('approval-item').filter({ hasText: key });
}

async function decideInInbox(page: Page, key: string, decision: 'Approve' | 'Reject', comment: string): Promise<void> {
  await page.goto('/approvals');
  await settled(page);
  await inboxItem(page, key)
    .getByRole('button', { name: new RegExp(`^${decision}`) })
    .click();
  const dialog = page.getByRole('dialog', { name: `${decision} · ${key}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill(comment);
  await dialog.getByRole('button', { name: decision, exact: true }).click();
  await expect(dialog).toBeHidden();
}

// ---- Mailpit (the local SMTP sink of the e2e stack) ----

interface MailSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

function mailpitUrl(): string {
  const value = process.env.E2E_MAILPIT_URL;
  if (value === undefined || value === '') {
    throw new Error('E2E_MAILPIT_URL is not set; run the suite through playwright.config.ts (global setup).');
  }
  return value;
}

async function mailsFor(page: Page, address: string, requestKey: string): Promise<MailSummary[]> {
  const response = await page.request.get(`${mailpitUrl()}/api/v1/messages?limit=500`);
  expect(response.status()).toBe(200);
  const { messages } = (await response.json()) as { messages: MailSummary[] };
  return messages.filter(
    (message) =>
      message.Subject.startsWith(`[${requestKey}]`) && message.To.some((to) => to.Address.toLowerCase() === address),
  );
}

async function mailText(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`${mailpitUrl()}/api/v1/message/${id}`);
  expect(response.status()).toBe(200);
  const message = (await response.json()) as { Text: string; HTML: string; Subject: string };
  return `${message.Subject}\n${message.Text}\n${message.HTML}`;
}

test.describe('Phase 6 requests and approvals', () => {
  test('1–4. an employee starts a new request, the form adapts, submits it and finds it in My requests', async ({
    browser,
  }) => {
    const reason = `Family visit ${RUN}`;
    const { page, close } = await contextFor(browser, 'hr');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Requests', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Requests' })).toBeVisible();
    await page.getByRole('link', { name: 'New request' }).first().click();

    // 1. The catalog lists the seeded request types.
    await expect(page.getByRole('heading', { level: 1, name: 'New request' })).toBeVisible();
    const options = page.getByTestId('request-type-option');
    for (const key of ['leave', 'work_from_home', 'laptop', 'software_access', 'purchase', 'business_mission']) {
      await expect(options.and(page.locator(`[data-key="${key}"]`))).toHaveCount(1);
    }
    await options.and(page.locator('[data-key="leave"]')).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Leave' })).toBeVisible();

    // 2. Dynamic form: the medical-certificate notice only shows for sick leave; required fields are enforced.
    const notice = page.getByText('Attach a medical certificate');
    await expect(notice).toHaveCount(0);
    await page.getByLabel('Leave type').selectOption({ label: 'Sick' });
    await expect(notice).toBeVisible();
    await page.getByLabel('Leave type').selectOption({ label: 'Annual' });
    await expect(notice).toHaveCount(0);
    await page.getByLabel('Leave type').selectOption({ label: 'Choose…' });
    await page.getByTestId('submit-request').click();
    await expect(page.getByText('This field is required.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/requests\/new\?type=/);

    // 3. Submit.
    await page.getByLabel('Leave type').selectOption({ label: 'Annual' });
    await page.getByLabel('From').fill('2027-02-15');
    await page.getByLabel('To').fill('2027-02-17');
    await page.getByLabel(/^Reason/).fill(reason);
    await page.getByTestId('submit-request').click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: /^REQ-\d+ · Leave$/ })).toBeVisible();
    await expect(page.getByTestId('request-status')).toHaveText('Pending approval');
    await expect(page.getByTestId('request-form-data')).toContainText(reason);
    const steps = page.getByTestId('request-step');
    await expect(steps.first()).toHaveAttribute('data-state', 'ACTIVE');
    await expect(steps.first().getByTestId('request-approval')).toContainText('George Manager · Pending');
    await expect(page.getByTestId('request-history')).toContainText('Hana Resources submitted the request.');
    const key = (await page.getByRole('heading', { level: 1 }).textContent())?.split(' · ')[0] ?? '';
    expect(key).toMatch(/^REQ-\d+$/);
    await expectNoAxeViolations(page, 'submitted request detail');

    // 4. My requests.
    await page.goto('/requests');
    await settled(page);
    await page.getByLabel('Search', { exact: true }).fill(key);
    await page.getByRole('button', { name: 'Apply' }).click();
    const row = page.getByTestId('request-row').filter({ hasText: key });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('request-status')).toHaveText('Pending approval');
    await close();
  });

  test('5–7. the manager finds it in My approvals, approves it, and the requester sees it approved', async ({
    browser,
  }) => {
    const request = await asUser(browser, 'hr', async (page) =>
      submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`Plumber visit ${RUN}`, 3)),
    );
    const gm = await contextFor(browser, 'gm');
    // 5. Manager inbox.
    await gm.page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Approvals', exact: true })
      .click();
    await settled(gm.page);
    const item = inboxItem(gm.page, request.key);
    await expect(item).toContainText('From Hana Resources');
    await expect(item).toContainText('Step: Manager approval');
    await expectNoAxeViolations(gm.page, 'approvals inbox');
    // 6. Approve.
    await decideInInbox(gm.page, request.key, 'Approve', 'Enjoy working from home.');
    await expect(gm.page.getByText('Request approved.')).toBeVisible();
    await expect(inboxItem(gm.page, request.key)).toHaveCount(0);
    await gm.close();

    // 7. Approved status, comment and history for the requester.
    const hr = await contextFor(browser, 'hr');
    await openRequest(hr.page, request);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Approved');
    await expect(hr.page.getByTestId('approval-comment')).toHaveText('Enjoy working from home.');
    await expect(hr.page.getByTestId('request-history')).toContainText('George Manager approved.');
    await expect(hr.page.getByTestId('request-history')).toContainText('recorded the approved request for attendance.');
    // Hana may still cancel as an HR administrator once stepped up, but nobody can decide any more.
    await expect(hr.page.getByTestId('approve-request')).toHaveCount(0);
    await expect(hr.page.getByTestId('reject-request')).toHaveCount(0);
    await hr.close();
  });

  test('8–9. the manager rejects with a mandatory reason that the requester can read', async ({ browser }) => {
    const request = await asUser(browser, 'hr', async (page) =>
      submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`Rejected visit ${RUN}`, 4)),
    );
    const gm = await contextFor(browser, 'gm');
    await openRequest(gm.page, request);
    await gm.page.getByTestId('reject-request').click();
    const dialog = gm.page.getByRole('dialog', { name: `Reject · ${request.key}` });
    const confirm = dialog.getByRole('button', { name: 'Reject', exact: true });
    // 8. A reason is required.
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/^Reason for rejection/).fill('The team offsite is that week.');
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(gm.page.getByTestId('request-status')).toHaveText('Rejected');
    await gm.close();

    // 9. The requester reads the reason.
    const hr = await contextFor(browser, 'hr');
    await openRequest(hr.page, request);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Rejected');
    await expect(hr.page.getByTestId('request-approval').first()).toContainText('George Manager · Rejected');
    await expect(hr.page.getByTestId('approval-comment')).toHaveText('The team offsite is that week.');
    await hr.close();
  });

  test('10. a multi-step route moves from the manager to the next approver', async ({ browser }) => {
    const type = await asUser(browser, 'org.admin', async (page) =>
      publishType(page, 'multistep', {
        form: { fields: [REASON_FIELD] },
        steps: [
          MANAGER_STEP,
          {
            kind: 'APPROVAL',
            name: { en: 'Engineering sign-off' },
            mode: 'ANY_ONE',
            approver: { type: 'MEMBER', memberId: await memberIdOf(page, 'Mina Manager') },
          },
        ],
      }),
    );
    const request = await asUser(browser, 'hr', (page) => submitRequest(page, type.id, { reason: `Two steps ${RUN}` }));
    await asUser(browser, 'gm', async (page) => {
      await decideInInbox(page, request.key, 'Approve', 'Step one done.');
    });
    const mina = await contextFor(browser, 'manager');
    await mina.page.goto('/approvals');
    await settled(mina.page);
    await expect(inboxItem(mina.page, request.key)).toContainText('Step: Engineering sign-off');
    await openRequest(mina.page, request);
    const steps = mina.page.getByTestId('request-step');
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'COMPLETED');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'ACTIVE');
    await expect(mina.page.getByTestId('request-status')).toHaveText('Pending approval');
    await mina.page.getByTestId('approve-request').click();
    const dialog = mina.page.getByRole('dialog', { name: `Approve · ${request.key}` });
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(mina.page.getByTestId('request-status')).toHaveText('Approved');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'COMPLETED');
    await mina.close();
  });

  test('11. a conditional step only runs when the submitted values match', async ({ browser }) => {
    const type = await asUser(browser, 'org.admin', async (page) =>
      publishType(page, 'conditional', {
        form: {
          fields: [
            {
              key: 'impact',
              type: 'select',
              label: { en: 'Impact' },
              required: true,
              options: [
                { value: 'low', label: { en: 'Low' } },
                { value: 'high', label: { en: 'High' } },
              ],
            },
            REASON_FIELD,
          ],
        },
        steps: [
          MANAGER_STEP,
          {
            kind: 'APPROVAL',
            name: { en: 'High impact review' },
            mode: 'ANY_ONE',
            approver: { type: 'MEMBER', memberId: await memberIdOf(page, 'Mina Manager') },
            condition: { match: 'all', rules: [{ field: 'impact', op: 'eq', value: 'high' }] },
          },
        ],
      }),
    );
    const { low, high } = await asUser(browser, 'hr', async (page) => ({
      low: await submitRequest(page, type.id, { impact: 'low', reason: `Low ${RUN}` }),
      high: await submitRequest(page, type.id, { impact: 'high', reason: `High ${RUN}` }),
    }));
    await asUser(browser, 'gm', async (page) => {
      await approveViaApi(page, low.id);
      await approveViaApi(page, high.id);
    });
    const hr = await contextFor(browser, 'hr');
    await openRequest(hr.page, low);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Approved');
    await expect(hr.page.getByTestId('request-step').nth(1)).toHaveAttribute('data-state', 'SKIPPED');
    await openRequest(hr.page, high);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Pending approval');
    await expect(hr.page.getByTestId('request-step').nth(1)).toHaveAttribute('data-state', 'ACTIVE');
    await expect(hr.page.getByTestId('request-step').nth(1)).toContainText('Mina Manager · Pending');
    await hr.close();
  });

  test('12. ANY needs one approver, ALL needs every approver', async ({ browser }) => {
    // George joins Hana as an HR administrator, so the HR_ADMIN role resolves to two approvers.
    await grantSystemRoleForTest('demo', 'gm@demo.company-ops.test', 'HR_ADMIN');
    try {
      await anyAndAllRoutes(browser);
    } finally {
      await revokeSystemRoleForTest('demo', 'gm@demo.company-ops.test', 'HR_ADMIN');
    }
  });

  async function anyAndAllRoutes(browser: Browser): Promise<void> {
    const { anyType, allType } = await asUser(browser, 'org.admin', async (page) => {
      const roleId = await roleIdOf(page, 'HR_ADMIN');
      const step = (mode: 'ANY_ONE' | 'ALL') => ({
        kind: 'APPROVAL',
        name: { en: `HR ${mode}` },
        mode,
        approver: { type: 'ROLE', roleId },
      });
      return {
        anyType: await publishType(page, 'any', { form: { fields: [REASON_FIELD] }, steps: [step('ANY_ONE')] }),
        allType: await publishType(page, 'all', { form: { fields: [REASON_FIELD] }, steps: [step('ALL')] }),
      };
    });
    const { anyRequest, allRequest } = await asUser(browser, 'org.admin', async (page) => ({
      anyRequest: await submitRequest(page, anyType.id, { reason: `Any ${RUN}` }),
      allRequest: await submitRequest(page, allType.id, { reason: `All ${RUN}` }),
    }));

    const hr = await contextFor(browser, 'hr');
    await decideInInbox(hr.page, anyRequest.key, 'Approve', 'One is enough.');
    await decideInInbox(hr.page, allRequest.key, 'Approve', 'First of two.');
    await openRequest(hr.page, anyRequest);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Approved');
    await expect(hr.page.getByTestId('request-approval').filter({ hasText: 'George Manager' })).toHaveAttribute(
      'data-status',
      'SUPERSEDED',
    );
    await openRequest(hr.page, allRequest);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Pending approval');
    await expect(hr.page.getByText('All approvers').first()).toBeVisible();
    await expect(hr.page.getByTestId('request-approval').filter({ hasText: 'George Manager' })).toHaveAttribute(
      'data-status',
      'PENDING',
    );
    await hr.close();

    const gm = await contextFor(browser, 'gm');
    await decideInInbox(gm.page, allRequest.key, 'Approve', 'Second of two.');
    await openRequest(gm.page, allRequest);
    await expect(gm.page.getByTestId('request-status')).toHaveText('Approved');
    await expect(gm.page.getByTestId('request-approval').and(gm.page.locator('[data-status="APPROVED"]'))).toHaveCount(
      2,
    );
    await gm.close();
  }

  test('13. a delegate approves on behalf of the manager, and the delegation is revoked', async ({ browser }) => {
    const gm = await contextFor(browser, 'gm');
    await gm.page.goto('/approvals/delegations');
    await settled(gm.page);
    const form = gm.page.getByTestId('delegation-form');
    const delegate = form.getByRole('group', { name: 'Delegate to' });
    await delegate.getByRole('searchbox').fill('Mina');
    await delegate.getByRole('radio', { name: /Mina Manager/ }).check();
    await form.getByLabel(/^Reason/).fill(`Annual leave ${RUN}`);
    await form.getByRole('button', { name: 'Create delegation' }).click();
    await expect(form.getByText('Delegation created.')).toBeVisible();
    const row = gm.page.getByTestId('delegation-row').filter({ hasText: `Annual leave ${RUN}` });
    await expect(row).toHaveAttribute('data-status', 'ACTIVE');
    await expect(row).toContainText('You delegated to Mina Manager');

    try {
      const request = await asUser(browser, 'hr', async (page) =>
        submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`Delegated ${RUN}`, 5)),
      );
      const mina = await contextFor(browser, 'manager');
      await mina.page.goto('/approvals');
      await settled(mina.page);
      await expect(inboxItem(mina.page, request.key).getByTestId('on-behalf-of')).toHaveText(
        'On behalf of George Manager',
      );
      await decideInInbox(mina.page, request.key, 'Approve', 'Approved while George is away.');
      await openRequest(mina.page, request);
      await expect(mina.page.getByTestId('request-status')).toHaveText('Approved');
      await expect(mina.page.getByTestId('request-approval').first()).toContainText(
        'decided by Mina Manager as delegate',
      );
      await mina.close();
    } finally {
      await gm.page.reload();
      await settled(gm.page);
      gm.page.once('dialog', (dialog) => {
        void dialog.accept();
      });
      await row.getByRole('button', { name: 'Revoke' }).click();
      await expect(row).toHaveAttribute('data-status', 'REVOKED');
      await gm.close();
    }
  });

  test('14. people who are not assigned cannot see or approve the request', async ({ browser }) => {
    const request = await asUser(browser, 'hr', async (page) =>
      submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`Private ${RUN}`, 8)),
    );
    const approvalId = await asUser(browser, 'gm', (page) => pendingApprovalId(page, request.id));
    for (const user of ['employee', 'manager'] as const) {
      const { page, close } = await contextFor(browser, user);
      await page.goto(`/requests/${request.id}`);
      await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
      expect((await page.request.get(`/api/v1/requests/${request.id}`)).status()).toBe(404);
      expect((await page.request.get(`/api/v1/requests/${request.id}/history`)).status()).toBe(404);
      const forged = await page.request.post(`/api/v1/approvals/${approvalId}/approve`, {
        headers: await writeHeaders(page),
        data: {},
      });
      expect(forged.status()).toBe(404);
      await page.goto('/approvals');
      await settled(page);
      await expect(inboxItem(page, request.key)).toHaveCount(0);
      await close();
    }
    // The requester sees the request but never approves it.
    await asUser(browser, 'hr', async (page) => {
      await openRequest(page, request);
      await expect(page.getByTestId('approve-request')).toHaveCount(0);
      const self = await page.request.post(`/api/v1/approvals/${approvalId}/approve`, {
        headers: await writeHeaders(page),
        data: {},
      });
      expect(self.status()).toBe(403);
    });
    await asUser(browser, 'gm', async (page) => {
      await openRequest(page, request);
      await expect(page.getByTestId('request-status')).toHaveText('Pending approval');
    });
  });

  test('builder: an administrator creates, publishes and activates a request type', async ({ browser }) => {
    const name = `E2E Built ${RUN}`;
    const admin = await contextFor(browser, 'org.admin');
    await stepUp(admin.page, 'org.admin');
    await admin.page.goto('/admin/request-types');
    await settled(admin.page);
    const create = admin.page.getByTestId('create-request-type');
    await create.getByLabel(/^Key/).fill(`e2e_built_${RUN}`);
    await create.getByLabel('Name (English)').fill(name);
    await create.getByLabel('Category').selectOption({ label: 'IT' });
    await create.getByRole('button', { name: 'Create request type' }).click();
    await expect(admin.page.getByRole('heading', { level: 1, name })).toBeVisible();

    const builder = admin.page.getByTestId('workflow-builder');
    await expect(builder).toHaveAttribute('data-editable', 'true');
    await builder.getByRole('button', { name: 'Add field' }).click();
    const field = builder.getByTestId('field-editor').first();
    await field.locator('summary').click();
    await field.getByLabel('Field key').fill('reason');
    await field.getByLabel('Field type').selectOption({ label: 'Long text' });
    await field.getByLabel('Label (English)').fill('Why do you need it?');
    await field.getByLabel('Required').check();
    // A new type starts with a direct-manager step; add a second one.
    await expect(builder.getByTestId('step-editor')).toHaveCount(1);
    await builder.getByRole('button', { name: 'Add approval step' }).click();
    await expect(builder.getByTestId('step-editor')).toHaveCount(2);
    await builder.getByTestId('save-draft').click();
    await expect(builder.getByText('Draft saved.')).toBeVisible();
    admin.page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await builder.getByTestId('publish-version').click();
    await expect(admin.page.getByText('Version 1 published.')).toBeVisible();
    await expect(admin.page.getByTestId('version-item').first()).toHaveAttribute('data-status', 'PUBLISHED');
    await admin.page.getByTestId('toggle-active').click();
    await expect(admin.page.getByTestId('toggle-active')).toHaveText('Deactivate');
    await expectNoAxeViolations(admin.page, 'request type builder');
    await admin.close();

    const hr = await contextFor(browser, 'hr');
    await hr.page.goto('/requests/new');
    await settled(hr.page);
    await hr.page.getByTestId('request-type-option').filter({ hasText: name }).click();
    await expect(hr.page.getByLabel('Why do you need it?')).toBeVisible();
    await hr.close();
  });

  test('15. a published version is read-only in the builder and through the API', async ({ browser }) => {
    const admin = await contextFor(browser, 'org.admin');
    await stepUp(admin.page, 'org.admin');
    const types = await getData<
      { id: string; key: string; publishedVersion: { id: string } | null; draftVersion: unknown }[]
    >(admin.page, '/api/v1/request-admin/types');
    const leave = types.find((type) => type.key === 'leave');
    expect(leave?.publishedVersion).not.toBeNull();
    await admin.page.goto(`/admin/request-types/${leave?.id ?? ''}`);
    await settled(admin.page);
    const builder = admin.page.getByTestId('workflow-builder');
    await expect(builder).toHaveAttribute('data-editable', 'false');
    await expect(admin.page.getByTestId('version-readonly')).toBeVisible();
    await expect(builder.getByTestId('save-draft')).toHaveCount(0);
    await expect(builder.getByTestId('publish-version')).toHaveCount(0);
    await expect(builder.getByRole('button', { name: 'Add field' })).toHaveCount(0);
    const version = await getData<{ revision: number }>(
      admin.page,
      `/api/v1/request-admin/types/${leave?.id ?? ''}/versions/${leave?.publishedVersion?.id ?? ''}`,
    );
    const edit = await admin.page.request.put(
      `/api/v1/request-admin/types/${leave?.id ?? ''}/versions/${leave?.publishedVersion?.id ?? ''}`,
      {
        headers: await writeHeaders(admin.page),
        data: { form: { fields: [REASON_FIELD] }, steps: [MANAGER_STEP], ...SETTINGS, revision: version.revision },
      },
    );
    expect(edit.status()).toBe(409);
    expect(((await edit.json()) as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
    await admin.close();
  });

  test('16. publishing a new version never changes a request submitted on the old one', async ({ browser }) => {
    const type = await asUser(browser, 'org.admin', (page) =>
      publishType(page, 'versioned', { form: { fields: [REASON_FIELD] }, steps: [MANAGER_STEP] }),
    );
    const request = await asUser(browser, 'hr', (page) =>
      submitRequest(page, type.id, { reason: `Old version ${RUN}` }),
    );

    const admin = await contextFor(browser, 'org.admin');
    await stepUp(admin.page, 'org.admin');
    await admin.page.goto(`/admin/request-types/${type.id}`);
    await settled(admin.page);
    await admin.page.getByTestId('new-version').click();
    const builder = admin.page.getByTestId('workflow-builder');
    await expect(builder).toHaveAttribute('data-editable', 'true');
    const field = builder.getByTestId('field-editor').and(admin.page.locator('[data-key="reason"]'));
    await field.locator('summary').click();
    await field.getByLabel('Label (English)').fill('Justification');
    admin.page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await builder.getByTestId('publish-version').click();
    await expect(admin.page.getByText('Version 2 published.')).toBeVisible();
    await expect(admin.page.getByTestId('version-item').and(admin.page.locator('[data-number="1"]'))).toHaveAttribute(
      'data-status',
      'RETIRED',
    );
    await admin.close();

    const hr = await contextFor(browser, 'hr');
    await openRequest(hr.page, request);
    await expect(hr.page.getByTestId('workflow-version')).toHaveText('Workflow version 1');
    await expect(hr.page.getByTestId('request-form-data')).toContainText('Reason');
    await expect(hr.page.getByTestId('request-form-data')).not.toContainText('Justification');
    await hr.page.goto(`/requests/new?type=${type.id}`);
    await expect(hr.page.getByLabel('Justification')).toBeVisible();
    await hr.close();
    await asUser(browser, 'gm', async (page) => {
      await approveViaApi(page, request.id);
      const approved = await getData<{ status: string; workflowVersion: { number: number } }>(
        page,
        `/api/v1/requests/${request.id}`,
      );
      expect(approved).toMatchObject({ status: 'APPROVED', workflowVersion: { number: 1 } });
    });
  });

  test('17. attachments upload with the request; only people involved can list or download them', async ({
    browser,
  }) => {
    const item = `Docking station ${RUN}`;
    const hr = await contextFor(browser, 'hr');
    await hr.page.goto('/requests/new');
    await settled(hr.page);
    await hr.page.getByTestId('request-type-option').and(hr.page.locator('[data-key="purchase"]')).click();
    await expect(hr.page.getByRole('heading', { level: 1, name: 'Purchase' })).toBeVisible();
    await hr.page.getByLabel(/^Item/).fill(item);
    await hr.page.getByLabel(/^Estimated amount/).fill('2500');
    await hr.page.getByLabel(/^Reason/).fill('The current one stopped charging.');
    const files = hr.page.getByLabel(/^Attachments/);
    await files.setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(hr.page.getByText('This file type is not allowed.')).toBeVisible();
    await files.setInputFiles({ name: 'quote.png', mimeType: 'image/png', buffer: PNG });
    await expect(hr.page.getByTestId('new-request-files')).toContainText('quote.png');
    await hr.page.getByTestId('submit-request').click();
    await expect(hr.page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Pending approval');
    await expect(hr.page.getByTestId('request-attachments')).toContainText('quote.png');
    const requestId = hr.page.url().split('/').at(-1) ?? '';
    const listing = await getData<{ id: string; filename: string }[]>(
      hr.page,
      `/api/v1/attachments?ownerType=REQUEST&ownerId=${requestId}`,
    );
    const attachmentId = listing.find((attachment) => attachment.filename === 'quote.png')?.id ?? '';
    expect(attachmentId).not.toBe('');
    expect((await hr.page.request.get(`/api/v1/attachments/${attachmentId}/download-url`)).status()).toBe(200);
    await hr.close();

    // The approver can review the attachment.
    await asUser(browser, 'gm', async (page) => {
      await page.goto(`/requests/${requestId}`);
      await settled(page);
      await expect(page.getByTestId('request-attachments')).toContainText('quote.png');
      expect((await page.request.get(`/api/v1/attachments/${attachmentId}/download-url`)).status()).toBe(200);
    });
    // IDOR: an unrelated employee guesses the ids.
    await asUser(browser, 'employee', async (page) => {
      const list = await page.request.get(`/api/v1/attachments?ownerType=REQUEST&ownerId=${requestId}`);
      expect([403, 404]).toContain(list.status());
      expect((await page.request.get(`/api/v1/attachments/${attachmentId}`)).status()).toBe(404);
      expect((await page.request.get(`/api/v1/attachments/${attachmentId}/download-url`)).status()).toBe(404);
      const intent = await page.request.post('/api/v1/attachments/upload-intents', {
        headers: await writeHeaders(page),
        data: { ownerType: 'REQUEST', ownerId: requestId, filename: 'x.png', contentType: 'image/png', sizeBytes: 68 },
      });
      expect([403, 404]).toContain(intent.status());
    });
  });

  test('18. mobile: an employee submits and follows a request at 375 px', async ({ browser }) => {
    const reason = `Mobile request ${RUN}`;
    const { page, close } = await contextFor(browser, 'hr', { viewport: { width: 375, height: 812 }, hasTouch: true });
    await page.goto('/requests/new');
    await settled(page);
    await expectNoHorizontalOverflow(page, '/requests/new at 375 px');
    await page.getByTestId('request-type-option').and(page.locator('[data-key="work_from_home"]')).click();
    await page.getByLabel('From').fill('2027-03-22');
    await page.getByLabel(/^Reason/).fill(reason);
    await expectNoHorizontalOverflow(page, 'work from home form at 375 px');
    await page.getByTestId('submit-request').click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('request-status')).toHaveText('Pending approval');
    await expectNoHorizontalOverflow(page, 'request detail at 375 px');
    await expectNoAxeViolations(page, 'request detail at 375 px');
    await page.goto('/requests');
    await settled(page);
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.getByTestId('request-card').first()).toBeVisible();
    await expectNoHorizontalOverflow(page, '/requests at 375 px');
    await close();
  });

  test('19. RTL: the request screens render right-to-left in Arabic', async ({ browser }) => {
    const request = await asUser(browser, 'hr', async (page) =>
      submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`RTL ${RUN}`, 9)),
    );
    const { page, close } = await contextFor(browser, 'gm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto('/requests');
      await expect(page.getByRole('heading', { level: 1, name: ar.requests.title })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page, '/requests (ar)');
      await expectNoAxeViolations(page, '/requests (ar)');

      await page.goto('/requests/new');
      await expect(page.getByRole('heading', { level: 1, name: ar.requests.create.title })).toBeVisible();
      await expect(page.getByTestId('request-type-option').and(page.locator('[data-key="leave"]'))).toContainText(
        'إجازة',
      );
      await expectNoHorizontalOverflow(page, '/requests/new (ar)');
      await expectNoAxeViolations(page, '/requests/new (ar)');

      await page.goto('/approvals');
      await expect(page.getByRole('heading', { level: 1, name: ar.approvals.title })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page, '/approvals (ar)');
      await expectNoAxeViolations(page, '/approvals (ar)');

      await page.goto(`/requests/${request.id}`);
      await expect(page.getByText(ar.requests.detail.route).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('العمل من المنزل');
      await expectNoHorizontalOverflow(page, 'request detail (ar)');
      await expectNoAxeViolations(page, 'request detail (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  test('20. notifications: the approver gets a bell link and one email without the form contents', async ({
    browser,
  }) => {
    const secret = `Confidential medical detail ${RUN}`;
    const request = await asUser(browser, 'hr', async (page) =>
      submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(secret, 11)),
    );
    const gm = await contextFor(browser, 'gm');
    const link = gm.page.getByRole('link', { name: `${request.key} (Work from home) needs your approval.` });
    await expect(async () => {
      await gm.page.goto('/notifications');
      await expect(link).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await link.click();
    await expect(gm.page).toHaveURL(new RegExp(`/requests/${request.id}$`));
    await expect(gm.page.getByTestId('approve-request')).toBeVisible();

    await expect.poll(async () => (await mailsFor(gm.page, GM_EMAIL, request.key)).length, { timeout: 45_000 }).toBe(1);
    // Give the worker time for any (wrong) extra delivery, then check again: exactly one email.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const mails = await mailsFor(gm.page, GM_EMAIL, request.key);
    expect(mails.map((mail) => mail.Subject)).toEqual([`[${request.key}] Approval needed: Work from home`]);
    for (const mail of mails) {
      expect(await mailText(gm.page, mail.ID)).not.toContain(secret);
    }

    // Live update: the requester's open page follows the decision without a reload.
    const hr = await contextFor(browser, 'hr');
    await openRequest(hr.page, request);
    await approveViaApi(gm.page, request.id);
    await expect(hr.page.getByTestId('request-status')).toHaveText('Approved', { timeout: 45_000 });
    await hr.close();
    await gm.close();
  });

  for (const width of WIDTHS) {
    test(`responsive layout and axe on the request screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const request = await asUser(browser, 'hr', async (page) =>
        submitRequest(page, await seededTypeId(page, 'work_from_home'), wfhData(`Axe ${String(width)} ${RUN}`, 12)),
      );
      const leaveId = await asUser(browser, 'hr', (page) => seededTypeId(page, 'leave'));
      const hr = await contextFor(browser, 'hr', { viewport });
      for (const path of ['/requests', '/requests/new', `/requests/new?type=${leaveId}`, `/requests/${request.id}`]) {
        await hr.page.goto(path);
        await settled(hr.page);
        await expectNoHorizontalOverflow(hr.page, `${path} at ${String(width)} px`);
        await expectNoAxeViolations(hr.page, `${path} at ${String(width)} px`);
      }
      await hr.close();

      const gm = await contextFor(browser, 'gm', { viewport });
      for (const path of ['/approvals', '/approvals/delegations', `/requests/${request.id}`]) {
        await gm.page.goto(path);
        await settled(gm.page);
        await expectNoHorizontalOverflow(gm.page, `${path} (approver) at ${String(width)} px`);
        await expectNoAxeViolations(gm.page, `${path} (approver) at ${String(width)} px`);
      }
      await gm.page.goto(`/requests/${request.id}`);
      await settled(gm.page);
      await gm.page.getByTestId('approve-request').click();
      await expect(gm.page.getByRole('dialog', { name: `Approve · ${request.key}` })).toBeVisible();
      await expectNoAxeViolations(gm.page, `approve dialog at ${String(width)} px`);
      await gm.close();

      const admin = await contextFor(browser, 'org.admin', { viewport });
      await stepUp(admin.page, 'org.admin');
      await admin.page.goto('/admin/request-types');
      await settled(admin.page);
      await expectNoHorizontalOverflow(admin.page, `/admin/request-types at ${String(width)} px`);
      await expectNoAxeViolations(admin.page, `/admin/request-types at ${String(width)} px`);
      await admin.page
        .getByTestId('request-type-row')
        .and(admin.page.locator('[data-key="purchase"]'))
        .getByRole('link')
        .first()
        .click();
      await settled(admin.page);
      await expect(admin.page.getByTestId('workflow-builder')).toBeVisible();
      await expectNoHorizontalOverflow(admin.page, `purchase workflow at ${String(width)} px`);
      await expectNoAxeViolations(admin.page, `purchase workflow at ${String(width)} px`);
      await admin.close();
    });
  }
});
