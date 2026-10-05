import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bidDecisionListResponseSchema,
  commercialDashboardResponseSchema,
  commercialDocumentListResponseSchema,
  commercialDocumentResponseSchema,
  commercialEventPageResponseSchema,
  commercialSettingsResponseSchema,
  contractAmendmentListResponseSchema,
  contractAmendmentResponseSchema,
  contractMilestoneListResponseSchema,
  contractMilestoneResponseSchema,
  contractObligationListResponseSchema,
  contractObligationResponseSchema,
  contractPageResponseSchema,
  contractResponseSchema,
  corporateDocumentPageResponseSchema,
  corporateDocumentResponseSchema,
  errorEnvelopeSchema,
  guaranteeListResponseSchema,
  guaranteeResponseSchema,
  needsAttentionResponseSchema,
  obligationOccurrenceResponseSchema,
  occurrenceListResponseSchema,
  projectCommercialResponseSchema,
  renewalActionListResponseSchema,
  searchResponseSchema,
  tenderAddendumListResponseSchema,
  tenderClarificationListResponseSchema,
  tenderPageResponseSchema,
  tenderRequirementListResponseSchema,
  tenderRequirementResponseSchema,
  tenderResponseSchema,
  tenderReviewGateListResponseSchema,
  tenderSubmissionListResponseSchema,
  tenderWorkResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 10 (tenders and contracts) over real HTTP: every success body is validated against the shared
 * Zod contract behind OpenAPI; errors use the standard envelope; tenders and contracts outside the
 * caller's access (or another organization) are 404; financial values are omitted without the
 * financial permission; replay-sensitive actions need an Idempotency-Key; CSV exports are escaped.
 */
const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  field: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f07',
  manager: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f08',
  pm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f0a',
} as const;

let stack: ApiStack;
let orgA: string;
let orgB: string;
let admin: TestSession;
let gm: TestSession;
let employee: TestSession;
let field: TestSession;
let manager: TestSession;
let pm: TestSession;
let gmMember: string;
let employeeMember: string;
let pmProject: string;

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
  expect(response.status, text.slice(0, 500)).toBe(status);
  return schema.parse(JSON.parse(text));
}

async function failure(response: Response, status: number): Promise<string> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  const envelope = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(text).not.toMatch(/prisma|P20\d\d|constraint|stack/i);
  return envelope.error.code;
}

async function memberId(employeeNumber: string, organizationId = orgA): Promise<string> {
  const row = await stack.prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId, employeeNumber },
    select: { memberId: true },
  });
  return row.memberId;
}

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const inDays = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  orgB = (await stack.prisma.organization.findFirstOrThrow({ where: { id: { not: orgA } }, select: { id: true } })).id;
  admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
  gm = await createSession(stack, SUBJECT.gm, orgA);
  employee = await createSession(stack, SUBJECT.employee, orgA);
  field = await createSession(stack, SUBJECT.field, orgA);
  manager = await createSession(stack, SUBJECT.manager, orgA);
  pm = await createSession(stack, SUBJECT.pm, orgA);
  gmMember = await memberId('EMP-00002');
  employeeMember = await memberId('EMP-00004');
  pmProject = (
    await stack.prisma.project.findFirstOrThrow({ where: { organizationId: orgA, code: 'IHD' }, select: { id: true } })
  ).id;
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('tenders over HTTP', () => {
  let tenderId = '';
  let tenderKey = '';
  let requirementId = '';

  it('creates a tender and serves every tender read with the shared contracts', async () => {
    const created = await ok(
      await call('/tenders', gm, {
        method: 'POST',
        body: {
          title: 'Smart parking rollout',
          tenderType: 'OPEN_TENDER',
          ownerMemberId: gmMember,
          status: 'NEW',
          submissionDeadlineAt: inDays(20),
          submissionDeadlineTimeZone: 'Africa/Cairo',
          estimatedValue: '1250000.00',
          currency: 'EGP',
          relatedProjectId: pmProject,
        },
      }),
      tenderResponseSchema,
      201,
    );
    tenderId = created.data.id;
    tenderKey = created.data.key;
    expect(created.data).toMatchObject({ status: 'NEW', accessLevel: 'FULL', estimatedValue: { currency: 'EGP' } });
    expect(created.data.readiness.state).toBe('NO_MANDATORY');

    const list = await ok(await call('/tenders?limit=50', gm), tenderPageResponseSchema);
    expect(list.data.map((tender) => tender.id)).toContain(tenderId);

    const requirement = await ok(
      await call(`/tenders/${tenderId}/requirements`, gm, {
        method: 'POST',
        body: {
          category: 'TECHNICAL',
          title: 'Technical compliance sheet',
          ownerMemberId: employeeMember,
          mandatory: true,
          dueDate: isoDate(5),
        },
      }),
      tenderRequirementResponseSchema,
      201,
    );
    requirementId = requirement.data.id;
    expect(requirement.data.status).toBe('NOT_STARTED');

    await ok(await call(`/tenders/${tenderId}/requirements`, gm), tenderRequirementListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/reviews`, gm), tenderReviewGateListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/bid-decisions`, gm), bidDecisionListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/submissions`, gm), tenderSubmissionListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/addenda`, gm), tenderAddendumListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/clarifications`, gm), tenderClarificationListResponseSchema);
    await ok(await call(`/tenders/${tenderId}/documents`, gm), commercialDocumentListResponseSchema);
    const timeline = await ok(await call(`/tenders/${tenderId}/timeline`, gm), commercialEventPageResponseSchema);
    expect(timeline.data.length).toBeGreaterThan(0);

    const detail = await ok(await call(`/tenders/${tenderId}`, gm), tenderResponseSchema);
    expect(detail.data.readiness).toMatchObject({ state: 'NOT_READY' });
  });

  it('gives the requirement owner involved access without financial values, and nobody else', async () => {
    const involved = await ok(await call(`/tenders/${tenderId}`, employee), tenderResponseSchema);
    expect(involved.data.accessLevel).toBe('INVOLVED');
    expect(involved.data.estimatedValue).toBeUndefined();
    expect(JSON.stringify(involved.data)).not.toContain('1250000');

    const work = await ok(await call('/tenders/my-work', employee), tenderWorkResponseSchema);
    expect(work.data.items.map((item) => item.requirement.id)).toContain(requirementId);

    const started = await ok(
      await call(`/tenders/${tenderId}/requirements/${requirementId}/status`, employee, {
        method: 'POST',
        body: { version: 1, status: 'IN_PROGRESS' },
      }),
      tenderRequirementResponseSchema,
    );
    expect(started.data.status).toBe('IN_PROGRESS');

    // Organization-wide tender access with the financial permission sees the value; project-scoped
    // access without it sees the tender of its project, never the value.
    const viewer = await ok(await call(`/tenders/${tenderId}`, manager), tenderResponseSchema);
    expect(viewer.data).toMatchObject({ accessLevel: 'FULL', estimatedValue: { amount: '1250000', currency: 'EGP' } });
    const scoped = await ok(await call(`/tenders/${tenderId}`, pm), tenderResponseSchema);
    expect(scoped.data.accessLevel).toBe('FULL');
    expect(scoped.data.estimatedValue).toBeUndefined();
    expect(scoped.data.access.canViewFinancial).toBe(false);

    await failure(await call(`/tenders/${tenderId}`, field), 404);
    const fieldList = await ok(await call('/tenders', field), tenderPageResponseSchema);
    expect(fieldList.data.map((tender) => tender.id)).not.toContain(tenderId);
    expect(
      await failure(
        await call('/tenders', field, {
          method: 'POST',
          body: { title: 'x', tenderType: 'RFQ', ownerMemberId: gmMember },
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
  });

  it('requires an Idempotency-Key for submission and refuses unknown fields', async () => {
    expect(
      await failure(
        await call(`/tenders/${tenderId}/submission`, gm, {
          method: 'POST',
          body: { version: 1, method: 'EMAIL', submittedAt: new Date().toISOString() },
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await failure(
        await call(`/tenders/${tenderId}`, gm, { method: 'PATCH', body: { version: 1, organizationId: orgB } }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('never reaches another organization’s tenders or members', async () => {
    const foreignOwner = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgB },
      select: { id: true },
    });
    const foreign = await stack.prisma.tender.create({
      data: {
        organizationId: orgB,
        number: 1,
        year: 2026,
        title: 'Northwind tender',
        tenderType: 'RFQ',
        ownerMemberId: foreignOwner.id,
        createdByMemberId: foreignOwner.id,
      },
    });
    await failure(await call(`/tenders/${foreign.id}`, gm), 404);
    await failure(await call(`/tenders/${foreign.id}/requirements`, gm), 404);
    const list = await ok(await call('/tenders?limit=100&includeArchived=true', gm), tenderPageResponseSchema);
    expect(list.data.map((tender) => tender.id)).not.toContain(foreign.id);
    const code = await failure(
      await call(`/tenders/${tenderId}/requirements`, gm, {
        method: 'POST',
        body: { category: 'LEGAL', title: 'Foreign owner', ownerMemberId: foreignOwner.id },
      }),
      400,
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('finds the tender in global search only for callers who may open it', async () => {
    const found = await ok(
      await call(`/search?q=${encodeURIComponent(tenderKey)}&types=tenders`, gm),
      searchResponseSchema,
    );
    expect(found.data.groups[0]?.items.map((item) => item.id)).toContain(tenderId);
    const hidden = await ok(
      await call(`/search?q=${encodeURIComponent('Smart parking')}&types=tenders`, field),
      searchResponseSchema,
    );
    expect(hidden.data.groups[0]?.items ?? []).toHaveLength(0);
  });
});

describe('contracts over HTTP', () => {
  let contractId = '';

  it('runs a contract through its lifecycle with obligations, milestones and guarantees', async () => {
    const created = await ok(
      await call('/contracts', gm, {
        method: 'POST',
        body: {
          title: 'Helpdesk support agreement',
          contractType: 'SUPPORT',
          currency: 'EGP',
          originalValue: '480000.00',
          startDate: isoDate(-10),
          expiryDate: isoDate(60),
          renewalType: 'MANUAL_RENEWAL',
          noticePeriodDays: 30,
          ownerMemberId: gmMember,
          projectId: pmProject,
        },
      }),
      contractResponseSchema,
      201,
    );
    contractId = created.data.id;
    expect(created.data).toMatchObject({ status: 'DRAFT', currentValue: { amount: '480000', currency: 'EGP' } });

    let version = created.data.version;
    for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
      const moved = await ok(
        await call(`/contracts/${contractId}/transition`, gm, { method: 'POST', body: { version, to } }),
        contractResponseSchema,
      );
      expect(moved.data.status).toBe(to);
      version = moved.data.version;
    }

    const obligation = await ok(
      await call(`/contracts/${contractId}/obligations`, gm, {
        method: 'POST',
        body: {
          title: 'Monthly SLA report',
          category: 'REPORTING',
          ownerMemberId: employeeMember,
          recurrence: 'MONTHLY',
          dueDate: isoDate(3),
        },
      }),
      contractObligationResponseSchema,
      201,
    );
    expect(obligation.data.occurrences.length).toBeGreaterThan(0);
    await ok(await call(`/contracts/${contractId}/obligations`, gm), contractObligationListResponseSchema);
    const occurrences = await ok(
      await call(`/contracts/${contractId}/occurrences`, employee),
      occurrenceListResponseSchema,
    );
    const first = occurrences.data[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const done = await ok(
      await call(`/contracts/${contractId}/occurrences/${first.id}/status`, employee, {
        method: 'POST',
        body: { version: first.version, status: 'COMPLETED', note: 'Sent to the customer' },
      }),
      obligationOccurrenceResponseSchema,
    );
    expect(done.data.status).toBe('COMPLETED');

    await ok(
      await call(`/contracts/${contractId}/milestones`, gm, {
        method: 'POST',
        body: { title: 'Go-live acceptance', dueDate: isoDate(20), approvalRequired: true },
      }),
      contractMilestoneResponseSchema,
      201,
    );
    await ok(await call(`/contracts/${contractId}/milestones`, gm), contractMilestoneListResponseSchema);

    const guarantee = await ok(
      await call(`/contracts/${contractId}/guarantees`, gm, {
        method: 'POST',
        body: {
          type: 'PERFORMANCE_GUARANTEE',
          referenceNumber: 'PG-2026-77',
          issuer: 'National Bank',
          amount: '48000.00',
          currency: 'EGP',
          issueDate: isoDate(-5),
          expiryDate: isoDate(10),
        },
      }),
      guaranteeResponseSchema,
      201,
    );
    expect(guarantee.data).toMatchObject({ status: 'EXPIRING', amount: { currency: 'EGP' } });
    await ok(await call(`/contracts/${contractId}/guarantees`, gm), guaranteeListResponseSchema);
    await ok(await call(`/guarantees/${guarantee.data.id}`, gm), guaranteeResponseSchema);
    await ok(await call(`/contracts/${contractId}/renewal-actions`, gm), renewalActionListResponseSchema);
    await ok(await call(`/contracts/${contractId}/documents`, gm), commercialDocumentListResponseSchema);
    await ok(await call(`/contracts/${contractId}/timeline`, gm), commercialEventPageResponseSchema);
    const list = await ok(await call('/contracts?guaranteesExpiring=true', gm), contractPageResponseSchema);
    expect(list.data.map((contract) => contract.id)).toContain(contractId);
  });

  it('keeps amendments under four eyes and the value behind the financial permission', async () => {
    const contract = await ok(await call(`/contracts/${contractId}`, gm), contractResponseSchema);
    const amendment = await ok(
      await call(`/contracts/${contractId}/amendments`, gm, {
        method: 'POST',
        body: { type: 'VALUE_CHANGE', title: 'Additional site', effectiveDate: isoDate(1), valueDelta: '20000.00' },
      }),
      contractAmendmentResponseSchema,
      201,
    );
    expect(amendment.data.key).toMatch(/^CTR-\d{4}-\d{4}-A\d+$/);
    const submitted = await ok(
      await call(`/contracts/${contractId}/amendments/${amendment.data.id}/actions`, gm, {
        method: 'POST',
        body: { version: amendment.data.version, action: 'SUBMIT' },
      }),
      contractAmendmentResponseSchema,
    );
    expect(submitted.data.status).toBe('UNDER_REVIEW');
    expect(
      await failure(
        await call(`/contracts/${contractId}/amendments/${amendment.data.id}/actions`, gm, {
          method: 'POST',
          body: { version: submitted.data.version, action: 'APPROVE' },
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
    await ok(await call(`/contracts/${contractId}/amendments`, gm), contractAmendmentListResponseSchema);
    const unchanged = await ok(await call(`/contracts/${contractId}`, gm), contractResponseSchema);
    expect(unchanged.data.currentValue).toEqual(contract.data.currentValue);

    // Project-scoped contract access without the financial permission: the contract, never its value.
    const scoped = await ok(await call(`/contracts/${contractId}`, pm), contractResponseSchema);
    expect(scoped.data.accessLevel).toBe('FULL');
    expect(scoped.data.currentValue).toBeUndefined();
    expect(scoped.data.originalValue).toBeUndefined();
    const scopedAmendments = await ok(
      await call(`/contracts/${contractId}/amendments`, pm),
      contractAmendmentListResponseSchema,
    );
    for (const item of scopedAmendments.data) {
      expect(item.valueDelta).toBeUndefined();
      expect(item.hasValueChange).toBe(true);
    }
    const tab = await ok(await call(`/projects/${pmProject}/commercial`, pm), projectCommercialResponseSchema);
    expect(tab.data.contracts.map((row) => row.id)).toContain(contractId);
    expect(JSON.stringify(tab.data)).not.toContain('480000');

    await failure(await call(`/contracts/${contractId}`, field), 404);
    const fieldList = await ok(await call('/contracts', field), contractPageResponseSchema);
    expect(fieldList.data).toHaveLength(0);
  });

  it('requires an Idempotency-Key for renewal decisions and applies a retried key once', async () => {
    const before = await ok(await call(`/contracts/${contractId}`, gm), contractResponseSchema);
    const body = { version: before.data.version, action: 'REVIEW_STARTED' };
    expect(
      await failure(await call(`/contracts/${contractId}/renewal-actions`, gm, { method: 'POST', body }), 400),
    ).toBe('VALIDATION_FAILED');
    const key = randomUUID();
    const first = await ok(
      await call(`/contracts/${contractId}/renewal-actions`, gm, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': key },
      }),
      contractResponseSchema,
      201,
    );
    expect(first.data.status).toBe('RENEWAL_REVIEW');
    await ok(
      await call(`/contracts/${contractId}/renewal-actions`, gm, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': key },
      }),
      contractResponseSchema,
      201,
    );
    const actions = await ok(
      await call(`/contracts/${contractId}/renewal-actions`, gm),
      renewalActionListResponseSchema,
    );
    expect(actions.data.filter((action) => action.action === 'REVIEW_STARTED')).toHaveLength(1);
  });
});

describe('documents, settings, reports and dashboards over HTTP', () => {
  it('serves the corporate document vault to its readers only', async () => {
    const created = await ok(
      await call('/corporate-documents', admin, {
        method: 'POST',
        body: { documentType: 'COMMERCIAL_REGISTRATION', title: 'Commercial registration', documentNumber: 'CR-1001' },
      }),
      corporateDocumentResponseSchema,
      201,
    );
    expect(created.data.validity).toBe('NO_VERSION');
    const list = await ok(await call('/corporate-documents', gm), corporateDocumentPageResponseSchema);
    expect(list.data.map((document) => document.id)).toContain(created.data.id);
    expect(await failure(await call('/corporate-documents', field), 403)).toBe('FORBIDDEN');
  });

  it('attaches tender documents with classification', async () => {
    const tender = (await ok(await call('/tenders?limit=1', gm), tenderPageResponseSchema)).data[0];
    expect(tender).toBeDefined();
    if (tender === undefined) return;
    const document = await ok(
      await call(`/tenders/${tender.id}/documents`, gm, {
        method: 'POST',
        body: { category: 'COMMERCIAL_PROPOSAL', title: 'Price schedule' },
      }),
      commercialDocumentResponseSchema,
      201,
    );
    expect(document.data.classification).toBe('COMMERCIAL_CONFIDENTIAL');
  });

  it('reads settings for commercial readers and changes them with org.settings.manage only', async () => {
    const settings = await ok(await call('/commercial/settings', gm), commercialSettingsResponseSchema);
    await failure(
      await call('/commercial/settings', gm, {
        method: 'PUT',
        body: { version: settings.data.version, tenderReminderDays: [10, 3] },
      }),
      403,
    );
    const updated = await ok(
      await call('/commercial/settings', admin, {
        method: 'PUT',
        body: { version: settings.data.version, tenderReminderDays: [3, 10, 10] },
      }),
      commercialSettingsResponseSchema,
    );
    expect(updated.data.tenderReminderDays).toEqual([10, 3]);
  });

  it('exports formula-safe CSV and keeps financial reports behind the financial permission', async () => {
    await ok(
      await call('/tenders', gm, {
        method: 'POST',
        body: {
          title: '=HYPERLINK("http://evil.test")',
          tenderType: 'RFQ',
          ownerMemberId: gmMember,
          status: 'NEW',
          submissionDeadlineAt: inDays(30),
          submissionDeadlineTimeZone: 'Africa/Cairo',
        },
      }),
      tenderResponseSchema,
      201,
    );
    const response = await call('/commercial/reports/tender-pipeline', gm);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="[\w.-]+\.csv"$/);
    expect(response.headers.get('x-export-truncated')).toBe('false');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);

    expect(await failure(await call('/commercial/reports/contracts-by-value', pm), 403)).toBe('FORBIDDEN');
    expect(await failure(await call('/commercial/reports/tender-pipeline', field), 403)).toBe('FORBIDDEN');
    const audit = await stack.prisma.auditLog.count({
      where: { organizationId: orgA, action: 'commercial.report_exported' },
    });
    expect(audit).toBeGreaterThan(0);
  });

  it('serves the commercial dashboard and Needs Attention with the shared contracts', async () => {
    const dashboard = await ok(await call('/dashboard/commercial', gm), commercialDashboardResponseSchema);
    expect(dashboard.data.commercial.tenders).not.toBeNull();
    expect(await failure(await call('/dashboard/commercial', field), 403)).toBe('FORBIDDEN');
    const attention = await ok(await call('/dashboard/needs-attention', gm), needsAttentionResponseSchema);
    expect(attention.data.items.map((item) => item.type)).toContain('GUARANTEE_EXPIRING');
  });
});
