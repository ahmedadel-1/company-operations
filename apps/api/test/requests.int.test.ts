import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminRequestTypeListResponseSchema,
  approvalInboxPageResponseSchema,
  approvalSummaryResponseSchema,
  errorEnvelopeSchema,
  requestEventPageResponseSchema,
  requestFormResponseSchema,
  requestPageResponseSchema,
  requestResponseSchema,
  requestTypeCatalogResponseSchema,
  workflowVersionPageResponseSchema,
  workflowVersionResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 6 (requests and approvals) over real HTTP: bodies match the shared Zod contracts behind the
 * OpenAPI document; out-of-scope and foreign requests are 404, visible-but-not-permitted actions 403;
 * errors use the standard envelope and never leak internals.
 */
let stack: ApiStack;
let orgA: string;
let orgB: string;
let admin: TestSession;
let lead: TestSession;
let otherLead: TestSession;
let requester: TestSession;
let colleague: TestSession;
let foreign: TestSession;

function call(
  path: string,
  session: TestSession,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers({ cookie: session.cookie, ...init.headers });
  if (method !== 'GET') {
    headers.set('origin', PUBLIC_URL);
    headers.set('x-csrf-token', session.csrfToken);
  }
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${stack.baseUrl}/api/v1${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function ok<T>(response: Response, schema: { parse(value: unknown): T }, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack/i);
  return envelope.error.code;
}

/** A session for a seeded employee, through the user linked to their membership. */
async function sessionFor(employeeNumber: string, organizationId = orgA): Promise<TestSession> {
  const profile = await stack.prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId, employeeNumber },
    select: { member: { select: { user: { select: { idpSubject: true } } } } },
  });
  const subject = profile.member.user?.idpSubject;
  if (subject === undefined) throw new Error(`${employeeNumber} has no linked user`);
  return createSession(stack, subject, organizationId, { mfa: true });
}

async function typeId(key: string, organizationId = orgA): Promise<string> {
  const row = await stack.prisma.requestType.findFirstOrThrow({ where: { organizationId, key }, select: { id: true } });
  return row.id;
}

async function pendingApproval(requestId: string, session: TestSession): Promise<string> {
  const inbox = await ok(await call('/approvals?limit=100', session), approvalInboxPageResponseSchema);
  const item = inbox.data.find((entry) => entry.request.id === requestId);
  if (item === undefined) throw new Error('No pending approval in the inbox');
  return item.approvalId;
}

const WFH = { dates: { start: '2027-02-01', end: '2027-02-02' }, reason: 'Home internet installation' };

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  orgB = (await stack.prisma.organization.findFirstOrThrow({ where: { id: { not: orgA } }, select: { id: true } })).id;
  admin = await sessionFor('EMP-00001');
  lead = await sessionFor('EMP-00008');
  otherLead = await sessionFor('EMP-00013');
  requester = await sessionFor('EMP-00009');
  colleague = await sessionFor('EMP-00010');
  foreign = await sessionFor('NW-001', orgB);
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('catalog and submission', () => {
  it('lists the seeded request types and serves their published form', async () => {
    const catalog = await ok(await call('/request-types', requester), requestTypeCatalogResponseSchema);
    expect(catalog.data.map((type) => type.key).sort()).toEqual(
      [
        'business_mission',
        'laptop',
        'leave',
        'purchase',
        'short_permission',
        'software_access',
        'work_from_home',
      ].sort(),
    );
    const form = await ok(
      await call(`/request-types/${await typeId('work_from_home')}/form`, requester),
      requestFormResponseSchema,
    );
    expect(form.data.form.fields.map((field) => field.key)).toEqual(['dates', 'reason']);
    const foreignType = await stack.prisma.requestType.create({
      data: {
        organizationId: orgB,
        key: 'nw_only',
        name: { en: 'Northwind only' },
        category: 'OTHER',
        icon: 'calendar',
      },
    });
    await failure(await call(`/request-types/${foreignType.id}/form`, requester), 404);
  });

  it('submits once per idempotency key, freezes the approver and numbers the request', async () => {
    const key = randomUUID();
    const body = { requestTypeId: await typeId('work_from_home'), formData: WFH, submit: true };
    const first = await ok(
      await call('/requests', requester, { method: 'POST', body, headers: { 'idempotency-key': key } }),
      requestResponseSchema,
      201,
    );
    expect(first.data.key).toBe(`REQ-${String(first.data.number)}`);
    expect(first.data.status).toBe('PENDING_APPROVAL');
    const replay = await ok(
      await call('/requests', requester, { method: 'POST', body, headers: { 'idempotency-key': key } }),
      requestResponseSchema,
      201,
    );
    expect(replay.data.id).toBe(first.data.id);
    expect(
      await failure(
        await call('/requests', requester, {
          method: 'POST',
          body: { ...body, formData: { ...WFH, reason: 'Something else' } },
          headers: { 'idempotency-key': key },
        }),
        409,
      ),
    ).toBe('CONFLICT');
    expect(
      await failure(
        await call('/requests', requester, { method: 'POST', body, headers: { 'idempotency-key': 'not-a-uuid' } }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');

    const mine = await ok(await call('/requests?view=mine', requester), requestPageResponseSchema);
    expect(mine.data.map((item) => item.id)).toContain(first.data.id);
    const history = await ok(
      await call(`/requests/${first.data.id}/history`, requester),
      requestEventPageResponseSchema,
    );
    expect(history.data.map((event) => event.type)).toEqual(
      expect.arrayContaining(['CREATED', 'SUBMITTED', 'STEP_ACTIVATED']),
    );
  });

  it('rejects hidden, unknown and invalid form values on the server', async () => {
    const leave = await typeId('leave');
    const submit = (formData: unknown) =>
      call('/requests', requester, { method: 'POST', body: { requestTypeId: leave, formData, submit: true } });
    expect(await failure(await submit({ leaveType: 'annual' }), 400)).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await submit({ leaveType: 'annual', dates: { start: '2027-01-01', end: '2027-01-02' }, isAdmin: true }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(await submit({ leaveType: 'vacation', dates: { start: '2027-01-01', end: '2027-01-02' } }), 400),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('approvals over HTTP', () => {
  it('only the frozen approver decides; others get 404 or 403; replays are refused', async () => {
    const created = await ok(
      await call('/requests', requester, {
        method: 'POST',
        body: { requestTypeId: await typeId('work_from_home'), formData: WFH, submit: true },
      }),
      requestResponseSchema,
      201,
    );
    const requestId = created.data.id;
    const summary = await ok(await call('/approvals/summary', lead), approvalSummaryResponseSchema);
    expect(summary.data.pending).toBeGreaterThan(0);
    const approvalId = await pendingApproval(requestId, lead);

    // Not assigned and cannot see the request: 404 (no existence oracle).
    expect(
      await failure(await call(`/approvals/${approvalId}/approve`, otherLead, { method: 'POST', body: {} }), 404),
    ).toBe('NOT_FOUND');
    expect(await failure(await call(`/requests/${requestId}`, colleague), 404)).toBe('NOT_FOUND');
    // The requester sees the request but may not approve it: 403.
    await failure(await call(`/approvals/${approvalId}/approve`, requester, { method: 'POST', body: {} }), 403);
    expect(await failure(await call(`/approvals/${approvalId}/reject`, lead, { method: 'POST', body: {} }), 400)).toBe(
      'VALIDATION_FAILED',
    );
    await failure(await call(`/approvals/${randomUUID()}/approve`, lead, { method: 'POST', body: {} }), 404);

    const approved = await ok(
      await call(`/approvals/${approvalId}/approve`, lead, { method: 'POST', body: { comment: 'Fine' } }),
      requestResponseSchema,
    );
    expect(approved.data.status).toBe('APPROVED');
    // A retried approval is idempotent; a conflicting decision is refused.
    const retried = await ok(
      await call(`/approvals/${approvalId}/approve`, lead, { method: 'POST', body: {} }),
      requestResponseSchema,
    );
    expect(retried.data.version).toBe(approved.data.version);
    expect(
      await failure(
        await call(`/approvals/${approvalId}/reject`, lead, { method: 'POST', body: { comment: 'Changed my mind' } }),
        409,
      ),
    ).toBe('REQUEST_ALREADY_DECIDED');
    const read = await ok(await call(`/requests/${requestId}`, requester), requestResponseSchema);
    expect(read.data.status).toBe('APPROVED');
  });

  it('rejects with a reason the requester can read', async () => {
    const created = await ok(
      await call('/requests', requester, {
        method: 'POST',
        body: { requestTypeId: await typeId('work_from_home'), formData: WFH, submit: true },
      }),
      requestResponseSchema,
      201,
    );
    const approvalId = await pendingApproval(created.data.id, lead);
    const rejected = await ok(
      await call(`/approvals/${approvalId}/reject`, lead, {
        method: 'POST',
        body: { comment: 'Team offsite that week' },
      }),
      requestResponseSchema,
    );
    expect(rejected.data.status).toBe('REJECTED');
    const read = await ok(await call(`/requests/${created.data.id}`, requester), requestResponseSchema);
    expect(read.data.steps[0]?.approvals[0]).toMatchObject({ status: 'REJECTED', comment: 'Team offsite that week' });
  });
});

describe('administration over HTTP', () => {
  it('is ORG-admin only, needs fresh MFA and keeps published versions read-only', async () => {
    await failure(await call('/request-admin/types', requester), 403);
    await failure(await call('/request-admin/types', lead), 403);
    // request.admin decides who approves what: it is privileged like role.manage.
    const hrUser = await stack.prisma.user.findFirstOrThrow({
      where: { email: 'hr@demo.company-ops.test' },
      select: { idpSubject: true },
    });
    const hrWithoutMfa = await createSession(stack, hrUser.idpSubject, orgA);
    expect(await failure(await call('/request-admin/types', hrWithoutMfa), 401)).toBe('MFA_REQUIRED');
    const reassignWithoutMfa = await call(`/requests/${randomUUID()}/reassign`, hrWithoutMfa, {
      method: 'POST',
      body: {},
    });
    expect(reassignWithoutMfa.status).toBe(401);
    const types = await ok(await call('/request-admin/types', admin), adminRequestTypeListResponseSchema);
    const wfh = types.data.find((type) => type.key === 'work_from_home');
    expect(wfh?.publishedVersion).not.toBeNull();
    const id = wfh?.id ?? '';
    const versions = await ok(
      await call(`/request-admin/types/${id}/versions`, admin),
      workflowVersionPageResponseSchema,
    );
    const published = versions.data.find((version) => version.status === 'PUBLISHED');
    expect(published).toBeDefined();
    const detail = await ok(
      await call(`/request-admin/types/${id}/versions/${published?.id ?? ''}`, admin),
      workflowVersionResponseSchema,
    );
    expect(detail.data.editable).toBe(false);
    const content = {
      form: { fields: [{ key: 'reason', type: 'textarea', label: { en: 'Reason' }, required: true }] },
      steps: [{ kind: 'APPROVAL', name: { en: 'Manager' }, mode: 'ANY_ONE', approver: { type: 'DIRECT_MANAGER' } }],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {},
      notifications: { emailApprovers: true, emailRequester: true },
    };
    expect(
      await failure(
        await call(`/request-admin/types/${id}/versions/${detail.data.id}`, admin, {
          method: 'PUT',
          body: { ...content, revision: detail.data.revision },
        }),
        409,
      ),
    ).toBe('INVALID_TRANSITION');
    expect(
      await failure(
        await call(`/request-admin/types/${id}/versions/${detail.data.id}/publish`, admin, {
          method: 'POST',
          body: { revision: detail.data.revision },
        }),
        409,
      ),
    ).not.toBe('');
  });
});

describe('tenant isolation over HTTP', () => {
  it('never reaches another organization’s requests, types or approvals', async () => {
    const created = await ok(
      await call('/requests', requester, {
        method: 'POST',
        body: { requestTypeId: await typeId('work_from_home'), formData: WFH, submit: true },
      }),
      requestResponseSchema,
      201,
    );
    const approvalId = await pendingApproval(created.data.id, lead);
    expect(await failure(await call(`/requests/${created.data.id}`, foreign), 404)).toBe('NOT_FOUND');
    await failure(await call(`/requests/${created.data.id}/history`, foreign), 404);
    await failure(await call(`/approvals/${approvalId}/approve`, foreign, { method: 'POST', body: {} }), 404);
    await failure(
      await call('/requests', foreign, {
        method: 'POST',
        body: { requestTypeId: await typeId('work_from_home'), formData: WFH, submit: true },
      }),
      404,
    );
    const theirs = await ok(await call('/requests?limit=100', foreign), requestPageResponseSchema);
    expect(theirs.data.map((item) => item.id)).not.toContain(created.data.id);
    expect((await ok(await call('/approvals/summary', foreign), approvalSummaryResponseSchema)).data.pending).toBe(0);
  });
});
