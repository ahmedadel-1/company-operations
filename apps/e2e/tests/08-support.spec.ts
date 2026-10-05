import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '../support/test.js';
import type { Browser, Page } from '@playwright/test';

import { expectNoAxeViolations, expectNoHorizontalOverflow } from '../support/a11y.js';
import { contextFor, csrfToken } from '../support/auth.js';
import type { DemoUser } from '../support/auth.js';
import { backdateTicketSlaForTest } from '../support/baseline.js';
import { E2E_WEB_URL } from '../support/ports.js';

const messagesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'messages');
const ar = JSON.parse(readFileSync(join(messagesDir, 'ar.json'), 'utf8')) as {
  support: { title: string; create: { title: string }; comments: { title: string } };
};

/** A valid 1×1 PNG: attachments are checked by content, not by the file extension. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const WIDTHS = [375, 768, 1024, 1440] as const;
const RUN = randomUUID().slice(0, 8);
const IHD = 'Internal Helpdesk Upgrade';

/**
 * Every test creates its own tickets (unique titles per run), so the scenarios run in any order and
 * never depend on another test's data. Setup goes through the public API as the acting user; the
 * behaviour under test goes through the UI.
 */
const uniqueTitle = (label: string): string => `E2E ${label} ${RUN}`;

interface TicketRef {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly status: string;
}

interface CommentRef {
  readonly id: string;
  readonly body: string;
  readonly visibility: string;
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function writeHeaders(page: Page): Promise<Record<string, string>> {
  return { origin: E2E_WEB_URL, 'x-csrf-token': await csrfToken(page), 'content-type': 'application/json' };
}

async function send<T>(
  page: Page,
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    headers: { ...(await writeHeaders(page)), ...extraHeaders },
    data,
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBeLessThan(300);
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

async function projectId(page: Page, name: string): Promise<string> {
  const response = await page.request.get(`/api/v1/projects?q=${encodeURIComponent(name)}`);
  expect(response.status()).toBe(200);
  const { data } = (await response.json()) as { data: { id: string; name: string }[] };
  const id = data.find((project) => project.name === name)?.id;
  expect(id, `project ${name}`).toBeDefined();
  return id ?? '';
}

async function createTicket(
  page: Page,
  input: { title: string; severity?: string; projectId?: string; description?: string },
): Promise<TicketRef> {
  return send<TicketRef>(
    page,
    'POST',
    '/api/v1/support/tickets',
    {
      title: input.title,
      description: input.description ?? `Steps to reproduce for ${input.title}.`,
      severity: input.severity ?? 'MEDIUM',
      impact: 'SINGLE_USER',
      source: 'INTERNAL',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    },
    { 'Idempotency-Key': randomUUID() },
  );
}

async function getTicket(page: Page, id: string): Promise<TicketRef> {
  const response = await page.request.get(`/api/v1/support/tickets/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: TicketRef }).data;
}

async function transition(page: Page, id: string, to: string, note?: string): Promise<TicketRef> {
  const current = await getTicket(page, id);
  return send<TicketRef>(page, 'POST', `/api/v1/support/tickets/${id}/transitions`, {
    to,
    version: current.version,
    ...(note === undefined ? {} : { note }),
  });
}

async function addComment(
  page: Page,
  id: string,
  body: string,
  visibility: 'PUBLIC_INTERNAL' | 'INTERNAL_NOTE',
): Promise<CommentRef> {
  return send<CommentRef>(page, 'POST', `/api/v1/support/tickets/${id}/comments`, { body, visibility });
}

async function openTicket(page: Page, ticket: TicketRef): Promise<void> {
  await page.goto(`/support/tickets/${ticket.id}`);
  await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

function actions(page: Page) {
  return page.getByRole('region', { name: 'Ticket actions' });
}

/** Opens the transition dialog from the action bar, fills the note and submits it. */
async function runTransition(page: Page, ticket: TicketRef, label: string, note?: string): Promise<void> {
  await actions(page).getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${label} · ${ticket.key}` });
  await expect(dialog).toBeVisible();
  const submit = dialog.locator('button[type="submit"]');
  if (note !== undefined) {
    await dialog.getByLabel(/^Note/).fill(note);
  }
  await submit.click();
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

async function mailsFor(page: Page, address: string, ticketKey: string): Promise<MailSummary[]> {
  const response = await page.request.get(`${mailpitUrl()}/api/v1/messages?limit=500`);
  expect(response.status()).toBe(200);
  const { messages } = (await response.json()) as { messages: MailSummary[] };
  return messages.filter(
    (message) =>
      message.Subject.startsWith(`[${ticketKey}]`) && message.To.some((to) => to.Address.toLowerCase() === address),
  );
}

async function mailText(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`${mailpitUrl()}/api/v1/message/${id}`);
  expect(response.status()).toBe(200);
  const message = (await response.json()) as { Text: string; HTML: string; Subject: string };
  return `${message.Subject}\n${message.Text}\n${message.HTML}`;
}

test.describe('Phase 3 support operations', () => {
  test('1. a field employee reports a ticket from the support workspace', async ({ browser }) => {
    const title = uniqueTitle('Camera offline');
    const { page, close } = await contextFor(browser, 'field');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Support', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible();
    await page.getByRole('link', { name: 'New ticket' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Report an issue' })).toBeVisible();

    // Submitting an empty form is refused with field errors and creates nothing.
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page).toHaveURL(/\/support\/new$/);

    await page.getByLabel('Short summary').fill(title);
    await page.getByLabel('What happened?').fill('The camera at the north gate shows no picture since 08:00.');
    await page.getByLabel('Severity').selectOption({ label: 'High' });
    await page.getByLabel('Category').selectOption({ label: 'Hardware' });
    // Field staff default to the field source; priority is derived by support, not chosen by the reporter.
    await expect(page.getByLabel('Source')).toHaveValue('FIELD');
    await expect(page.getByLabel('Priority')).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit ticket' }).click();

    await expect(page).toHaveURL(/\/support\/tickets\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByTestId('ticket-status')).toHaveText('New');
    await expect(page.getByTestId('ticket-sla')).toContainText('Policy: High (business hours)');
    await expect(page.getByTestId('ticket-history')).toContainText('Fatma Field · Reported the ticket');
    await expectNoAxeViolations(page, 'new ticket detail (reporter)');

    await page.goto('/support');
    await settled(page);
    await page.getByLabel('View').selectOption({ label: 'Reported by me' });
    await expect(page.getByRole('table').getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await close();
  });

  test('2. a support agent triages the ticket: classification, project and priority', async ({ browser }) => {
    const ticket = await asUser(browser, 'field', (page) =>
      createTicket(page, { title: uniqueTitle('Portal search') }),
    );
    const { page, close } = await contextFor(browser, 'support');
    await page.goto('/support');
    await settled(page);
    await page.getByLabel('View').selectOption({ label: 'Needs triage' });
    await page.getByLabel('Search', { exact: true }).fill(ticket.key);
    await page.getByRole('button', { name: 'Apply' }).click();
    await page
      .getByRole('table')
      .getByRole('link', { name: new RegExp(ticket.title) })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();

    await page.getByRole('button', { name: 'Classification' }).click();
    await page.getByLabel('Priority').selectOption({ label: 'P2 · High' });
    await page.getByLabel('Category').selectOption({ label: 'Software' });
    await page.getByLabel('Project').selectOption({ label: `IHD · ${IHD}` });
    await expect(page.getByLabel('Component').locator('option', { hasText: 'Helpdesk portal' })).toHaveCount(1);
    await page.getByLabel('Component').selectOption({ label: 'Helpdesk portal' });
    await page.getByRole('button', { name: 'Save classification' }).click();
    await expect(page.getByRole('button', { name: 'Save classification' })).toHaveCount(0);
    await expect(page.getByText(`IHD · ${IHD}`)).toBeVisible();

    await runTransition(page, ticket, 'Mark as triaged');
    await expect(page.getByTestId('ticket-status')).toHaveText('Triaged');
    const history = page.getByTestId('ticket-history');
    await expect(history).toContainText('Sara Support · Marked the ticket as triaged');
    await expect(history).toContainText('Changed the priority from P3 · Normal to P2 · High');
    await expect(history).toContainText('Moved the ticket to another project');
    await close();
  });

  test('3. a support agent assigns the ticket to an active team member', async ({ browser }) => {
    const ticket = await asUser(browser, 'employee', (page) => createTicket(page, { title: uniqueTitle('VPN drops') }));
    const { page, close } = await contextFor(browser, 'support');
    await openTicket(page, ticket);
    await page.getByRole('button', { name: 'Change assignment' }).click();
    await page.getByLabel('Team').selectOption({ label: 'Support Tier 1' });
    const assignee = page.getByLabel('Assignee');
    await expect(assignee.locator('option', { hasText: 'Farida Sherif' })).toHaveCount(1);
    // Only active members who can work the ticket are offered; disabled accounts never are.
    await expect(assignee.locator('option', { hasText: 'Dina Disabled' })).toHaveCount(0);
    await assignee.selectOption({ label: 'Farida Sherif' });
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await expect(page.getByRole('button', { name: 'Change assignment' })).toBeVisible();
    await expect(page.getByRole('definition').filter({ hasText: 'Farida Sherif' })).toBeVisible();
    await expect(page.getByTestId('ticket-history')).toContainText('Sara Support · Assigned the ticket');

    const candidates = await page.request.get(`/api/v1/support/tickets/${ticket.id}/assignees?q=Dina`);
    expect(candidates.status()).toBe(200);
    const { data } = (await candidates.json()) as { data: { name: string }[] };
    expect(data.map((candidate) => candidate.name)).not.toContain('Dina Disabled');
    await close();
  });

  test('4. the agent and the reporter exchange public replies', async ({ browser }) => {
    const ticket = await asUser(browser, 'employee', (page) =>
      createTicket(page, { title: uniqueTitle('Printer jam') }),
    );
    const agent = await contextFor(browser, 'support');
    await openTicket(agent.page, ticket);
    await expect(agent.page.getByRole('radio', { name: 'Reply' })).toBeChecked();
    await agent.page.getByLabel('Message', { exact: true }).fill('Please restart the printer and tell us if it helps.');
    await agent.page.getByRole('button', { name: 'Send reply' }).click();
    await expect(agent.page.getByTestId('public-comment')).toContainText('Please restart the printer');
    await agent.close();

    const reporter = await contextFor(browser, 'employee');
    await openTicket(reporter.page, ticket);
    await expect(reporter.page.getByTestId('public-comment')).toContainText('Please restart the printer');
    // Reporters only write public replies: there is no internal-note choice.
    await expect(reporter.page.getByRole('radio')).toHaveCount(0);
    await reporter.page.getByLabel('Message', { exact: true }).fill('Restarted it, still jammed.');
    await reporter.page.getByRole('button', { name: 'Send reply' }).click();
    await expect(reporter.page.getByTestId('public-comment')).toHaveCount(2);
    await reporter.close();

    const again = await contextFor(browser, 'support');
    await openTicket(again.page, ticket);
    await expect(again.page.getByTestId('ticket-comments')).toContainText('Restarted it, still jammed.');
    await expect(again.page.getByTestId('ticket-sla')).toContainText(/Responded/);
    await again.close();
  });

  test('5. internal notes are never shown to the reporter, in the UI or through the API', async ({ browser }) => {
    const note = `Internal: suspect the toner sensor ${RUN}`;
    const ticket = await asUser(browser, 'employee', (page) => createTicket(page, { title: uniqueTitle('Toner') }));
    const agent = await contextFor(browser, 'support');
    await openTicket(agent.page, ticket);
    await agent.page.getByRole('radio', { name: 'Internal note' }).check();
    await agent.page.getByRole('textbox', { name: 'Internal note' }).fill(note);
    await agent.page.getByRole('button', { name: 'Add internal note' }).click();
    await expect(agent.page.getByTestId('internal-note')).toContainText(note);
    await expect(agent.page.getByTestId('ticket-history')).toContainText('Added an internal note');
    const comments = await agent.page.request.get(`/api/v1/support/tickets/${ticket.id}/comments`);
    const noteId =
      ((await comments.json()) as { data: CommentRef[] }).data.find((comment) => comment.body === note)?.id ?? '';
    expect(noteId).not.toBe('');
    await addComment(agent.page, ticket.id, 'We are looking into it.', 'PUBLIC_INTERNAL');
    await agent.close();

    const reporter = await contextFor(browser, 'employee');
    await openTicket(reporter.page, ticket);
    await expect(reporter.page.getByTestId('public-comment')).toContainText('We are looking into it.');
    await expect(reporter.page.getByTestId('internal-note')).toHaveCount(0);
    await expect(reporter.page.getByText(note)).toHaveCount(0);
    await expect(reporter.page.getByTestId('ticket-history')).not.toContainText('internal note');

    const listed = await reporter.page.request.get(`/api/v1/support/tickets/${ticket.id}/comments`);
    expect(listed.status()).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(note);
    expect(listedText).not.toContain('INTERNAL_NOTE');
    const history = await reporter.page.request.get(`/api/v1/support/tickets/${ticket.id}/history`);
    expect(await history.text()).not.toContain('INTERNAL_NOTE');
    const edit = await reporter.page.request.fetch(`/api/v1/support/tickets/${ticket.id}/comments/${noteId}`, {
      method: 'PATCH',
      headers: await writeHeaders(reporter.page),
      data: { body: 'overwritten' },
    });
    expect(edit.status()).toBe(404);
    // Writing an internal note is refused for the reporter as well.
    const forged = await reporter.page.request.post(`/api/v1/support/tickets/${ticket.id}/comments`, {
      headers: await writeHeaders(reporter.page),
      data: { body: 'sneaky', visibility: 'INTERNAL_NOTE' },
    });
    expect(forged.status()).toBe(403);
    await reporter.close();
  });

  test('6. the reporter attaches a file; others without access cannot list or fetch it', async ({ browser }) => {
    const ticket = await asUser(browser, 'field', (page) =>
      createTicket(page, { title: uniqueTitle('Cabinet photo') }),
    );
    const reporter = await contextFor(browser, 'field');
    await openTicket(reporter.page, ticket);
    const input = reporter.page.getByLabel('Add a photo or document');
    await input.setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(
      reporter.page.getByText('This file type is not allowed. Use JPEG, PNG, WebP, PDF, text or CSV.'),
    ).toBeVisible();
    await input.setInputFiles({ name: 'cabinet.png', mimeType: 'image/png', buffer: PNG });
    await expect(reporter.page.getByText('cabinet.png was uploaded.')).toBeVisible();
    await expect(reporter.page.getByTestId('ticket-attachments')).toContainText('cabinet.png');
    const listing = await reporter.page.request.get(
      `/api/v1/attachments?ownerType=SUPPORT_TICKET&ownerId=${encodeURIComponent(ticket.id)}`,
    );
    expect(listing.status()).toBe(200);
    const attachmentId =
      ((await listing.json()) as { data: { id: string; filename: string }[] }).data.find(
        (attachment) => attachment.filename === 'cabinet.png',
      )?.id ?? '';
    expect(attachmentId).not.toBe('');
    await reporter.close();

    const agent = await contextFor(browser, 'support');
    await openTicket(agent.page, ticket);
    await expect(agent.page.getByTestId('ticket-attachments')).toContainText('cabinet.png');
    await expect(agent.page.getByTestId('ticket-history')).toContainText('Attached a file');
    await agent.close();

    // IDOR: an unrelated employee guesses the ticket and attachment ids.
    const outsider = await contextFor(browser, 'employee');
    const list = await outsider.page.request.get(
      `/api/v1/attachments?ownerType=SUPPORT_TICKET&ownerId=${encodeURIComponent(ticket.id)}`,
    );
    expect([403, 404]).toContain(list.status());
    expect((await outsider.page.request.get(`/api/v1/attachments/${attachmentId}`)).status()).toBe(404);
    expect((await outsider.page.request.get(`/api/v1/attachments/${attachmentId}/download-url`)).status()).toBe(404);
    const intent = await outsider.page.request.post('/api/v1/attachments/upload-intents', {
      headers: await writeHeaders(outsider.page),
      data: {
        ownerType: 'SUPPORT_TICKET',
        ownerId: ticket.id,
        filename: 'x.png',
        contentType: 'image/png',
        sizeBytes: 68,
      },
    });
    expect([403, 404]).toContain(intent.status());
    await outsider.close();
  });

  test('7. the project manager sees and watches a ticket of their project', async ({ browser }) => {
    const { ticket, ihd } = await asUser(browser, 'support', async (page) => {
      const id = await projectId(page, IHD);
      return { ihd: id, ticket: await createTicket(page, { title: uniqueTitle('Helpdesk login'), projectId: id }) };
    });
    const { page, close } = await contextFor(browser, 'pm');
    await page.goto(`/projects/${ihd}`);
    await settled(page);
    await page.getByRole('tab', { name: 'Support' }).click();
    await expect(page.getByRole('tab', { name: 'Support' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Open tickets', { exact: true })).toBeVisible();
    const recent = page.getByRole('table', { name: 'Recent open tickets' });
    await recent.getByRole('link', { name: new RegExp(ticket.title) }).click();
    await expect(page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(page.getByTestId('ticket-watchers')).toContainText('Paul Planner');
    await expect(page.getByRole('button', { name: 'Stop watching' })).toBeVisible();
    await close();
  });

  test('8. an unrelated member cannot see someone else’s ticket', async ({ browser }) => {
    const ticket = await asUser(browser, 'field', (page) =>
      createTicket(page, { title: uniqueTitle('Private issue') }),
    );
    const { page, close } = await contextFor(browser, 'employee');
    await page.goto('/support');
    await settled(page);
    // Reporters only get their own views (no work queues, no performance figures).
    const views = await page.getByLabel('View').locator('option').allTextContents();
    expect(views).toEqual(['Reported by me', 'Watching']);
    await expect(page.getByText(ticket.title)).toHaveCount(0);

    await page.goto(`/support/tickets/${ticket.id}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    for (const path of ['', '/comments', '/history', '/watchers']) {
      expect((await page.request.get(`/api/v1/support/tickets/${ticket.id}${path}`)).status()).toBe(404);
    }
    const reply = await page.request.post(`/api/v1/support/tickets/${ticket.id}/comments`, {
      headers: await writeHeaders(page),
      data: { body: 'Let me in', visibility: 'PUBLIC_INTERNAL' },
    });
    expect(reply.status()).toBe(404);
    const search = await page.request.get(`/api/v1/support/tickets?view=all&q=${encodeURIComponent(ticket.key)}`);
    expect(search.status()).toBe(200);
    expect(((await search.json()) as { data: unknown[] }).data).toHaveLength(0);
    await close();

    // A project manager only reaches tickets of their projects.
    const pm = await contextFor(browser, 'pm');
    expect((await pm.page.request.get(`/api/v1/support/tickets/${ticket.id}`)).status()).toBe(404);
    await pm.close();
  });

  test('9. the SLA indicator follows the clock and the sweep escalates automatically', async ({ browser }) => {
    const ticket = await asUser(browser, 'support', async (page) =>
      createTicket(page, {
        title: uniqueTitle('Control room down'),
        severity: 'CRITICAL',
        projectId: await projectId(page, IHD),
      }),
    );
    const { page, close } = await contextFor(browser, 'support');
    await openTicket(page, ticket);
    const sla = page.getByTestId('ticket-sla');
    await expect(sla).toContainText('Policy: Critical (24x7)');
    await expect(sla.getByTestId('sla-indicator').first()).toHaveAttribute('data-state', 'ON_TRACK');
    await expect(sla).toContainText('First response: On track');
    await expect(sla).toContainText('Not escalated');

    // As if reported 3.5 hours ago: first response (30 min) missed, resolution (4 h) past 80 %.
    await backdateTicketSlaForTest(ticket.id, 210);
    await expect(async () => {
      await page.reload();
      await expect(sla).toContainText('First response: Breached', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(sla).toContainText('Resolution: At risk');
    // The seeded rule escalates critical tickets at 50 % of the resolution target.
    await expect(sla).toContainText('Escalation level 1');
    const history = page.getByTestId('ticket-history');
    await expect(history).toContainText('System · An SLA target was breached');
    await expect(history).toContainText('Escalated automatically to level 1');

    await page.goto('/support');
    await settled(page);
    await page.getByLabel('Search', { exact: true }).fill(ticket.key);
    await page.getByLabel('SLA').selectOption({ label: 'Breached' });
    await page.getByRole('button', { name: 'Apply' }).click();
    const row = page.getByTestId('ticket-row').filter({ hasText: ticket.title });
    await expect(row.getByTestId('sla-indicator')).toHaveText('SLA: Breached');
    await close();
  });

  test('10. an agent escalates a ticket with a reason and the project manager is notified', async ({ browser }) => {
    const ticket = await asUser(browser, 'support', async (page) =>
      createTicket(page, {
        title: uniqueTitle('Ticket export fails'),
        severity: 'HIGH',
        projectId: await projectId(page, IHD),
      }),
    );
    const agent = await contextFor(browser, 'support');
    await openTicket(agent.page, ticket);
    await actions(agent.page).getByRole('button', { name: 'Escalate', exact: true }).click();
    const dialog = agent.page.getByRole('dialog', { name: `Escalate · ${ticket.key}` });
    // A reason is mandatory.
    await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
    await dialog.getByLabel(/^Note/).fill('Needs the application team: export job crashes.');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toBeHidden();
    await expect(agent.page.getByTestId('ticket-status')).toHaveText('Escalated');
    await expect(agent.page.getByTestId('ticket-sla')).toContainText(/Escalation level [1-5]/);
    await expect(agent.page.getByTestId('ticket-history')).toContainText(
      'Note: Needs the application team: export job crashes.',
    );
    await agent.close();

    const pm = await contextFor(browser, 'pm');
    await expect(async () => {
      await pm.page.goto('/notifications');
      await expect(pm.page.getByRole('link', { name: new RegExp(`${ticket.key} was escalated to level`) })).toBeVisible(
        {
          timeout: 2_000,
        },
      );
    }).toPass({ timeout: 45_000 });
    await pm.page.getByRole('link', { name: new RegExp(`${ticket.key} was escalated to level`) }).click();
    await expect(pm.page).toHaveURL(new RegExp(`/support/tickets/${ticket.id}$`));
    await expect
      .poll(async () => (await mailsFor(pm.page, 'paul.planner@demo.company-ops.test', ticket.key)).length, {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);
    await pm.close();
  });

  test('11. resolving needs a summary and never closes the ticket by itself', async ({ browser }) => {
    const ticket = await asUser(browser, 'employee', (page) =>
      createTicket(page, { title: uniqueTitle('Mailbox full') }),
    );
    const agent = await contextFor(browser, 'support');
    await openTicket(agent.page, ticket);
    await actions(agent.page).getByRole('button', { name: 'Resolve', exact: true }).click();
    const dialog = agent.page.getByRole('dialog', { name: `Resolve · ${ticket.key}` });
    await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
    await expect(dialog).toContainText('The reporter is asked to confirm the fix.');
    await dialog.getByLabel(/^Note/).fill('Archived old mail and raised the quota to 50 GB.');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toBeHidden();
    await expect(agent.page.getByTestId('ticket-status')).toHaveText('Resolved');
    await expect(agent.page.getByText('Archived old mail and raised the quota to 50 GB.').first()).toBeVisible();
    await agent.close();

    // Still RESOLVED after more than one SLA sweep: there is no auto-close.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const reporter = await contextFor(browser, 'employee');
    const current = await getTicket(reporter.page, ticket.id);
    expect(current.status).toBe('RESOLVED');
    await openTicket(reporter.page, ticket);
    await expect(reporter.page.getByTestId('ticket-status')).toHaveText('Resolved');
    await expect(actions(reporter.page).getByRole('button', { name: 'Confirm fix' })).toBeVisible();
    await expect
      .poll(async () => (await mailsFor(reporter.page, 'emad.employee@demo.company-ops.test', ticket.key)).length, {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);
    await reporter.close();
  });

  test('12. the reporter confirms the fix', async ({ browser }) => {
    const ticket = await asUser(browser, 'employee', (page) =>
      createTicket(page, { title: uniqueTitle('Badge reader') }),
    );
    await asUser(browser, 'support', (page) => transition(page, ticket.id, 'RESOLVED', 'Replaced the reader.'));
    const { page, close } = await contextFor(browser, 'employee');
    await openTicket(page, ticket);
    // Closing is a support step; the reporter can confirm or reopen with a reason.
    await expect(actions(page).getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await expect(actions(page).getByRole('button', { name: 'Reopen' })).toBeVisible();
    await runTransition(page, ticket, 'Confirm fix');
    await expect(page.getByTestId('ticket-status')).toHaveText('Verified');
    await expect(page.getByTestId('ticket-history')).toContainText('Emad Employee · Confirmed the fix');
    await close();
  });

  test('13. support closes a verified ticket; it is locked until reopened', async ({ browser }) => {
    const ticket = await asUser(browser, 'employee', (page) =>
      createTicket(page, { title: uniqueTitle('Desk phone') }),
    );
    await asUser(browser, 'support', (page) => transition(page, ticket.id, 'RESOLVED', 'Re-provisioned the phone.'));
    await asUser(browser, 'employee', (page) => transition(page, ticket.id, 'VERIFIED'));
    const { page, close } = await contextFor(browser, 'support');
    await openTicket(page, ticket);
    await runTransition(page, ticket, 'Close');
    await expect(page.getByTestId('ticket-status')).toHaveText('Closed');
    await expect(page.getByText('This ticket is closed. Reopen it to add replies or files.')).toBeVisible();
    await expect(page.getByLabel('Add a photo or document')).toHaveCount(0);
    await expect(actions(page).getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(page.getByTestId('ticket-history')).toContainText('Sara Support · Closed the ticket');
    const reply = await page.request.post(`/api/v1/support/tickets/${ticket.id}/comments`, {
      headers: await writeHeaders(page),
      data: { body: 'After close', visibility: 'PUBLIC_INTERNAL' },
    });
    expect(reply.status()).toBe(409);
    await close();
  });

  test('14. mobile: a field employee reports and follows a ticket at 375 px', async ({ browser }) => {
    await asUser(browser, 'field', (page) => createTicket(page, { title: uniqueTitle('Mobile seed') }));
    const title = uniqueTitle('Mobile report');
    const { page, close } = await contextFor(browser, 'field', {
      viewport: { width: 375, height: 812 },
      hasTouch: true,
    });
    const bottomNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    // The support inbox lives in the More sheet; cards instead of a squeezed table on phones.
    await bottomNav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Support', exact: true }).click();
    await settled(page);
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.getByTestId('ticket-card').first()).toBeVisible();
    await expectNoHorizontalOverflow(page, '/support at 375 px');

    // The emphasized center action of the bottom bar opens ticket create.
    await bottomNav.getByRole('link', { name: 'Report issue' }).click();
    await settled(page);
    await page.getByLabel('Short summary').fill(title);
    await page.getByLabel('What happened?').fill('Reported from a phone on site.');
    // A photo taken on site is attached as part of reporting.
    await page.getByLabel('Photos or files').setInputFiles({ name: 'site.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId('new-ticket-files')).toContainText('site.png');
    await expectNoHorizontalOverflow(page, '/support/new at 375 px');
    await page.getByRole('button', { name: 'Submit ticket' }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByTestId('ticket-attachments')).toContainText('site.png');
    await expectNoHorizontalOverflow(page, 'ticket detail at 375 px');
    await page.getByLabel('Message', { exact: true }).fill('Photo follows.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByTestId('public-comment')).toContainText('Photo follows.');
    await expectNoAxeViolations(page, 'ticket detail at 375 px');
    await close();
  });

  test('15. RTL: the support screens render right-to-left in Arabic', async ({ browser }) => {
    const ticket = await asUser(browser, 'support', async (page) =>
      createTicket(page, { title: uniqueTitle('RTL check'), projectId: await projectId(page, IHD) }),
    );
    const { page, close } = await contextFor(browser, 'pm');
    const html = page.locator('html');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitemradio', { name: 'العربية' }).click();
    await expect(html).toHaveAttribute('dir', 'rtl');
    try {
      await page.goto('/support');
      await expect(page.getByRole('heading', { level: 1, name: ar.support.title })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page, '/support (ar)');
      await expectNoAxeViolations(page, '/support (ar)');

      await page.goto('/support/new');
      await expect(page.getByRole('heading', { level: 1, name: ar.support.create.title })).toBeVisible();
      await expectNoHorizontalOverflow(page, '/support/new (ar)');
      await expectNoAxeViolations(page, '/support/new (ar)');

      await openTicket(page, ticket);
      await expect(page.getByText(ar.support.comments.title)).toBeVisible();
      await expectNoHorizontalOverflow(page, 'ticket detail (ar)');
      await expectNoAxeViolations(page, 'ticket detail (ar)');
    } finally {
      await page.getByTestId('user-menu').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(html).toHaveAttribute('dir', 'ltr');
      await close();
    }
  });

  test('16. notifications: live update, bell link and one email that never carries internal notes', async ({
    browser,
  }) => {
    const note = `Secret triage detail ${RUN}`;
    const ticket = await asUser(browser, 'field', (page) => createTicket(page, { title: uniqueTitle('Notify me') }));
    const reporter = await contextFor(browser, 'field');
    await openTicket(reporter.page, ticket);

    await asUser(browser, 'support', async (page) => {
      await addComment(page, ticket.id, note, 'INTERNAL_NOTE');
      await addComment(page, ticket.id, 'A technician is on the way.', 'PUBLIC_INTERNAL');
    });

    // Pushed over the tenant-scoped event stream: the open page updates without a reload.
    await expect(reporter.page.getByTestId('public-comment')).toContainText('A technician is on the way.', {
      timeout: 45_000,
    });
    await expect(reporter.page.getByText(note)).toHaveCount(0);

    const bell = reporter.page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
    await expect(bell).toBeVisible({ timeout: 45_000 });
    await reporter.page.goto('/');
    await settled(reporter.page);
    await reporter.page.getByRole('button', { name: /^Notifications/ }).click();
    await reporter.page.getByRole('menuitem', { name: new RegExp(`New reply on your ticket ${ticket.key}:`) }).click();
    await expect(reporter.page).toHaveURL(new RegExp(`/support/tickets/${ticket.id}$`));
    await expect(reporter.page.getByRole('heading', { level: 1, name: ticket.title })).toBeVisible();

    const address = 'fatma.field@demo.company-ops.test';
    await expect
      .poll(async () => (await mailsFor(reporter.page, address, ticket.key)).length, { timeout: 45_000 })
      .toBe(1);
    // Give the worker time for any (wrong) extra delivery, then check again: exactly one reply email.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const mails = await mailsFor(reporter.page, address, ticket.key);
    expect(mails.map((mail) => mail.Subject)).toEqual([`[${ticket.key}] New reply: ${ticket.title}`]);
    for (const mail of mails) {
      expect(await mailText(reporter.page, mail.ID)).not.toContain(note);
    }
    await reporter.close();
  });

  test('support settings: a manager adds a category that reporters can pick', async ({ browser }) => {
    const name = uniqueTitle('Category');
    const manager = await contextFor(browser, 'manager');
    await manager.page.goto('/admin/support');
    await settled(manager.page);
    await manager.page.getByRole('button', { name: 'Add category' }).click();
    const dialog = manager.page.getByRole('dialog', { name: 'Add category' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(manager.page.getByTestId('support-categories')).toContainText(name);
    await manager.close();

    const reporter = await contextFor(browser, 'employee');
    await reporter.page.goto('/support/new');
    await settled(reporter.page);
    await expect(reporter.page.getByLabel('Category').locator('option', { hasText: name })).toHaveCount(1);
    // Configuration is for org-wide support administrators only.
    await reporter.page.goto('/admin/support');
    await expect(reporter.page.getByRole('heading', { name: "You don't have access" })).toBeVisible();
    await reporter.close();
  });

  for (const width of WIDTHS) {
    test(`responsive layout and axe on the support screens at ${String(width)} px`, async ({ browser }) => {
      const viewport = { width, height: 900 };
      const { ticket, ihd } = await asUser(browser, 'support', async (page) => {
        const id = await projectId(page, IHD);
        const created = await createTicket(page, { title: uniqueTitle(`Axe ${String(width)}`), projectId: id });
        await addComment(page, created.id, 'Internal context for the axe run.', 'INTERNAL_NOTE');
        await addComment(page, created.id, 'Public reply for the axe run.', 'PUBLIC_INTERNAL');
        return { ticket: created, ihd: id };
      });
      const agent = await contextFor(browser, 'support', { viewport });
      for (const path of ['/support', '/support/new', `/support/tickets/${ticket.id}`]) {
        await agent.page.goto(path);
        await settled(agent.page);
        await expectNoHorizontalOverflow(agent.page, `${path} at ${String(width)} px`);
        await expectNoAxeViolations(agent.page, `${path} at ${String(width)} px`);
      }
      await agent.page.goto(`/projects/${ihd}`);
      await settled(agent.page);
      await agent.page.getByRole('tab', { name: 'Support' }).click();
      await expect(agent.page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(agent.page.getByText('Open tickets', { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(agent.page, `project Support tab at ${String(width)} px`);
      await expectNoAxeViolations(agent.page, `project Support tab at ${String(width)} px`);
      await agent.close();

      const manager = await contextFor(browser, 'manager', { viewport });
      await manager.page.goto('/admin/support');
      await settled(manager.page);
      await expectNoHorizontalOverflow(manager.page, `/admin/support at ${String(width)} px`);
      await expectNoAxeViolations(manager.page, `/admin/support at ${String(width)} px`);
      await manager.page.getByRole('button', { name: 'Add service level' }).click();
      await expect(manager.page.getByRole('dialog', { name: 'Add service level' })).toBeVisible();
      await expectNoAxeViolations(manager.page, `service level dialog at ${String(width)} px`);
      await manager.close();
    });
  }
});
