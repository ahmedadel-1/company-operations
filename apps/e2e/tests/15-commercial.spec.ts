import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor } from '../support/auth.js';
import type { DemoUser } from '../support/auth.js';
import { createForeignCommercialForTest } from '../support/baseline.js';
import { asUser, get, IHD, projectId, send, settled } from '../support/integration.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  commercial: {
    tenders: { title: string };
    contracts: { title: string };
    tenderStatuses: { NEW: string };
    contractStatuses: { DRAFT: string };
  };
};

const RUN = randomUUID().slice(0, 8);
const ZONE = 'Africa/Cairo';
const PDF = Buffer.from('%PDF-1.7\n%e2e commercial document\n');
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true } as const;
const DAY_MS = 86_400_000;

/**
 * Phase 10: tenders, the corporate document vault and contracts (ADR-0026). Every test creates its own
 * records with run-unique titles (API set-up where the journey itself is not under test), so the tests
 * are independent of each other and of what earlier spec files left behind. Dates are calendar days
 * of the demo organization (Africa/Cairo), the zone the API evaluates them in.
 */
interface TenderRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly status: string;
  readonly submissionDeadlineAt: string | null;
  readonly submissionDeadlineTimeZone: string | null;
  readonly estimatedValue?: { readonly amount: string; readonly currency: string } | null;
}

interface ContractRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly status: string;
  readonly originalValue?: { readonly amount: string; readonly currency: string } | null;
  readonly currentValue?: { readonly amount: string; readonly currency: string } | null;
  readonly originalExpiryDate: string | null;
  readonly currentExpiryDate: string | null;
  readonly renewalNoticeDeadline: string | null;
  readonly project: { readonly id: string } | null;
  readonly sourceTender: { readonly id: string } | null;
}

interface RequirementRef {
  readonly id: string;
  readonly title: string;
}

interface DocumentList {
  readonly items: readonly {
    readonly id: string;
    readonly title: string;
    readonly classification: string;
    readonly versions: readonly { readonly attachmentId: string; readonly isCurrent: boolean }[];
  }[];
}

interface TimelineEvent {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface CorporateDocumentRef {
  readonly id: string;
  readonly title: string;
}

interface SearchBody {
  readonly groups: readonly {
    readonly type: string;
    readonly items: readonly { readonly id: string; readonly title: string }[];
  }[];
}

/** Calendar date `offset` days from today in the demo organization's zone. */
function day(offset: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + offset * DAY_MS),
  );
}

async function loaded(page: Page): Promise<void> {
  await settled(page);
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
}

/** Opens a screen; a `#tab` target is reloaded so the tab bar reads it even from the same page. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  if (path.includes('#')) {
    await page.reload();
  }
  await loaded(page);
}

async function memberOf(page: Page, fullName: string): Promise<string> {
  const rows = await get<{ fullName: string; memberId: string | null }[]>(
    page,
    `/api/v1/employees?q=${encodeURIComponent(fullName)}`,
  );
  const id = rows.find((row) => row.fullName === fullName)?.memberId ?? null;
  expect(id, `member of ${fullName}`).not.toBeNull();
  return id ?? '';
}

/** Chooses a person in an EmployeePicker (a fieldset named by its legend). */
async function pick(scope: Page | Locator, legend: string, fullName: string): Promise<void> {
  const group = scope.getByRole('group', { name: legend, exact: true });
  await group.getByRole('searchbox').fill(fullName);
  await group.getByRole('radio', { name: new RegExp(`^${fullName} ·`) }).check();
}

async function tab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

async function createTender(
  page: Page,
  title: string,
  options: { readonly ownerMemberId: string; readonly projectId?: string },
): Promise<TenderRef> {
  return send<TenderRef>(page, 'POST', '/api/v1/tenders', {
    title,
    tenderType: 'RFQ',
    ownerMemberId: options.ownerMemberId,
    status: 'NEW',
    submissionDeadlineAt: `${day(20)}T09:00:00.000Z`,
    submissionDeadlineTimeZone: ZONE,
    estimatedValue: '1250000.00',
    currency: 'EGP',
    ...(options.projectId === undefined ? {} : { relatedProjectId: options.projectId }),
  });
}

async function addRequirement(
  page: Page,
  tenderId: string,
  title: string,
  ownerMemberId: string | null,
): Promise<RequirementRef> {
  return send<RequirementRef>(page, 'POST', `/api/v1/tenders/${tenderId}/requirements`, {
    category: 'ADMINISTRATIVE',
    title,
    mandatory: true,
    dueDate: day(5),
    ...(ownerMemberId === null ? {} : { ownerMemberId }),
  });
}

/**
 * A DRAFT contract. Screen-only tests use drafts: status changes count against the per-user
 * `sensitive` rate limit, which the suite keeps at its production value.
 */
async function draftContract(
  page: Page,
  title: string,
  options: { readonly ownerMemberId: string; readonly projectId?: string },
): Promise<ContractRef> {
  return send<ContractRef>(page, 'POST', '/api/v1/contracts', {
    title,
    contractType: 'SUPPORT',
    currency: 'EGP',
    originalValue: '480000.00',
    startDate: day(-10),
    expiryDate: day(60),
    renewalType: 'MANUAL_RENEWAL',
    noticePeriodDays: 30,
    ownerMemberId: options.ownerMemberId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
  });
}

/** An ACTIVE contract (created and moved through its approval states by the general manager). */
async function activeContract(
  page: Page,
  title: string,
  options: { readonly ownerMemberId: string; readonly projectId?: string },
): Promise<ContractRef> {
  let contract = await draftContract(page, title, options);
  for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
    contract = await send<ContractRef>(page, 'POST', `/api/v1/contracts/${contract.id}/transition`, {
      version: contract.version,
      to,
    });
  }
  expect(contract.status).toBe('ACTIVE');
  return contract;
}

async function search(page: Page, text: string): Promise<void> {
  if (await page.getByTestId('search-trigger').isVisible()) {
    await page.getByTestId('search-trigger').click();
  } else {
    await page.getByRole('button', { name: 'Open search' }).click();
  }
  await expect(page.getByTestId('search-dialog')).toBeVisible();
  await page.getByTestId('search-input').fill(text);
  await expect(page.getByTestId('search-dialog').getByText(/^\d+ results?$|^No results you can open\.$/)).toBeVisible();
}

async function metricValue(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(`${testId}-value`).textContent()) ?? '';
  expect(text, `${testId} value`).toMatch(/^\d+$/);
  return Number(text);
}

/** Rows of a list screen after paging to the end. */
async function listedRows(page: Page, testId: string): Promise<number> {
  await loaded(page);
  const rows = page.getByTestId(testId);
  const more = page.getByRole('button', { name: 'Load more', exact: true });
  while (await more.isVisible()) {
    const before = await rows.count();
    await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
    await expect(page.locator('.animate-pulse')).toHaveCount(0);
  }
  return rows.count();
}

/** Uploads a PDF through a document version input and waits until the version is listed. */
async function uploadVersion(scope: Locator, name: string, expectText: string | RegExp): Promise<void> {
  await scope.getByTestId('version-upload').setInputFiles({ name, mimeType: 'application/pdf', buffer: PDF });
  await expect(scope).toContainText(expectText, { timeout: 30_000 });
}

test.describe('Phase 10: tenders and contracts', () => {
  test('1–14, 33. a tender from creation through review, submission and award to its contract', async ({ browser }) => {
    test.setTimeout(300_000);
    const title = `Network refresh tender ${RUN}`;
    const ownedTitle = `Company profile ${RUN}`;
    const otherTitle = `Bank reference letter ${RUN}`;
    const gm = await contextFor(browser, 'gm');
    const employee = await contextFor(browser, 'employee');
    const manager = await contextFor(browser, 'manager');
    try {
      const ihd = await projectId(gm.page, IHD);

      // 1. Created by an authorized user through the form; the deadline is entered in the organization's zone.
      await open(gm.page, '/tenders');
      await gm.page.getByRole('link', { name: 'New tender' }).click();
      await expect(gm.page.getByTestId('tender-form')).toBeVisible();
      await gm.page.getByLabel(/^Title/).fill(title);
      await gm.page.getByLabel(/^Related project/).selectOption(ihd);
      await gm.page.getByLabel(/^Submission deadline/).fill(`${day(20)}T12:00`);
      await expect(gm.page.getByText(`Time in ${ZONE}.`).first()).toBeVisible();
      await gm.page.getByLabel(/^Estimated value/).fill('1250000.00');
      await gm.page.getByRole('button', { name: 'Create tender' }).click();
      await expect(gm.page).toHaveURL(/\/tenders\/[0-9a-f-]{36}$/);
      await loaded(gm.page);
      const tenderId = gm.page.url().split('/').at(-1) ?? '';
      await expect(gm.page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'NEW');
      const created = await get<TenderRef>(gm.page, `/api/v1/tenders/${tenderId}`);
      expect(created.submissionDeadlineTimeZone).toBe(ZONE);
      // 12:00 in Cairo is 09:00 or 10:00 UTC (summer/winter), whatever zone the browser runs in.
      expect([9, 10]).toContain(new Date(created.submissionDeadlineAt ?? '').getUTCHours());

      // 7. Bid decision moves the tender into preparation.
      await gm.page.getByTestId('bid-decision').click();
      await dialog(gm.page).getByRole('button', { name: 'Record decision' }).click();
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'PREPARING');
      await expect(gm.page.getByText('Bid decision recorded.')).toBeVisible();

      // 2–3. Two mandatory requirements: one assigned to Emad, one unassigned.
      await tab(gm.page, 'Requirements');
      await gm.page.getByTestId('add-requirement').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(ownedTitle);
      await dialog(gm.page)
        .getByLabel(/^Due date/)
        .fill(day(5));
      await pick(dialog(gm.page), 'Owner', 'Emad Employee');
      await dialog(gm.page).getByRole('button', { name: 'Add requirement' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      await gm.page.getByTestId('add-requirement').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(otherTitle);
      await dialog(gm.page).getByRole('button', { name: 'Add requirement' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const owned = gm.page.getByTestId('requirement').filter({ hasText: ownedTitle });
      const other = gm.page.getByTestId('requirement').filter({ hasText: otherTitle });
      await expect(owned).toContainText('Emad Employee');
      await expect(other).toContainText('Unassigned');
      await tab(gm.page, 'Overview');
      await expect(gm.page.getByTestId('readiness-percent')).toHaveText('0% ready');
      const tender = await get<TenderRef>(gm.page, `/api/v1/tenders/${tenderId}`);

      // 4. The owner is notified, follows the link and finds the work in My tender work.
      const notice = employee.page.getByRole('link', {
        name: `${tender.key}: you own the requirement “${ownedTitle}”.`,
      });
      await expect(async () => {
        await employee.page.goto('/notifications');
        await expect(notice).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 45_000 });
      await open(employee.page, '/tenders/my-work');
      const item = employee.page.getByTestId('work-item').filter({ hasText: ownedTitle });
      await expect(item).toHaveCount(1);
      await expect(item).toContainText(tender.key);
      await expect(employee.page.getByTestId('work-item').filter({ hasText: otherTitle })).toHaveCount(0);

      // 5. The owner works the requirement (involved access only).
      await item.click();
      await expect(employee.page).toHaveURL(new RegExp(`/tenders/${tenderId}#requirements$`));
      await loaded(employee.page);
      const mine = employee.page.getByTestId('requirement').filter({ hasText: ownedTitle });
      await mine.getByTestId('requirement-IN_PROGRESS').click();
      await expect(mine).toHaveAttribute('data-status', 'IN_PROGRESS');
      await mine.getByTestId('requirement-READY_FOR_REVIEW').click();
      await expect(mine).toHaveAttribute('data-status', 'READY_FOR_REVIEW');
      await expect(employee.page.getByTestId('requirement').filter({ hasText: otherTitle })).toHaveCount(0);

      // 33. No financial values for the involved employee: not on screen, not in the API.
      await tab(employee.page, 'Overview');
      await expect(employee.page.getByTestId('tender-header')).toContainText(
        'You can see this record because you own work on it.',
      );
      await expect(employee.page.getByTestId('money')).toHaveCount(0);
      await expect(employee.page.locator('main')).not.toContainText('1,250,000');
      const seen = await get<TenderRef>(employee.page, `/api/v1/tenders/${tenderId}`);
      expect(seen.estimatedValue).toBeUndefined();

      // 5–6. The manager approves one and waives the other; readiness follows.
      await gm.page.reload();
      await loaded(gm.page);
      await tab(gm.page, 'Requirements');
      await owned.getByTestId('requirement-APPROVED').click();
      await expect(owned).toHaveAttribute('data-status', 'APPROVED');
      await tab(gm.page, 'Overview');
      await expect(gm.page.getByTestId('readiness-percent')).toHaveText('50% ready');
      await tab(gm.page, 'Requirements');
      await other.getByTestId('requirement-NOT_APPLICABLE').click();
      await expect(other).toHaveAttribute('data-status', 'NOT_APPLICABLE');
      await tab(gm.page, 'Overview');
      await expect(gm.page.getByTestId('readiness-percent')).toHaveText('100% ready');
      // The waived requirement leaves the denominator; detail, list row and readiness filter agree.
      const ready = (await get<{ readiness: Record<string, unknown> }>(gm.page, `/api/v1/tenders/${tenderId}`))
        .readiness;
      expect(ready).toMatchObject({ state: 'READY', percent: 100, mandatoryApplicable: 1, mandatoryApproved: 1 });
      const rows = await get<{ id: string; readiness: Record<string, unknown> }[]>(
        gm.page,
        `/api/v1/tenders?q=${encodeURIComponent(title)}&readiness=ready`,
      );
      const row = rows.find((candidate) => candidate.id === tenderId);
      for (const key of ['state', 'percent', 'mandatoryApplicable', 'mandatoryApproved', 'total', 'unassigned']) {
        expect(row?.readiness[key], `list readiness.${key}`).toEqual(ready[key]);
      }

      // 8. Final approval requested from Mina.
      await gm.page.getByTestId('request-review').click();
      await pick(dialog(gm.page), 'Reviewer for Final approval', 'Mina Manager');
      await dialog(gm.page).getByRole('button', { name: 'Request review' }).click();
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'INTERNAL_REVIEW');

      // 9–10. The configured reviewer approves from her work list; the tender is ready for submission.
      await open(manager.page, '/tenders/my-work');
      await manager.page.getByTestId('work-reviews').getByRole('link').filter({ hasText: title }).click();
      await expect(manager.page).toHaveURL(new RegExp(`/tenders/${tenderId}#reviews$`));
      await loaded(manager.page);
      const gate = manager.page.getByTestId('review-gate').filter({ has: manager.page.getByTestId('review-decision') });
      await expect(gate).toHaveAttribute('data-gate', 'FINAL');
      await gate.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(manager.page.getByTestId('review-gate')).toHaveAttribute('data-status', 'APPROVED');
      await expect(manager.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'READY_FOR_SUBMISSION');
      await expect(manager.page.getByTestId('tender-status')).toHaveText('Ready for submission');

      // 11. Proof of submission uploaded, then the submission recorded.
      await gm.page.reload();
      await loaded(gm.page);
      await tab(gm.page, 'Documents');
      await gm.page.getByTestId('add-document').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(`Portal receipt ${RUN}`);
      await dialog(gm.page)
        .getByLabel(/^Category/)
        .selectOption({ label: 'Proof of submission' });
      await dialog(gm.page).getByRole('button', { name: 'Add document' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const receipt = gm.page.getByTestId('commercial-document').filter({ hasText: `Portal receipt ${RUN}` });
      await expect(receipt).toContainText('No file uploaded yet');
      await uploadVersion(receipt, 'portal-receipt.pdf', 'Version 1');
      await tab(gm.page, 'Overview');
      await gm.page.getByTestId('submit-tender').click();
      await dialog(gm.page)
        .getByLabel(/^Evidence/)
        .selectOption({ label: `Portal receipt ${RUN} · Version 1` });
      await dialog(gm.page)
        .getByLabel(/^Reference/)
        .fill(`PORTAL-${RUN}`);
      await dialog(gm.page).getByRole('button', { name: 'Record', exact: true }).click();
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'SUBMITTED');
      await tab(gm.page, 'Submission');
      await expect(gm.page.getByTestId('submissions')).toContainText(`PORTAL-${RUN}`);
      await expect(gm.page.getByTestId('submission-evidence')).toHaveText(
        `Evidence: Portal receipt ${RUN} · Version 1`,
      );
      const submissions = await get<{ evidence: { title: string; versionNumber: number } | null }[]>(
        gm.page,
        `/api/v1/tenders/${tenderId}/submissions`,
      );
      expect(submissions.map((row) => row.evidence)).toEqual([
        expect.objectContaining({ title: `Portal receipt ${RUN}`, versionNumber: 1 }),
      ]);

      // 12. Award recorded.
      await tab(gm.page, 'Overview');
      await gm.page.getByTestId('record-award').click();
      await dialog(gm.page)
        .getByLabel(/^Award value/)
        .fill('1190000.00');
      await dialog(gm.page).getByRole('button', { name: 'Record award' }).click();
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'AWARDED');

      // 13–15. Contract created from the tender, linked back to it and to the tender's project.
      await gm.page.getByTestId('create-contract').click();
      await dialog(gm.page)
        .getByLabel(/^Start date/)
        .fill(day(1));
      await dialog(gm.page)
        .getByLabel(/^Expiry date/)
        .fill(day(366));
      await dialog(gm.page).getByRole('button', { name: 'Create contract' }).click();
      await expect(gm.page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
      await loaded(gm.page);
      const contractId = gm.page.url().split('/').at(-1) ?? '';
      await expect(gm.page.getByTestId('contract-status')).toHaveAttribute('data-status', 'DRAFT');
      const source = gm.page.getByRole('link', { name: `${tender.key} · ${title}` });
      await expect(source).toHaveAttribute('href', `/tenders/${tenderId}`);
      await expect(gm.page.locator('main')).toContainText(IHD);
      await expect(gm.page.locator('main')).toContainText('1,190,000');
      const contract = await get<ContractRef>(gm.page, `/api/v1/contracts/${contractId}`);
      expect(contract.sourceTender?.id).toBe(tenderId);
      expect(contract.project?.id).toBe(ihd);
      expect(contract.currentValue?.amount).toBe('1190000');
      await source.click();
      await expect(gm.page).toHaveURL(new RegExp(`/tenders/${tenderId}(#overview)?$`));
      await loaded(gm.page);
      await expect(gm.page.getByTestId('tender-status')).toHaveAttribute('data-status', 'AWARDED');
    } finally {
      await manager.close();
      await employee.close();
      await gm.close();
    }
  });

  test('15–25. a contract: obligations, milestones, guarantees, amendments and its renewal dates', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const gm = await contextFor(browser, 'gm');
    const manager = await contextFor(browser, 'manager');
    try {
      const ihd = await projectId(gm.page, IHD);
      const contract = await activeContract(gm.page, `Helpdesk support agreement ${RUN}`, {
        ownerMemberId: await memberOf(gm.page, 'George Manager'),
        projectId: ihd,
      });
      await open(gm.page, `/contracts/${contract.id}`);
      await expect(gm.page.getByTestId('contract-status')).toHaveAttribute('data-status', 'ACTIVE');
      await expect(gm.page.locator('main')).toContainText(IHD);

      // 16–17. A monthly obligation whose series ends before the second month yields one occurrence.
      await tab(gm.page, 'Obligations');
      await gm.page.getByTestId('add-obligation').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(`Monthly SLA report ${RUN}`);
      await dialog(gm.page)
        .getByLabel(/^First due date/)
        .fill(day(3));
      await dialog(gm.page)
        .getByLabel(/^Recurrence/)
        .selectOption({ label: 'Monthly' });
      await dialog(gm.page)
        .getByLabel(/^Repeat until/)
        .fill(day(20));
      await dialog(gm.page).getByRole('button', { name: 'Add obligation' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const obligation = gm.page.getByTestId('obligation').filter({ hasText: `Monthly SLA report ${RUN}` });
      await expect(obligation).toContainText('Monthly');
      await expect(obligation.getByTestId('occurrence')).toHaveCount(1);
      const occurrences = await get<{ dueDate: string }[]>(gm.page, `/api/v1/contracts/${contract.id}/occurrences`);
      expect(occurrences.map((row) => row.dueDate)).toEqual([day(3)]);
      await obligation.getByTestId('complete-occurrence').click();
      await expect(obligation.getByTestId('occurrence')).toHaveCount(0);
      await expect(obligation).toContainText('1 past occurrence');
      // Generation is idempotent: reopening the contract does not add a second occurrence.
      await open(gm.page, `/contracts/${contract.id}#obligations`);
      await expect(obligation).toContainText('1 past occurrence');
      const regenerated = await get<{ dueDate: string; status: string }[]>(
        gm.page,
        `/api/v1/contracts/${contract.id}/occurrences`,
      );
      expect(regenerated.map((row) => [row.dueDate, row.status])).toEqual([[day(3), 'COMPLETED']]);

      // 18. Milestone created and completed.
      await tab(gm.page, 'Milestones');
      await gm.page.getByTestId('add-milestone').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(`Go-live acceptance ${RUN}`);
      await dialog(gm.page)
        .getByLabel(/^Due date/)
        .fill(day(20));
      await dialog(gm.page).getByRole('button', { name: 'Add milestone' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const milestone = gm.page.getByTestId('milestone').filter({ hasText: `Go-live acceptance ${RUN}` });
      await expect(milestone).toHaveAttribute('data-status', 'NOT_STARTED');
      await milestone.getByTestId('milestone-IN_PROGRESS').click();
      await expect(milestone).toHaveAttribute('data-status', 'IN_PROGRESS');
      await expect(milestone).toContainText('Approval required');
      await milestone.getByTestId('milestone-SUBMITTED').click();
      await expect(milestone).toHaveAttribute('data-status', 'SUBMITTED');
      await milestone.getByTestId('milestone-APPROVED').click();
      await expect(milestone).toHaveAttribute('data-status', 'APPROVED');
      await milestone.getByTestId('milestone-COMPLETED').click();
      await expect(milestone).toHaveAttribute('data-status', 'COMPLETED');

      // 19–20. A guarantee expiring in ten days is flagged on the contract.
      await tab(gm.page, 'Guarantees');
      await gm.page.getByTestId('add-guarantee').click();
      await dialog(gm.page)
        .getByLabel(/^Reference number/)
        .fill(`PG-${RUN}`);
      await dialog(gm.page)
        .getByLabel(/^Issuer/)
        .fill('National Bank');
      await dialog(gm.page)
        .getByLabel(/^Amount/)
        .fill('48000.00');
      await dialog(gm.page)
        .getByLabel(/^Issue date/)
        .fill(day(-5));
      await dialog(gm.page)
        .getByLabel(/^Expiry date/)
        .fill(day(10));
      await dialog(gm.page).getByRole('button', { name: 'Add guarantee' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const guarantee = gm.page.getByTestId('guarantee').filter({ hasText: `PG-${RUN}` });
      await expect(guarantee.getByTestId('guarantee-status')).toHaveAttribute('data-status', 'EXPIRING');
      await expect(guarantee.getByTestId('guarantee-status')).toHaveText('Expiring');
      await expect(guarantee).toContainText('10 days');

      // 25. Notice deadline shown from the original expiry and notice period.
      await tab(gm.page, 'Overview');
      await expect(gm.page.locator('main')).toContainText('Notice deadline');
      const before = await get<ContractRef>(gm.page, `/api/v1/contracts/${contract.id}`);
      expect(before.renewalNoticeDeadline).toBe(day(30));

      // 21. Amendment created and submitted by the technical manager, approved and made effective by
      // the general manager (four eyes).
      await open(manager.page, `/contracts/${contract.id}#amendments`);
      await manager.page.getByTestId('add-amendment').click();
      await dialog(manager.page)
        .getByLabel(/^Title/)
        .fill(`Additional site ${RUN}`);
      await dialog(manager.page)
        .getByLabel(/^Effective date/)
        .fill(day(0));
      await dialog(manager.page)
        .getByLabel(/^New expiry/)
        .fill(day(120));
      await dialog(manager.page)
        .getByLabel(/^Value change/)
        .fill('25000.00');
      await dialog(manager.page).getByRole('button', { name: 'Add amendment' }).click();
      await expect(dialog(manager.page)).toBeHidden();
      const drafted = manager.page.getByTestId('amendment').filter({ hasText: `Additional site ${RUN}` });
      await drafted.getByTestId('amendment-SUBMIT').click();
      await expect(drafted).toHaveAttribute('data-status', 'UNDER_REVIEW');
      await expect(drafted.getByTestId('amendment-APPROVE')).toHaveCount(0);

      await open(gm.page, `/contracts/${contract.id}#amendments`);
      const amendment = gm.page.getByTestId('amendment').filter({ hasText: `Additional site ${RUN}` });
      await amendment.getByTestId('amendment-APPROVE').click();
      await expect(amendment).toHaveAttribute('data-status', 'APPROVED');
      await amendment.getByTestId('amendment-ACTIVATE').click();
      await expect(amendment).toHaveAttribute('data-status', 'EFFECTIVE');
      await expect(amendment.getByTestId('amendment-status')).toHaveText('Effective');

      // 22–24. Current value and expiry follow the amendment; the original baseline stays.
      const after = await get<ContractRef>(gm.page, `/api/v1/contracts/${contract.id}`);
      expect(after.originalValue?.amount).toBe('480000');
      expect(after.currentValue?.amount).toBe('505000');
      expect(after.originalExpiryDate).toBe(day(60));
      expect(after.currentExpiryDate).toBe(day(120));
      expect(after.renewalNoticeDeadline).toBe(day(90));
      await tab(gm.page, 'Overview');
      await expect(gm.page.locator('main')).toContainText('480,000');
      await expect(gm.page.locator('main')).toContainText('505,000');
      await tab(gm.page, 'Renewal');
      await expect(gm.page.locator('main')).toContainText('Notice deadline');
      await tab(gm.page, 'Timeline');
      await expect(gm.page.getByTestId('commercial-timeline')).toBeVisible();
    } finally {
      await manager.close();
      await gm.close();
    }
  });

  test('20, 26–28. dashboard tender and contract metrics match their lists; a guarantee alert deep-links', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { page, close } = await contextFor(browser, 'gm');
    try {
      const contract = await activeContract(page, `Guarded maintenance ${RUN}`, {
        ownerMemberId: await memberOf(page, 'George Manager'),
      });
      await send(page, 'POST', `/api/v1/contracts/${contract.id}/guarantees`, {
        type: 'PERFORMANCE_GUARANTEE',
        referenceNumber: `PG-DASH-${RUN}`,
        issuer: 'National Bank',
        issueDate: day(-5),
        expiryDate: day(7),
      });
      await createTender(page, `Dashboard tender ${RUN}`, { ownerMemberId: await memberOf(page, 'George Manager') });

      for (const [tile, url, row] of [
        ['metric-tenders-active', /\/tenders\?/, 'tender-row'],
        ['metric-contracts-active', /\/contracts\?/, 'contract-row'],
      ] as const) {
        await open(page, '/dashboards/commercial');
        await expect(page.getByTestId('commercial-dashboard')).toBeVisible();
        const value = await metricValue(page, tile);
        expect(value).toBeGreaterThan(0);
        await page.getByTestId(tile).click();
        await expect(page).toHaveURL(url);
        expect(await listedRows(page, row), `${tile} = rows of ${page.url()}`).toBe(value);
      }
      await open(page, '/dashboards/commercial');
      expect(await metricValue(page, 'metric-contracts-guarantees')).toBeGreaterThan(0);
      await expect(page.getByTestId('active-contract-value')).toContainText('EGP');

      // The executive dashboard shows the same commercial section.
      await open(page, '/dashboards/executive');
      await expect(page.getByTestId('commercial-contracts')).toBeVisible();

      const alert = page.getByTestId('attention-item').filter({ hasText: `${contract.key}: guarantee expires on` });
      await expect(async () => {
        await open(page, '/');
        const all = page.getByRole('button', { name: /^Show all \d+$/ });
        if (await all.isVisible()) await all.click();
        await expect(alert).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 45_000 });
      await expect(alert).toHaveAttribute('data-type', 'GUARANTEE_EXPIRING');
      await alert.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/contracts/${contract.id}#guarantees$`));
      await loaded(page);
      await expect(page.getByRole('tab', { name: 'Guarantees', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('guarantee').filter({ hasText: `PG-DASH-${RUN}` })).toBeVisible();
    } finally {
      await close();
    }
  });

  test('29–30. global search finds tenders, contracts and guarantee references and opens them', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm');
    const pm = await contextFor(browser, 'pm');
    try {
      const owner = await memberOf(page, 'George Manager');
      const tender = await createTender(page, `Searchable fibre tender ${RUN}`, { ownerMemberId: owner });
      const contract = await draftContract(page, `Searchable cabling contract ${RUN}`, { ownerMemberId: owner });

      await open(page, '/');
      await search(page, `Searchable fibre tender ${RUN}`);
      const tenderHit = page
        .getByTestId('search-group-tenders')
        .getByTestId('search-result')
        .filter({ hasText: tender.title });
      await expect(tenderHit).toHaveCount(1);
      await tenderHit.click();
      await expect(page).toHaveURL(new RegExp(`/tenders/${tender.id}$`));
      await loaded(page);

      await search(page, contract.key);
      const contractHit = page
        .getByTestId('search-group-contracts')
        .getByTestId('search-result')
        .filter({ hasText: contract.title });
      await expect(contractHit).toHaveCount(1);
      await contractHit.click();
      await expect(page).toHaveURL(new RegExp(`/contracts/${contract.id}$`));
      await loaded(page);
      await expect(page.getByRole('heading', { level: 1, name: contract.title })).toBeVisible();

      // A guarantee reference, searched by a prefix, opens the contract's guarantees; no amount is shown.
      const reference = `LG-SRCH-${RUN}`;
      await send(page, 'POST', `/api/v1/contracts/${contract.id}/guarantees`, {
        type: 'PERFORMANCE_GUARANTEE',
        referenceNumber: reference,
        issuer: 'Search Bank',
        amount: '91357.00',
        currency: 'EGP',
        issueDate: day(-5),
        expiryDate: day(90),
      });
      await search(page, reference.slice(0, -2));
      const guaranteeHit = page
        .getByTestId('search-group-guarantees')
        .getByTestId('search-result')
        .filter({ hasText: 'Search Bank' });
      await expect(guaranteeHit).toHaveCount(1);
      await expect(page.getByTestId('search-dialog')).not.toContainText('91,357');
      await guaranteeHit.click();
      await expect(page).toHaveURL(new RegExp(`/contracts/${contract.id}#guarantees$`));
      await loaded(page);
      await expect(page.getByTestId('guarantee').filter({ hasText: reference })).toBeVisible();
      const authorized = await get<SearchBody>(page, `/api/v1/search?q=${encodeURIComponent(reference)}`);
      expect(authorized.groups.find((group) => group.type === 'guarantees')?.items).toHaveLength(1);
      expect(JSON.stringify(authorized)).not.toMatch(/91,?357/);

      // The project manager does not see this (non-project) contract: neither the reference nor a prefix
      // of it, nor the contract by key, gives any evidence.
      for (const q of [reference, reference.slice(0, -2), contract.key]) {
        const scoped = await get<SearchBody>(pm.page, `/api/v1/search?q=${encodeURIComponent(q)}`);
        expect(
          scoped.groups.flatMap((group) => group.items).map((item) => item.id),
          q,
        ).not.toContain(contract.id);
        expect(scoped.groups.find((group) => group.type === 'guarantees')?.items ?? [], q).toEqual([]);
      }
      await open(pm.page, '/');
      await search(pm.page, reference);
      await expect(pm.page.getByTestId('search-group-guarantees').getByTestId('search-result')).toHaveCount(0);
      await expect(pm.page.getByTestId('search-dialog')).not.toContainText('Search Bank');
    } finally {
      await pm.close();
      await close();
    }
  });

  test('31–32, 34. corporate document versions, a requirement link and a restricted tender document', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const docTitle = `Commercial registration ${RUN}`;
    const gm = await contextFor(browser, 'gm');
    const employee = await contextFor(browser, 'employee');
    try {
      // 31. Created in the vault, then two versions; the newer one becomes current.
      await open(gm.page, '/documents');
      await gm.page.getByTestId('add-corporate-document').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(docTitle);
      await dialog(gm.page)
        .getByLabel(/^Document number/)
        .fill(`CR-${RUN}`);
      await dialog(gm.page).getByRole('button', { name: 'Add document' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      await gm.page
        .getByTestId('corporate-document-row')
        .filter({ hasText: docTitle })
        .getByRole('button', { name: docTitle })
        .click();
      const detail = gm.page.getByTestId('corporate-document-detail');
      await expect(detail).toContainText('No file uploaded yet');
      await detail.getByLabel(/^Expiry date/).fill(day(200));
      await uploadVersion(detail, 'registration-2025.pdf', 'Version 1 · Current');
      await uploadVersion(detail, 'registration-2026.pdf', 'Version 2 · Current');
      const versions = detail.getByTestId('corporate-versions').getByRole('listitem');
      await expect(versions).toHaveCount(2);
      await expect(versions.filter({ hasText: 'Version 1' })).not.toContainText('Current');
      await gm.page.keyboard.press('Escape');

      // 32. Linked to a tender requirement; the link records the current version.
      const owner = await memberOf(gm.page, 'George Manager');
      const tender = await createTender(gm.page, `Vault tender ${RUN}`, { ownerMemberId: owner });
      const requirement = await addRequirement(
        gm.page,
        tender.id,
        `Valid registration ${RUN}`,
        await memberOf(gm.page, 'Emad Employee'),
      );
      const documents = await get<CorporateDocumentRef[]>(
        gm.page,
        `/api/v1/corporate-documents?q=${encodeURIComponent(docTitle)}`,
      );
      const documentId = documents.find((row) => row.title === docTitle)?.id ?? '';
      expect(documentId).not.toBe('');
      await open(gm.page, `/tenders/${tender.id}#requirements`);
      const row = gm.page.getByTestId('requirement').filter({ hasText: requirement.title });
      await row.getByTestId('link-document').click();
      await dialog(gm.page)
        .getByLabel(/^Document/)
        .selectOption(documentId);
      await expect(dialog(gm.page)).toContainText('Version 2 · registration-2026.pdf');
      await dialog(gm.page).getByRole('button', { name: 'Link document' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      await expect(row.getByTestId('requirement-links')).toContainText(`${docTitle} · Version 2`);
      // Global search opens the document in the vault.
      await search(gm.page, docTitle);
      await gm.page
        .getByTestId('search-group-documents')
        .getByTestId('search-result')
        .filter({ hasText: docTitle })
        .click();
      await expect(gm.page).toHaveURL(new RegExp(`/documents\\?open=${documentId}$`));
      await expect(gm.page.getByTestId('corporate-document-detail')).toContainText(
        `${tender.key} · ${requirement.title}`,
      );
      await gm.page.keyboard.press('Escape');

      // 34. A commercially confidential tender document stays hidden from the involved employee,
      // on screen and at the download endpoint.
      await open(gm.page, `/tenders/${tender.id}#documents`);
      await gm.page.getByTestId('add-document').click();
      await dialog(gm.page)
        .getByLabel(/^Title/)
        .fill(`Price breakdown ${RUN}`);
      await dialog(gm.page)
        .getByLabel(/^Category/)
        .selectOption({ label: 'Commercial proposal' });
      await dialog(gm.page)
        .getByLabel(/^Classification/)
        .selectOption({ label: 'Commercial confidential' });
      await dialog(gm.page).getByRole('button', { name: 'Add document' }).click();
      await expect(dialog(gm.page)).toBeHidden();
      const priced = gm.page.getByTestId('commercial-document').filter({ hasText: `Price breakdown ${RUN}` });
      await uploadVersion(priced, 'price-breakdown.pdf', 'Version 1');
      const listed = await get<DocumentList>(gm.page, `/api/v1/tenders/${tender.id}/documents`);
      const pricedDocument = listed.items.find((item) => item.title === `Price breakdown ${RUN}`);
      const attachmentId = pricedDocument?.versions.find((v) => v.isCurrent)?.attachmentId ?? '';
      expect(attachmentId).not.toBe('');

      // Neither the document nor its existence: no count, no "hidden" notice, no timeline entry.
      await open(employee.page, `/tenders/${tender.id}#documents`);
      await expect(employee.page.locator('main')).not.toContainText(`Price breakdown ${RUN}`);
      await expect(employee.page.locator('main')).not.toContainText(/restricted documents? (is|are) hidden/i);
      const hidden = await get<DocumentList>(employee.page, `/api/v1/tenders/${tender.id}/documents`);
      expect(hidden).not.toHaveProperty('restrictedCount');
      expect(hidden.items.map((item) => item.id).sort()).toEqual(
        listed.items
          .filter((item) => item.classification === 'GENERAL')
          .map((item) => item.id)
          .sort(),
      );
      const isPricedEvent = (event: TimelineEvent): boolean => event.params.documentId === pricedDocument?.id;
      expect((await get<TimelineEvent[]>(gm.page, `/api/v1/tenders/${tender.id}/timeline`)).some(isPricedEvent)).toBe(
        true,
      );
      expect(
        (await get<TimelineEvent[]>(employee.page, `/api/v1/tenders/${tender.id}/timeline`)).some(isPricedEvent),
      ).toBe(false);
      expect((await employee.page.request.get(`/api/v1/attachments/${attachmentId}/download-url`)).status()).toBe(404);
      expect((await employee.page.request.get(`/api/v1/attachments/${attachmentId}`)).status()).toBe(404);
    } finally {
      await employee.close();
      await gm.close();
    }
  });

  test('33, 35–37. financial values, tenant isolation and exports follow permissions', async ({ browser }) => {
    test.setTimeout(180_000);
    const foreign = await createForeignCommercialForTest('northwind', `Northwind confidential ${RUN}`);
    const gm = await contextFor(browser, 'gm');
    const pm = await contextFor(browser, 'pm');
    try {
      const ihd = await projectId(gm.page, IHD);
      const owner = await memberOf(gm.page, 'George Manager');
      const tender = await createTender(gm.page, `Project tender ${RUN}`, { ownerMemberId: owner, projectId: ihd });
      const contract = await activeContract(gm.page, `Project contract ${RUN}`, {
        ownerMemberId: owner,
        projectId: ihd,
      });

      // 33. Project-scoped access without the financial permissions: the records, never their money.
      await open(pm.page, `/tenders/${tender.id}`);
      await expect(pm.page.getByRole('heading', { level: 1, name: tender.title })).toBeVisible();
      await expect(pm.page.getByTestId('money')).toHaveCount(0);
      await expect(pm.page.locator('main')).not.toContainText('1,250,000');
      expect((await get<TenderRef>(pm.page, `/api/v1/tenders/${tender.id}`)).estimatedValue).toBeUndefined();
      await open(pm.page, `/contracts/${contract.id}`);
      await expect(pm.page.getByRole('heading', { level: 1, name: contract.title })).toBeVisible();
      await expect(pm.page.getByTestId('money')).toHaveCount(0);
      await expect(pm.page.locator('main')).not.toContainText('480,000');
      const scoped = await get<ContractRef>(pm.page, `/api/v1/contracts/${contract.id}`);
      expect(scoped.currentValue).toBeUndefined();
      expect(scoped.originalValue).toBeUndefined();
      await open(gm.page, `/contracts/${contract.id}`);
      await expect(gm.page.locator('main')).toContainText('480,000');

      // The project's Commercial tab lists both records.
      await open(pm.page, `/projects/${ihd}#commercial`);
      await expect(pm.page.getByTestId('project-commercial')).toContainText(tender.title);
      await expect(pm.page.getByTestId('project-commercial')).toContainText(contract.title);
      await expect(pm.page.getByTestId('project-commercial')).not.toContainText('480,000');

      // 35–36. Another organization's tender and contract do not exist for this tenant.
      for (const path of [`/api/v1/tenders/${foreign.tenderId}`, `/api/v1/contracts/${foreign.contractId}`]) {
        expect((await gm.page.request.get(path)).status(), path).toBe(404);
      }
      for (const path of [
        `/api/v1/tenders/${foreign.tenderId}/requirements`,
        `/api/v1/tenders/${foreign.tenderId}/documents`,
        `/api/v1/contracts/${foreign.contractId}/obligations`,
        `/api/v1/contracts/${foreign.contractId}/guarantees`,
      ]) {
        expect((await gm.page.request.get(path)).status(), path).toBe(404);
      }
      await open(gm.page, `/tenders/${foreign.tenderId}`);
      await expect(gm.page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
      await expect(gm.page.locator('main')).not.toContainText(`Northwind confidential ${RUN}`);
      await open(gm.page, `/contracts/${foreign.contractId}`);
      await expect(gm.page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
      const found = await get<SearchBody>(
        gm.page,
        `/api/v1/search?q=${encodeURIComponent(`Northwind confidential ${RUN}`)}`,
      );
      expect(found.groups.flatMap((group) => group.items)).toEqual([]);

      // 37. Exports: money columns only for financial viewers; the value report is refused outright.
      const gmCsv = await gm.page.request.get('/api/v1/commercial/reports/contracts-active');
      expect(gmCsv.status()).toBe(200);
      const gmText = await gmCsv.text();
      expect(gmText.split(/\r?\n/)[0]).toContain('current_value');
      expect(gmText).toContain(contract.key);
      const pmCsv = await pm.page.request.get('/api/v1/commercial/reports/contracts-active');
      expect(pmCsv.status()).toBe(200);
      const pmText = await pmCsv.text();
      expect(pmText.split(/\r?\n/)[0]).not.toContain('current_value');
      expect(pmText).toContain(contract.key);
      expect(pmText).not.toContain('480000');
      expect((await pm.page.request.get('/api/v1/commercial/reports/contracts-by-value')).status()).toBe(403);
      expect((await gm.page.request.get('/api/v1/commercial/reports/contracts-by-value')).status()).toBe(200);
      await open(pm.page, '/dashboards/commercial');
      await expect(pm.page.getByTestId('report-contracts-active')).toBeVisible();
      await expect(pm.page.getByTestId('report-contracts-by-value')).toHaveCount(0);
      await expect(pm.page.getByTestId('active-contract-value')).toHaveCount(0);
      await open(gm.page, '/dashboards/commercial');
      await expect(gm.page.getByTestId('report-contracts-by-value')).toBeVisible();

      // Unauthorized roles: no commercial navigation and no commercial records.
      await asUser(browser, 'field', async (page) => {
        expect((await page.request.get(`/api/v1/tenders/${tender.id}`)).status()).toBe(404);
        expect((await page.request.get(`/api/v1/contracts/${contract.id}`)).status()).toBe(404);
        expect((await page.request.get('/api/v1/commercial/reports/contracts-active')).status()).toBe(403);
      });
    } finally {
      await pm.close();
      await gm.close();
    }
  });

  test('38–39. mobile: tender and contract screens fit a phone', async ({ browser }) => {
    test.setTimeout(180_000);
    const gm = await contextFor(browser, 'gm', PHONE);
    try {
      const owner = await memberOf(gm.page, 'George Manager');
      const tender = await createTender(gm.page, `Phone tender ${RUN}`, { ownerMemberId: owner });
      await addRequirement(gm.page, tender.id, `Phone requirement ${RUN}`, await memberOf(gm.page, 'Emad Employee'));
      const contract = await draftContract(gm.page, `Phone contract ${RUN}`, { ownerMemberId: owner });

      await open(gm.page, '/tenders');
      await expect(gm.page.getByTestId('tender-card').first()).toBeVisible();
      await expect(gm.page.getByTestId('tender-row').first()).toBeHidden();
      await expectNoHorizontalOverflow(gm.page, '/tenders at 375 px');
      await open(gm.page, `/tenders/${tender.id}`);
      await expectNoHorizontalOverflow(gm.page, 'tender at 375 px');
      for (const name of ['Requirements', 'Documents', 'Timeline']) {
        await tab(gm.page, name);
        await loaded(gm.page);
        await expectNoHorizontalOverflow(gm.page, `tender ${name} at 375 px`);
      }
      await open(gm.page, '/tenders/new');
      await expectNoHorizontalOverflow(gm.page, '/tenders/new at 375 px');

      await open(gm.page, '/contracts');
      await expect(gm.page.getByTestId('contract-card').first()).toBeVisible();
      await expect(gm.page.getByTestId('contract-row').first()).toBeHidden();
      await expectNoHorizontalOverflow(gm.page, '/contracts at 375 px');
      await open(gm.page, `/contracts/${contract.id}`);
      await expectNoHorizontalOverflow(gm.page, 'contract at 375 px');
      for (const name of ['Obligations', 'Amendments', 'Renewal', 'Guarantees']) {
        await tab(gm.page, name);
        await loaded(gm.page);
        await expectNoHorizontalOverflow(gm.page, `contract ${name} at 375 px`);
      }
      await open(gm.page, '/documents');
      await expectNoHorizontalOverflow(gm.page, '/documents at 375 px');
      await open(gm.page, '/dashboards/commercial');
      await expectNoHorizontalOverflow(gm.page, '/dashboards/commercial at 375 px');
    } finally {
      await gm.close();
    }
    const employee = await contextFor(browser, 'employee', PHONE);
    try {
      await open(employee.page, '/tenders/my-work');
      await expect(
        employee.page.getByTestId('work-item').filter({ hasText: `Phone requirement ${RUN}` }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(employee.page, '/tenders/my-work at 375 px');
    } finally {
      await employee.close();
    }
  });

  test('40. Arabic: tender and contract screens right to left', async ({ browser }) => {
    test.setTimeout(180_000);
    const { page, close } = await contextFor(browser, 'gm');
    const html = page.locator('html');
    const owner = await memberOf(page, 'George Manager');
    const tender = await createTender(page, `RTL tender ${RUN}`, { ownerMemberId: owner });
    await addRequirement(page, tender.id, `RTL requirement ${RUN}`, owner);
    const contract = await draftContract(page, `RTL contract ${RUN}`, { ownerMemberId: owner });
    await open(page, '/');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await open(page, '/tenders');
      await expect(page.getByRole('heading', { level: 1, name: ar.commercial.tenders.title })).toBeVisible();
      await expectNoHorizontalOverflow(page, '/tenders (ar)');
      await expectNoAxeViolations(page, '/tenders (ar)');
      await open(page, `/tenders/${tender.id}`);
      await expect(page.getByTestId('tender-status')).toHaveText(ar.commercial.tenderStatuses.NEW);
      await expect(page.getByTestId('money').first()).toHaveAttribute('dir', 'ltr');
      await expectNoHorizontalOverflow(page, 'tender (ar)');
      await expectNoAxeViolations(page, 'tender (ar)');
      await open(page, `/tenders/${tender.id}#requirements`);
      await expect(page.getByTestId('requirement').filter({ hasText: `RTL requirement ${RUN}` })).toBeVisible();
      await expectNoHorizontalOverflow(page, 'tender requirements (ar)');
      await expectNoAxeViolations(page, 'tender requirements (ar)');
      await page.getByTestId('add-requirement').click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page)).toHaveCSS('direction', 'rtl');
      await expectNoAxeViolations(page, 'requirement dialog (ar)');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
      await open(page, '/documents');
      await expectNoHorizontalOverflow(page, '/documents (ar)');
      await expectNoAxeViolations(page, '/documents (ar)');
      await open(page, '/contracts');
      await expect(page.getByRole('heading', { level: 1, name: ar.commercial.contracts.title })).toBeVisible();
      await open(page, `/contracts/${contract.id}`);
      await expect(page.getByTestId('contract-status')).toHaveText(ar.commercial.contractStatuses.DRAFT);
      await expectNoHorizontalOverflow(page, 'contract (ar)');
      await expectNoAxeViolations(page, 'contract (ar)');
      await open(page, `/contracts/${contract.id}#obligations`);
      await expectNoHorizontalOverflow(page, 'contract obligations (ar)');
      await expectNoAxeViolations(page, 'contract obligations (ar)');
      await open(page, '/dashboards/commercial');
      await expectNoAxeViolations(page, '/dashboards/commercial (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  for (const width of [375, 768, 1024, 1440] as const) {
    test(`41. accessibility of the commercial screens at ${String(width)} px`, async ({ browser }) => {
      test.setTimeout(360_000);
      const viewport = { width, height: 900 };
      const label = (name: string): string => `${name} at ${String(width)} px`;
      const ids = await asUser(browser, 'gm', async (page) => {
        const owner = await memberOf(page, 'George Manager');
        const tender = await createTender(page, `Axe tender ${String(width)} ${RUN}`, { ownerMemberId: owner });
        await addRequirement(
          page,
          tender.id,
          `Axe requirement ${String(width)} ${RUN}`,
          await memberOf(page, 'Emad Employee'),
        );
        const contract = await draftContract(page, `Axe contract ${String(width)} ${RUN}`, { ownerMemberId: owner });
        return { tender: tender.id, contract: contract.id };
      });
      const sessions: readonly [DemoUser, readonly string[]][] = [
        [
          'gm',
          [
            '/tenders',
            '/tenders/new',
            `/tenders/${ids.tender}`,
            `/tenders/${ids.tender}#requirements`,
            `/tenders/${ids.tender}#reviews`,
            `/tenders/${ids.tender}#submission`,
            '/contracts',
            '/contracts/new',
            `/contracts/${ids.contract}`,
            `/contracts/${ids.contract}#obligations`,
            `/contracts/${ids.contract}#milestones`,
            `/contracts/${ids.contract}#amendments`,
            '/documents',
            '/dashboards/commercial',
            '/admin/commercial',
          ],
        ],
        ['employee', ['/tenders/my-work', `/tenders/${ids.tender}#requirements`]],
      ];
      for (const [user, paths] of sessions) {
        const { page, close } = await contextFor(browser, user, { viewport });
        try {
          for (const path of paths) {
            await open(page, path);
            await expectNoHorizontalOverflow(page, label(`${user} ${path}`));
            await expectNoAxeViolations(page, label(`${user} ${path}`));
          }
          if (user === 'gm') {
            // Primary actions are on screen without scrolling sideways.
            for (const [path, action] of [
              ['/tenders', page.getByRole('link', { name: 'New tender', exact: true })],
              ['/contracts', page.getByRole('link', { name: 'New contract', exact: true })],
              ['/documents', page.getByTestId('add-corporate-document')],
            ] as const) {
              await open(page, path);
              await expect(action, label(`${path} primary action`)).toBeInViewport();
            }
            // A dialog opened from the keyboard fits the viewport, holds focus and closes with Escape.
            for (const [path, trigger] of [
              [`/contracts/${ids.contract}#guarantees`, page.getByTestId('add-guarantee')],
              [`/tenders/${ids.tender}#requirements`, page.getByTestId('add-requirement')],
            ] as const) {
              await open(page, path);
              await trigger.focus();
              await page.keyboard.press('Enter');
              await expect(dialog(page)).toBeVisible();
              const box = await dialog(page).boundingBox();
              expect(box, label(`${path} dialog box`)).not.toBeNull();
              expect(box?.x ?? -1, label(`${path} dialog left edge`)).toBeGreaterThanOrEqual(0);
              expect((box?.x ?? 0) + (box?.width ?? width + 1), label(`${path} dialog right edge`)).toBeLessThanOrEqual(
                width,
              );
              expect(
                await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
                label(`${path} dialog focus`),
              ).toBe(true);
              await expectNoAxeViolations(page, label(`${path} dialog`));
              await page.keyboard.press('Escape');
              await expect(dialog(page)).toBeHidden();
            }
          }
        } finally {
          await close();
        }
      }
    });
  }
});
