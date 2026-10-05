import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken, stepUp } from '../support/auth.js';
import type { DemoUser } from '../support/auth.js';
import { backdateShiftAssignmentForTest, setManagerForTest } from '../support/baseline.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  attendance: { title: string; teamTitle: string; checkInAction: string };
  errors: { ATTENDANCE_OUTSIDE_GEOFENCE: string };
};

const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const ZONE = 'Africa/Cairo';

/** Cairo HQ (seeded OFFICE, radius 200 m) and points relative to it. Coordinates never appear in the UI. */
const INSIDE_HQ = { latitude: 30.045, longitude: 31.236, accuracy: 15 };
const LOW_ACCURACY_AT_HQ = { latitude: 30.045, longitude: 31.236, accuracy: 500 };
const FAR_FROM_EVERY_SITE = { latitude: 30.3, longitude: 31.7, accuracy: 10 };

/**
 * Phase 7 attendance (ADR-0022) through the real browser, with the browser's geolocation mocked by
 * Playwright. Evidence is append-only, so every flow that records a check-in uses its own demo user
 * (one work day per user and run): Emad Employee (`employee`) inside the office, Fatma Field (`field`)
 * with low accuracy, Sara Support (`support`) late/early and a correction, Hana Resources (`hr`) on
 * approved remote work, Paul Planner (`pm`) on a business mission, Olivia Admin (`org.admin`) on approved
 * leave and George Manager (`gm`) on a phone. Mina Manager (`manager`) only ever gets refused, so her
 * flows record nothing. Shifts that depend on the time of day are created around the current Cairo time.
 */

interface Today {
  readonly workDate: string;
  readonly plannedMode: string | null;
  readonly nextAction: string;
  readonly record: { readonly id: string } | null;
}

interface RecordView {
  readonly id: string;
  readonly workDate: string;
  readonly status: string;
  readonly mode: string | null;
  readonly lateMinutes: number;
  readonly earlyLeaveMinutes: number;
  readonly adjusted: boolean;
  readonly needsReview: boolean;
  readonly version: number;
}

interface EventView {
  readonly id: string;
  readonly kind: string;
  readonly recordedAt: string;
  readonly geofenceResult: string | null;
  readonly reviewStatus: string;
}

interface Detail {
  readonly record: RecordView;
  readonly events: readonly EventView[];
}

interface CorrectionView {
  readonly status: string;
  readonly request: { readonly id: string; readonly number: number };
}

type Point = typeof INSIDE_HQ;

const located = (point: Point): BrowserContextOptions => ({ geolocation: point, permissions: ['geolocation'] });

async function writeHeaders(page: Page): Promise<Record<string, string>> {
  return { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' };
}

async function send<T>(page: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown): Promise<T> {
  const response = await page.request.fetch(path, { method, headers: await writeHeaders(page), data });
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

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Minutes since local midnight in Cairo, from the same clock the server uses. */
function cairoMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date())
    .split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

const hhmm = (minutes: number): string => {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/** A shift that started up to an hour ago today (never before midnight) and ends two hours from now. */
function windowAroundNow(): { start: number; end: number } {
  const now = cairoMinutes();
  return { start: Math.max(0, now - 60), end: now + 120 };
}

async function today(page: Page): Promise<Today> {
  return getData<Today>(page, '/api/v1/attendance/today');
}

async function profileIdOf(page: Page, name: string): Promise<string> {
  const people = await getData<{ id: string; fullName: string }[]>(
    page,
    `/api/v1/employees?q=${encodeURIComponent(name)}`,
  );
  const id = people.find((person) => person.fullName === name)?.id;
  expect(id, `employee ${name}`).toBeDefined();
  return id ?? '';
}

async function seededTypeId(page: Page, key: string): Promise<string> {
  const catalog = await getData<{ id: string; key: string }[]>(page, '/api/v1/request-types');
  const id = catalog.find((type) => type.key === key)?.id;
  expect(id, `request type ${key}`).toBeDefined();
  return id ?? '';
}

async function submitRequest(
  page: Page,
  key: string,
  formData: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const response = await page.request.post('/api/v1/requests', {
    headers: { ...(await writeHeaders(page)), 'Idempotency-Key': randomUUID() },
    data: { requestTypeId: await seededTypeId(page, key), formData, submit: true },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: { id: string; key: string } }).data;
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

/** The approved request reaches attendance through the outbox and the worker (asynchronous). */
async function waitForPlannedMode(page: Page, mode: string): Promise<void> {
  await expect.poll(async () => (await today(page)).plannedMode, { timeout: 45_000 }).toBe(mode);
}

async function myRecordOn(page: Page, date: string): Promise<RecordView> {
  const records = await getData<RecordView[]>(page, `/api/v1/attendance/me/records?from=${date}&to=${date}`);
  const record = records.find((row) => row.workDate === date);
  expect(record, `record on ${date}`).toBeDefined();
  if (record === undefined) throw new Error(`No record on ${date}.`);
  return record;
}

async function openToday(page: Page): Promise<void> {
  await page.goto('/attendance');
  await settled(page);
  await expect(page.getByTestId('attendance-today')).toBeVisible();
}

/**
 * Gives an employee a shift around the current time through the configuration API (as Hana, who holds
 * `attendance.config`): the seeded day-shift assignment ends yesterday and the new shift applies from today.
 */
async function shiftAroundNowViaApi(browser: Browser, employeeNumber: string, fullName: string): Promise<string> {
  await backdateShiftAssignmentForTest('demo', employeeNumber, 2);
  const window = windowAroundNow();
  const name = `E2E ${fullName} ${RUN}`;
  await asUser(browser, 'hr', async (page) => {
    const workDate = (await today(page)).workDate;
    const profileId = await profileIdOf(page, fullName);
    const shift = await send<{ id: string }>(page, 'POST', '/api/v1/attendance/shifts', {
      name,
      start: hhmm(window.start),
      end: hhmm(window.end),
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 0,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    });
    const current = await getData<{ id: string; version: number }[]>(
      page,
      `/api/v1/attendance/shift-assignments?profileId=${profileId}&activeOn=${workDate}`,
    );
    for (const assignment of current) {
      await send(page, 'POST', `/api/v1/attendance/shift-assignments/${assignment.id}/end`, {
        effectiveTo: addDays(workDate, -1),
        version: assignment.version,
      });
    }
    await send(page, 'POST', '/api/v1/attendance/shift-assignments', {
      profileId,
      shiftId: shift.id,
      effectiveFrom: workDate,
    });
  });
  return name;
}

test.describe('Phase 7 attendance', () => {
  test('1–5. an employee opens Today, shares the location, checks in once (double click), and checks out', async ({
    browser,
  }) => {
    const shiftName = await shiftAroundNowViaApi(browser, 'EMP-00004', 'Emad Employee');
    const { page, close } = await contextFor(browser, 'employee', located(INSIDE_HQ));
    // 1. Today through the navigation.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Attendance', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Attendance' })).toBeVisible();
    const card = page.getByTestId('attendance-today');
    await expect(card).toHaveAttribute('data-next-action', 'CHECK_IN');
    await expect(page.getByTestId('attendance-shift')).toContainText(shiftName);
    await expect(card).toContainText('It is not tracked in the background.');

    // 2–4. Permission granted: the location is read once per tap; a double click records one check-in.
    const action = page.getByTestId('attendance-action');
    await expect(action).toHaveText('Check in');
    await action.dblclick();
    await expect(page.getByTestId('attendance-notice')).toContainText('Checked in at');
    await expect(card).toHaveAttribute('data-next-action', 'CHECK_OUT');
    await expect(page.getByTestId('attendance-check-in-time')).toContainText('Cairo HQ');
    const workDate = (await today(page)).workDate;
    const record = await myRecordOn(page, workDate);
    const detail = await getData<Detail>(page, `/api/v1/attendance/records/${record.id}`);
    expect(detail.events.filter((event) => event.kind === 'CHECK_IN')).toHaveLength(1);
    expect(detail.events[0]?.geofenceResult).toBe('INSIDE');

    // 5. Check out.
    await expect(action).toHaveText('Check out');
    await action.click();
    await expect(page.getByTestId('attendance-notice')).toContainText('Checked out at');
    await expect(card).toHaveAttribute('data-next-action', 'NONE');
    await expect(page.getByTestId('attendance-done')).toHaveText('Your work day is complete.');
    await expect(card.getByTestId('attendance-status').first()).toHaveAttribute('data-status', 'COMPLETE');
    const after = await getData<Detail>(page, `/api/v1/attendance/records/${record.id}`);
    expect(after.events.map((event) => event.kind)).toEqual(['CHECK_IN', 'CHECK_OUT']);
    await expectNoAxeViolations(page, 'attendance today after check-out');
    await close();
  });

  test('2b. location permission denied: a clear message, and continuing without a location is refused by policy', async ({
    browser,
  }) => {
    // Mina Manager without a geolocation grant: the browser denies the request.
    const { page, close } = await contextFor(browser, 'manager');
    await openToday(page);
    await page.getByTestId('attendance-action').click();
    const problem = page.getByTestId('attendance-location-problem');
    await expect(problem).toHaveAttribute('data-problem', 'PERMISSION_DENIED');
    await expect(problem).toContainText('Location access is blocked.');
    await expectNoAxeViolations(page, 'permission denied message');
    await problem.getByRole('button', { name: 'Continue without location' }).click();
    // The seeded policy refuses check-ins without a location (REJECT); nothing is recorded.
    await expect(page.getByText('A location is required to record attendance.')).toBeVisible();
    await expect(page.getByTestId('attendance-today')).toHaveAttribute('data-next-action', 'CHECK_IN');
    expect((await today(page)).record).toBeNull();
    await close();
  });

  test('6. a check-in outside every work location is rejected and nothing is recorded', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager', located(FAR_FROM_EVERY_SITE));
    await openToday(page);
    await page.getByTestId('attendance-action').click();
    await expect(page.getByText('You are outside the allowed area of your work locations.')).toBeVisible();
    // A 422 refusal is final for this attempt: no "safe to retry" hint, no notice, no record.
    await expect(page.getByText('It is safe to try again')).toHaveCount(0);
    await expect(page.getByTestId('attendance-notice')).toHaveCount(0);
    await expect(page.getByTestId('attendance-today')).toHaveAttribute('data-next-action', 'CHECK_IN');
    expect((await today(page)).record).toBeNull();
    // The client never decides: the same far-away point through the API is refused by the server too.
    const forged = await page.request.post('/api/v1/attendance/check-in', {
      headers: { ...(await writeHeaders(page)), 'Idempotency-Key': randomUUID() },
      data: { location: { status: 'OK', ...FAR_FROM_EVERY_SITE } },
    });
    expect(forged.status()).toBe(422);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('ATTENDANCE_OUTSIDE_GEOFENCE');
    await close();
  });

  test('7. low accuracy warns first, then (policy: flag for review) records the check-in for a reviewer', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'field', located(LOW_ACCURACY_AT_HQ));
    await openToday(page);
    await page.getByTestId('attendance-action').click();
    const warning = page.getByTestId('attendance-low-accuracy');
    await expect(warning).toContainText('Your location accuracy is about 500 m; the allowed maximum is 100 m.');
    // "Try again" reads the location once more (same accuracy) without sending anything.
    await warning.getByRole('button', { name: 'Try again' }).click();
    await expect(warning).toBeVisible();
    expect((await today(page)).record).toBeNull();
    // Sending the reading is described as a server-side policy check, never as a bypass.
    await expect(warning).toContainText('The server still applies your organization');
    await expect(warning).toContainText('never counts as inside a work location');
    const send = warning.getByRole('button', { name: 'Send this reading' });
    await expect(send).toHaveAccessibleDescription(/server still applies/);
    await send.click();
    await expect(page.getByTestId('attendance-notice')).toContainText('It will be reviewed');
    await expect(page.getByTestId('attendance-today')).toContainText('Needs review');
    const record = await myRecordOn(page, (await today(page)).workDate);
    expect(record.needsReview).toBe(true);
    await close();

    // An HR administrator accepts it from the review queue (the employee cannot review their own).
    const hr = await contextFor(browser, 'hr');
    await hr.page.goto('/attendance/team');
    await settled(hr.page);
    await hr.page.getByRole('tab', { name: 'Review queue' }).click();
    const item = hr.page.getByTestId('attendance-review-item').filter({ hasText: 'Fatma Field' });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Low accuracy');
    await item.getByRole('button', { name: 'Accept' }).click();
    await expect(item).toHaveCount(0);
    const reviewed = await getData<Detail>(hr.page, `/api/v1/attendance/records/${record.id}`);
    expect(reviewed.events[0]?.reviewStatus).toBe('ACCEPTED');
    expect(reviewed.record.needsReview).toBe(false);
    await hr.close();
  });

  test('8. an approved leave day shows the leave and offers no check-in', async ({ browser }) => {
    const request = await asUser(browser, 'org.admin', async (page) => {
      const workDate = (await today(page)).workDate;
      return submitRequest(page, 'leave', {
        leaveType: 'annual',
        dates: { start: workDate, end: workDate },
        reason: `E2E leave ${RUN}`,
      });
    });
    await asUser(browser, 'gm', (page) => approveViaApi(page, request.id));
    const { page, close } = await contextFor(browser, 'org.admin', located(INSIDE_HQ));
    await waitForPlannedMode(page, 'LEAVE');
    await openToday(page);
    const card = page.getByTestId('attendance-today');
    await expect(card).toHaveAttribute('data-next-action', 'NONE');
    await expect(card.getByRole('link', { name: 'Approved leave' })).toHaveAttribute('href', `/requests/${request.id}`);
    await expect(page.getByTestId('attendance-action')).toHaveCount(0);
    await expect(page.getByTestId('attendance-done')).toHaveText('Nothing to record right now.');
    const forced = await page.request.post('/api/v1/attendance/check-in', {
      headers: { ...(await writeHeaders(page)), 'Idempotency-Key': randomUUID() },
      data: { location: { status: 'OK', ...INSIDE_HQ } },
    });
    expect(forced.status()).toBe(409);
    expect(((await forced.json()) as { error: { code: string } }).error.code).toBe('ATTENDANCE_ON_LEAVE');
    await close();
  });

  test('9. an approved remote-work day checks in without asking for a location', async ({ browser }) => {
    const request = await asUser(browser, 'hr', async (page) => {
      const workDate = (await today(page)).workDate;
      return submitRequest(page, 'work_from_home', {
        dates: { start: workDate, end: workDate },
        reason: `E2E remote ${RUN}`,
      });
    });
    await asUser(browser, 'gm', (page) => approveViaApi(page, request.id));
    // No geolocation permission: if the page asked for a position it would be denied.
    const { page, close } = await contextFor(browser, 'hr');
    await waitForPlannedMode(page, 'REMOTE');
    await openToday(page);
    const card = page.getByTestId('attendance-today');
    await expect(card).toContainText('Remote');
    await expect(card.getByRole('link', { name: 'Approved remote work' })).toBeVisible();
    await expect(card).toContainText('No location is needed today.');
    await page.getByTestId('attendance-action').click();
    await expect(page.getByTestId('attendance-notice')).toContainText('Checked in at');
    await expect(page.getByTestId('attendance-location-problem')).toHaveCount(0);
    const record = await myRecordOn(page, (await today(page)).workDate);
    expect(record.mode).toBe('REMOTE');
    const detail = await getData<Detail>(page, `/api/v1/attendance/records/${record.id}`);
    expect(detail.events.find((event) => event.kind === 'CHECK_IN')?.geofenceResult).toBe('NOT_REQUIRED');
    await close();
  });

  test('10. an approved business-mission day checks in without a location and shows the mission', async ({
    browser,
  }) => {
    // Paul Planner reports to George for this test, so the manager step routes to a demo login.
    const previous = await setManagerForTest('demo', 'EMP-00041', 'EMP-00002');
    try {
      const request = await asUser(browser, 'pm', async (page) => {
        const workDate = (await today(page)).workDate;
        return submitRequest(page, 'business_mission', {
          destination: 'Client office, New Cairo',
          dates: { start: workDate, end: workDate },
          purpose: `E2E mission ${RUN}`,
        });
      });
      await asUser(browser, 'gm', (page) => approveViaApi(page, request.id));
      const { page, close } = await contextFor(browser, 'pm');
      await waitForPlannedMode(page, 'BUSINESS_MISSION');
      await openToday(page);
      const card = page.getByTestId('attendance-today');
      await expect(card.getByRole('link', { name: 'Approved business mission' })).toBeVisible();
      await page.getByTestId('attendance-action').click();
      await expect(page.getByTestId('attendance-notice')).toContainText('Checked in at');
      const record = await myRecordOn(page, (await today(page)).workDate);
      expect(record.mode).toBe('BUSINESS_MISSION');
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByTestId('attendance-record').filter({ hasText: 'Business mission' })).toHaveCount(1);
      await close();
    } finally {
      await setManagerForTest('demo', 'EMP-00041', previous);
    }
  });

  test('11–12, 16–19. HR schedules a shift; late arrival and early leave show; a correction is approved and keeps the original evidence', async ({
    browser,
  }) => {
    const window = windowAroundNow();
    const expectLate = cairoMinutes() - window.start >= 1;
    const shiftName = `E2E late ${RUN}`;
    await backdateShiftAssignmentForTest('demo', 'EMP-00040', 2);
    // Sara reports to Mina for this test, so the correction's manager step routes to a demo login.
    const previous = await setManagerForTest('demo', 'EMP-00040', 'EMP-00032');
    try {
      // 16. HR configures the shift and moves Sara onto it from today (admin screens).
      const hr = await contextFor(browser, 'hr');
      await hr.page.goto('/admin/attendance');
      await settled(hr.page);
      await expect(hr.page.getByTestId('attendance-policy')).toContainText(
        'Only administrators with organization settings permission can change this policy.',
      );
      await hr.page.getByTestId('attendance-shifts').getByRole('button', { name: 'New shift' }).click();
      const shiftDialog = hr.page.getByRole('dialog', { name: 'New shift' });
      await shiftDialog.getByLabel('Name').fill(shiftName);
      await shiftDialog.getByLabel('Start').fill(hhmm(window.start));
      await shiftDialog.getByLabel('End', { exact: true }).fill(hhmm(window.end));
      await shiftDialog.getByLabel('Late grace (minutes)').fill('0');
      await shiftDialog.getByLabel('Early-leave grace (minutes)').fill('0');
      for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
        await shiftDialog.getByLabel(day, { exact: true }).check();
      }
      await expectNoAxeViolations(hr.page, 'new shift dialog');
      await shiftDialog.getByRole('button', { name: 'Save' }).click();
      await expect(shiftDialog).toBeHidden();
      await expect(
        hr.page.getByTestId('attendance-shift').and(hr.page.locator(`[data-name="${shiftName}"]`)),
      ).toContainText(`${hhmm(window.start)}–${hhmm(window.end)}`);

      const workDate = (await today(hr.page)).workDate;
      const assignments = hr.page.getByTestId('attendance-assignments');
      await assignments.getByLabel('Shift', { exact: true }).selectOption({ label: 'Day shift' });
      const current = assignments
        .getByTestId('attendance-assignment')
        .filter({ hasText: 'Sara Support' })
        .filter({ has: hr.page.getByRole('button', { name: /^End/ }) });
      const loadMore = assignments.getByRole('button', { name: 'Load more' });
      await expect(async () => {
        if (await loadMore.isVisible()) await loadMore.click();
        await expect(current).toHaveCount(1, { timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      await current.getByRole('button', { name: /^End/ }).click();
      const endDialog = hr.page.getByRole('dialog', { name: 'End the shift assignment of Sara Support' });
      await endDialog.getByLabel('Last day').fill(addDays(workDate, -1));
      await endDialog.getByRole('button', { name: 'End', exact: true }).click();
      await expect(endDialog).toBeHidden();

      await assignments.getByRole('button', { name: 'Assign shift' }).click();
      const assignDialog = hr.page.getByRole('dialog', { name: 'Assign shift' });
      const picker = assignDialog.getByRole('group', { name: 'Employee' });
      await picker.getByRole('searchbox').fill('Sara Support');
      await picker.getByRole('radio', { name: /Sara Support/ }).check();
      await assignDialog.getByLabel('Shift', { exact: true }).selectOption({ label: shiftName });
      await expect(assignDialog.getByLabel('Starts on')).toHaveValue(workDate);
      await expectNoAxeViolations(hr.page, 'assign shift dialog');
      await assignDialog.getByRole('button', { name: 'Assign shift' }).click();
      await expect(assignDialog).toBeHidden();
      await hr.close();

      // 11–12. Sara checks in after the shift start and out before its end.
      const sara = await contextFor(browser, 'support', located(INSIDE_HQ));
      await openToday(sara.page);
      const card = sara.page.getByTestId('attendance-today');
      await expect(sara.page.getByTestId('attendance-shift')).toContainText(shiftName);
      await sara.page.getByTestId('attendance-action').click();
      await expect(sara.page.getByTestId('attendance-notice')).toContainText('Checked in at');
      if (expectLate) await expect(card).toContainText(/Late \d+ min/);
      await sara.page.getByTestId('attendance-action').click();
      await expect(sara.page.getByTestId('attendance-notice')).toContainText('Checked out at');
      await expect(card).toContainText(/Left \d+ min early/);
      const original = await myRecordOn(sara.page, workDate);
      expect(original.earlyLeaveMinutes).toBeGreaterThan(0);
      if (expectLate) expect(original.lateMinutes).toBeGreaterThan(0);
      const originalEvents = (await getData<Detail>(sara.page, `/api/v1/attendance/records/${original.id}`)).events;

      // 17. Sara asks for her check-in to be corrected to the shift start.
      await sara.page.getByTestId('attendance-request-correction').click();
      const dialog = sara.page.getByRole('dialog', { name: 'Request a correction' });
      await expect(dialog.getByLabel('Work date')).toHaveValue(workDate);
      await dialog.getByLabel('Reason').selectOption({ label: 'Incorrect time' });
      await dialog.getByLabel(/^Corrected check-in/).fill(hhmm(window.start));
      await dialog.getByLabel('Details').fill(`The badge reader was down at the entrance (${RUN}).`);
      await expectNoAxeViolations(sara.page, 'correction dialog');
      await dialog.getByRole('button', { name: 'Submit for approval' }).click();
      await expect(dialog).toBeHidden();
      await expect(sara.page.getByText(/^Correction request #\d+ submitted for approval\.$/)).toBeVisible();
      await sara.page.getByRole('tab', { name: 'Corrections' }).click();
      await expect(sara.page.getByTestId('attendance-correction').first()).toHaveAttribute('data-status', 'PENDING');
      const correction = (await getData<CorrectionView[]>(sara.page, '/api/v1/attendance/corrections'))[0];
      expect(correction?.status).toBe('PENDING');
      const requestKey = (await getData<{ key: string }>(sara.page, `/api/v1/requests/${correction?.request.id ?? ''}`))
        .key;

      // 18. Mina approves it in her approvals inbox.
      const mina = await contextFor(browser, 'manager');
      await mina.page.goto('/approvals');
      await settled(mina.page);
      await mina.page
        .getByTestId('approval-item')
        .filter({ hasText: requestKey })
        .getByRole('button', { name: /^Approve/ })
        .click();
      const approve = mina.page.getByRole('dialog', { name: `Approve · ${requestKey}` });
      await approve.getByRole('textbox').fill('Confirmed with building security.');
      await approve.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(approve).toBeHidden();
      await mina.close();

      // 19. Applied as a new entry: the original check-in and check-out stay exactly as recorded.
      await expect
        .poll(async () => (await getData<CorrectionView[]>(sara.page, '/api/v1/attendance/corrections'))[0]?.status, {
          timeout: 45_000,
        })
        .toBe('APPLIED');
      const corrected = await getData<Detail>(sara.page, `/api/v1/attendance/records/${original.id}`);
      expect(corrected.record.adjusted).toBe(true);
      expect(corrected.record.lateMinutes).toBe(0);
      for (const event of originalEvents) {
        expect(corrected.events.find((row) => row.id === event.id)).toEqual(event);
      }
      expect(corrected.events.map((event) => event.kind)).toEqual(['CHECK_IN', 'CHECK_OUT', 'ADJUSTED']);
      await sara.page.goto(`/attendance/records/${original.id}`);
      await settled(sara.page);
      await expect(sara.page.getByTestId('attendance-record-summary')).toContainText('Adjusted');
      const events = sara.page.getByTestId('attendance-event');
      await expect(events).toHaveCount(3);
      await expect(events.and(sara.page.locator('[data-kind="ADJUSTED"]'))).toContainText('Incorrect time');
      await expect(events.and(sara.page.locator('[data-kind="ADJUSTED"]'))).toContainText('Set to: in');
      await expect(events.and(sara.page.locator('[data-kind="CHECK_IN"]'))).toContainText('Inside work location');
      await sara.page.goto('/attendance');
      await settled(sara.page);
      await sara.page.getByRole('tab', { name: 'Corrections' }).click();
      await expect(sara.page.getByTestId('attendance-correction').first()).toHaveAttribute('data-status', 'APPLIED');
      await sara.close();
    } finally {
      await setManagerForTest('demo', 'EMP-00040', previous);
    }
  });

  test('13. the employee history lists past days with a detail page that never shows coordinates', async ({
    browser,
  }) => {
    // Order-independent: a day corrected by HR gives Emad a history entry whether or not flow 1–5 ran.
    const pastDay = await asUser(browser, 'hr', async (page) => {
      await stepUp(page, 'hr');
      const day = addDays((await today(page)).workDate, -3);
      const profileId = await profileIdOf(page, 'Emad Employee');
      const existing = await getData<RecordView[]>(
        page,
        `/api/v1/attendance/records?profileId=${profileId}&from=${day}&to=${day}`,
      );
      if (existing.length === 0) {
        await send(page, 'POST', '/api/v1/attendance/admin/corrections', {
          profileId,
          workDate: day,
          reasonCode: 'FORGOT_CHECK_IN',
          checkIn: '09:00',
          checkOut: '17:00',
          note: `Paper sign-in sheet (${RUN}).`,
          version: null,
        });
      }
      return day;
    });
    const { page, close } = await contextFor(browser, 'employee');
    await openToday(page);
    await page.getByRole('tab', { name: 'History' }).click();
    const row = page.getByTestId('attendance-record').and(page.locator(`[data-date="${pastDay}"]`));
    await expect(row).toContainText('Complete');
    await expect(row).toContainText('Adjusted');
    await row.getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^Emad Employee · / })).toBeVisible();
    await expect(page.getByTestId('attendance-event').and(page.locator('[data-kind="ADJUSTED"]'))).toContainText(
      'Forgot to check in',
    );
    await expect(page.getByText('Coordinates are never shown.')).toBeVisible();
    const body = (await page.locator('main').textContent()) ?? '';
    expect(body).not.toMatch(/\b30\.04\d*|\b31\.23\d*/);
    // The device line (IP, user agent) is for attendance administrators only.
    await expect(page.getByText(/^Device:/)).toHaveCount(0);
    await close();
  });

  test('14–15. a manager sees their team only; other employees and other scopes are denied', async ({ browser }) => {
    const previous = {
      employee: await setManagerForTest('demo', 'EMP-00004', 'EMP-00032'),
      support: await setManagerForTest('demo', 'EMP-00040', 'EMP-00032'),
    };
    try {
      // A record outside Mina's team (Paul Planner, corrected by HR) to probe with.
      const outside = await asUser(browser, 'hr', async (page) => {
        await stepUp(page, 'hr');
        const day = addDays((await today(page)).workDate, -2);
        const profileId = await profileIdOf(page, 'Paul Planner');
        const existing = await getData<RecordView[]>(
          page,
          `/api/v1/attendance/records?profileId=${profileId}&from=${day}&to=${day}`,
        );
        if (existing[0] !== undefined) return existing[0].id;
        const created = await send<Detail>(page, 'POST', '/api/v1/attendance/admin/corrections', {
          profileId,
          workDate: day,
          reasonCode: 'SYSTEM_ISSUE',
          checkIn: '09:00',
          checkOut: '17:00',
          note: `Outage on the attendance page (${RUN}).`,
          version: null,
        });
        return created.record.id;
      });

      // 14. Mina's team view: her two reports, no one else, and no payroll data.
      const mina = await contextFor(browser, 'manager');
      await mina.page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Team attendance' })
        .click();
      await expect(mina.page.getByRole('heading', { level: 1, name: 'Team attendance' })).toBeVisible();
      await expect(mina.page.locator('[aria-busy="true"]')).toHaveCount(0);
      const rows = mina.page.getByTestId('team-day-row');
      await expect(rows.filter({ hasText: 'Emad Employee' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'Sara Support' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'Fatma Field' })).toHaveCount(0);
      await expect(rows.filter({ hasText: 'Paul Planner' })).toHaveCount(0);
      await expect(mina.page.getByRole('main')).not.toContainText(/salary|payroll|wage/i);
      // Not an attendance administrator: no direct corrections.
      await expect(mina.page.getByTestId('attendance-admin-correct')).toHaveCount(0);
      await mina.page.getByRole('tab', { name: 'Records' }).click();
      await expect(mina.page.getByRole('search', { name: 'Attendance filters' })).toBeVisible();
      await expectNoAxeViolations(mina.page, 'team attendance (manager)');

      // 15. Outside her scope: not found, in the UI and the API.
      expect((await mina.page.request.get(`/api/v1/attendance/records/${outside}`)).status()).toBe(404);
      await mina.page.goto(`/attendance/records/${outside}`);
      await expect(mina.page.getByRole('heading', { name: 'Not found' })).toBeVisible();
      const scoped = await getData<RecordView[]>(
        mina.page,
        `/api/v1/attendance/records?profileId=${await profileIdOf(mina.page, 'Paul Planner')}`,
      );
      expect(scoped).toHaveLength(0);
      await mina.close();

      // An employee has no team view at all.
      const emad = await contextFor(browser, 'employee');
      await expect(
        emad.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Team attendance' }),
      ).toHaveCount(0);
      await emad.page.goto('/attendance/team');
      await expect(emad.page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
      expect((await emad.page.request.get('/api/v1/attendance/team/day')).status()).toBe(403);
      expect((await emad.page.request.get(`/api/v1/attendance/records/${outside}`)).status()).toBe(404);
      await emad.page.goto('/admin/attendance');
      await expect(emad.page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
      await emad.close();
    } finally {
      await setManagerForTest('demo', 'EMP-00004', previous.employee);
      await setManagerForTest('demo', 'EMP-00040', previous.support);
    }
  });

  test('16. HR: organization-wide day view, a direct correction with fresh MFA, and a bounded CSV export', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'hr');
    await stepUp(page, 'hr');
    const workDate = (await today(page)).workDate;
    const day = addDays(workDate, -1);
    await page.goto('/attendance/team');
    await settled(page);
    await page.getByLabel('Date').fill(day);
    await page.locator('#team-day-department').selectOption({ label: 'Field Operations' });
    const row = page.getByTestId('team-day-row').filter({ hasText: 'Heba Lotfy' });
    await expect(row).toHaveCount(1);
    if ((await row.getAttribute('data-status')) !== 'COMPLETE') {
      await row.getByTestId('attendance-admin-correct').click();
      const dialog = page.getByRole('dialog', { name: 'Correct attendance for Heba Lotfy' });
      await expect(dialog).toContainText('needs a recent MFA confirmation');
      await dialog.getByLabel('Reason').selectOption({ label: 'Forgot to check in' });
      await dialog.getByLabel(/^Corrected check-in/).fill('08:30');
      await dialog.getByLabel(/^Corrected check-out/).fill('16:30');
      await dialog.getByLabel('Note').fill(`Site visit confirmed by the supervisor (${RUN}).`);
      await expectNoAxeViolations(page, 'admin correction dialog');
      await dialog.getByRole('button', { name: 'Apply correction' }).click();
      await expect(dialog).toBeHidden();
    }
    await expect(row).toHaveAttribute('data-status', 'COMPLETE');
    await row.getByRole('link', { name: /^Open/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Heba Lotfy · / })).toBeVisible();
    const adjusted = page.getByTestId('attendance-event').and(page.locator('[data-kind="ADJUSTED"]'));
    await expect(adjusted).toContainText('Forgot to check in');
    await expect(adjusted).toContainText('by Hana Resources');

    // Records with a range of at most 62 days can be exported (CSV without coordinates).
    await page.goto('/attendance/team');
    await settled(page);
    await page.getByRole('tab', { name: 'Records' }).click();
    await page.getByLabel('From').fill(addDays(workDate, -80));
    await page.getByLabel('To').fill(workDate);
    await expect(page.getByTestId('attendance-export')).toHaveCount(0);
    await expect(page.getByText('Choose a date range of up to 62 days to export.')).toBeVisible();
    await page.getByLabel('From').fill(addDays(workDate, -7));
    const link = page.getByTestId('attendance-export');
    await expect(link).toBeVisible();
    const csv = await page.request.get((await link.getAttribute('href')) ?? '');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const text = await csv.text();
    expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'employee_number,employee,department,work_date,status,mode,shift,scheduled_start,scheduled_end,check_in,check_out,check_in_location,late_minutes,early_leave_minutes,worked_minutes,needs_review,adjusted',
    );
    expect(text).toContain('Heba Lotfy');
    expect(text).not.toMatch(/latitude|longitude/i);
    const tooLong = await page.request.get(`/api/v1/attendance/export?from=${addDays(workDate, -80)}&to=${workDate}`);
    expect(tooLong.status()).toBe(400);
    await close();
  });

  test('16b. configuration: the policy is saved with fresh MFA; shifts and assignments are listed', async ({
    browser,
  }) => {
    const { page, close } = await contextFor(browser, 'org.admin');
    await stepUp(page, 'org.admin');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Attendance config' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Attendance configuration' })).toBeVisible();
    const policy = page.getByTestId('attendance-policy');
    await expect(policy.getByLabel(/^Maximum accuracy/)).toHaveValue('100');
    await policy.getByRole('button', { name: 'Save' }).click();
    await expect(policy.getByText('Policy saved.')).toBeVisible();
    await expect(page.getByTestId('attendance-shift').and(page.locator('[data-name="Night shift"]'))).toContainText(
      'Overnight',
    );
    await expect(page.getByTestId('attendance-assignment').first()).toBeVisible();
    await close();
  });

  test('20. mobile: an employee checks in at 375 px with a large action and card lists', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'gm', {
      viewport: { width: 375, height: 812 },
      hasTouch: true,
      ...located(INSIDE_HQ),
    });
    const bottomNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await bottomNav.getByRole('link', { name: 'Attendance', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Attendance' })).toBeVisible();
    const action = page.getByTestId('attendance-action');
    const box = await action.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    expect(box?.width ?? 0).toBeGreaterThan(250);
    await expectNoHorizontalOverflow(page, 'attendance today at 375 px');
    await expectNoAxeViolations(page, 'attendance today at 375 px');
    await action.tap();
    await expect(page.getByTestId('attendance-notice')).toContainText('Checked in at');
    await expect(page.getByTestId('attendance-today')).toHaveAttribute('data-next-action', 'CHECK_OUT');
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByTestId('attendance-record-card').first()).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expectNoHorizontalOverflow(page, 'attendance history at 375 px');
    await page.goto('/attendance/team');
    await settled(page);
    await expect(page.getByTestId('team-day-card').first()).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expectNoHorizontalOverflow(page, 'team attendance at 375 px');
    await expectNoAxeViolations(page, 'team attendance at 375 px');
    await close();
  });

  test('21. RTL: the attendance screens render right-to-left in Arabic, including a refusal', async ({ browser }) => {
    const { page, close } = await contextFor(browser, 'manager', located(FAR_FROM_EVERY_SITE));
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto('/attendance');
      await expect(page.getByRole('heading', { level: 1, name: ar.attendance.title })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      const action = page.getByTestId('attendance-action');
      await expect(action).toHaveText(ar.attendance.checkInAction);
      await action.click();
      await expect(page.getByText(ar.errors.ATTENDANCE_OUTSIDE_GEOFENCE)).toBeVisible();
      await expectNoHorizontalOverflow(page, '/attendance (ar)');
      await expectNoAxeViolations(page, '/attendance (ar)');
      // Arrow keys follow the reading direction in the tabs.
      await page.getByRole('tab', { selected: true }).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('id', 'tab-history');

      await page.goto('/attendance/team');
      await expect(page.getByRole('heading', { level: 1, name: ar.attendance.teamTitle })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page, '/attendance/team (ar)');
      await expectNoAxeViolations(page, '/attendance/team (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  for (const width of WIDTHS) {
    test(`22. accessibility and layout of the attendance screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const label = (name: string): string => `${name} at ${String(width)} px`;
      const { page, close } = await contextFor(browser, 'hr', { viewport });
      await openToday(page);
      await expectNoHorizontalOverflow(page, label('/attendance'));
      await expectNoAxeViolations(page, label('/attendance'));
      await page.getByTestId('attendance-request-correction').first().click();
      await expect(page.getByRole('dialog', { name: 'Request a correction' })).toBeVisible();
      await expectNoAxeViolations(page, label('correction dialog'));
      await page.keyboard.press('Escape');
      for (const tab of ['History', 'Corrections']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalOverflow(page, label(`/attendance ${tab}`));
        await expectNoAxeViolations(page, label(`/attendance ${tab}`));
      }

      await page.goto('/attendance/team');
      await settled(page);
      for (const tab of ['Day', 'Records', 'Review queue']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalOverflow(page, label(`/attendance/team ${tab}`));
        await expectNoAxeViolations(page, label(`/attendance/team ${tab}`));
      }
      await page.getByRole('tab', { name: 'Day' }).click();
      if (width < 768) {
        await expect(page.getByTestId('team-day-card').first()).toBeVisible();
      } else {
        await expect(page.getByTestId('team-day-row').first()).toBeVisible();
      }

      for (const path of ['/admin/attendance', '/admin/work-locations']) {
        await page.goto(path);
        await settled(page);
        await expectNoHorizontalOverflow(page, label(path));
        await expectNoAxeViolations(page, label(path));
      }
      await page.goto('/admin/attendance');
      await settled(page);
      await page.getByTestId('attendance-shifts').getByRole('button', { name: 'New shift' }).click();
      await expect(page.getByRole('dialog', { name: 'New shift' })).toBeVisible();
      await expectNoAxeViolations(page, label('new shift dialog'));
      await page.keyboard.press('Escape');
      await page.getByTestId('attendance-assignments').getByRole('button', { name: 'Assign shift' }).click();
      await expect(page.getByRole('dialog', { name: 'Assign shift' })).toBeVisible();
      await expectNoAxeViolations(page, label('assign shift dialog'));
      await page.keyboard.press('Escape');
      await close();
    });
  }
});
