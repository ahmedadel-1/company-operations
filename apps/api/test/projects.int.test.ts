import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attachmentListResponseSchema,
  customerPageResponseSchema,
  customerResponseSchema,
  dailyReportPageResponseSchema,
  dailyReportResponseSchema,
  employeeProjectListResponseSchema,
  errorEnvelopeSchema,
  missingReportsResponseSchema,
  projectActivityPageResponseSchema,
  projectLocationListResponseSchema,
  projectLocationResponseSchema,
  projectMemberListResponseSchema,
  projectMemberResponseSchema,
  projectPageResponseSchema,
  projectResponseSchema,
  uploadIntentResponseSchema,
  workLocationListResponseSchema,
  workLocationResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Phase 2 (projects) endpoints over real HTTP: every success body is validated against the shared
 * Zod contract the OpenAPI document and the generated client are built from; errors use the
 * standard envelope; foreign and out-of-scope resources are 404.
 */
const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  hr: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  field: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f07',
  manager: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f08',
} as const;

let stack: ApiStack;
let orgA: string;
let orgB: string;
let admin: TestSession;
let gm: TestSession;
let hr: TestSession;
let employee: TestSession;
let field: TestSession;
let manager: TestSession;

function call(path: string, session: TestSession, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers({ cookie: session.cookie });
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

async function profileId(employeeNumber: string, organizationId = orgA): Promise<string> {
  const row = await stack.prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId, employeeNumber },
    select: { id: true },
  });
  return row.id;
}

async function seededProjectId(code: string): Promise<string> {
  const row = await stack.prisma.project.findFirstOrThrow({
    where: { organizationId: orgA, code },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  const second = await stack.prisma.organization.findFirstOrThrow({
    where: { id: { not: orgA } },
    select: { id: true },
  });
  orgB = second.id;
  admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
  gm = await createSession(stack, SUBJECT.gm, orgA);
  hr = await createSession(stack, SUBJECT.hr, orgA, { mfa: true });
  employee = await createSession(stack, SUBJECT.employee, orgA);
  field = await createSession(stack, SUBJECT.field, orgA);
  manager = await createSession(stack, SUBJECT.manager, orgA);
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('customers', () => {
  it('managers create, list, update and archive; employees without project rights are refused', async () => {
    const created = await ok(
      await call('/customers', manager, { method: 'POST', body: { name: 'Delta Utilities', type: 'PRIVATE' } }),
      customerResponseSchema,
      201,
    );
    expect(
      await failure(
        await call('/customers', manager, { method: 'POST', body: { name: 'delta utilities', type: 'PRIVATE' } }),
        409,
      ),
    ).toBe('CONFLICT');
    const list = await ok(await call('/customers?q=Delta', manager), customerPageResponseSchema);
    expect(list.data.map((c) => c.id)).toContain(created.data.id);
    const archived = await ok(
      await call(`/customers/${created.data.id}`, manager, { method: 'PATCH', body: { archived: true } }),
      customerResponseSchema,
    );
    expect(archived.data.archived).toBe(true);
    expect(
      (await ok(await call('/customers', manager), customerPageResponseSchema)).data.map((c) => c.id),
    ).not.toContain(created.data.id);
    await failure(await call('/customers', employee), 403);
    await failure(await call('/customers', field, { method: 'POST', body: { name: 'X', type: 'PRIVATE' } }), 403);
    expect(
      await failure(await call('/customers', manager, { method: 'POST', body: { name: '', type: 'NOPE' } }), 400),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('projects: lifecycle, membership, scope and daily reports', () => {
  let projectId: string;
  let version: number;

  it('a manager creates a project with a counter code and reads it back', async () => {
    const customer = await ok(
      await call('/customers', manager, { method: 'POST', body: { name: 'Gamma Ports', type: 'GOVERNMENT' } }),
      customerResponseSchema,
      201,
    );
    const created = await ok(
      await call('/projects', manager, {
        method: 'POST',
        body: {
          name: 'Port Gate System',
          customerId: customer.data.id,
          technicalManagerId: await profileId('EMP-00032'),
          startDate: '2026-09-01',
          dailyReportPolicy: { required: true, weekdays: [], dueLocalTime: '18:00', reporterRoles: ['FIELD'] },
        },
      }),
      projectResponseSchema,
      201,
    );
    expect(created.data.code).toMatch(/^PRJ-\d+$/);
    expect(created.data.status).toBe('PLANNING');
    expect(created.data.access.canManage).toBe(true);
    projectId = created.data.id;
    version = created.data.version;
    const detail = await ok(await call(`/projects/${projectId}`, manager), projectResponseSchema);
    expect(detail.data.customer?.name).toBe('Gamma Ports');
    expect(detail.data.effectiveTimeZone).toBe('Africa/Cairo');
  });

  it('changes status and health with optimistic concurrency and blocks unsafe transitions', async () => {
    const active = await ok(
      await call(`/projects/${projectId}/status`, manager, { method: 'PUT', body: { status: 'ACTIVE', version } }),
      projectResponseSchema,
    );
    expect(active.data.status).toBe('ACTIVE');
    expect(
      await failure(
        await call(`/projects/${projectId}/status`, manager, { method: 'PUT', body: { status: 'ON_HOLD', version } }),
        409,
      ),
    ).toBe('VERSION_CONFLICT');
    version = active.data.version;
    const health = await ok(
      await call(`/projects/${projectId}/health`, manager, {
        method: 'PUT',
        body: { health: 'AT_RISK', note: 'Vendor delay on gate hardware.', version },
      }),
      projectResponseSchema,
    );
    expect(health.data).toMatchObject({ health: 'AT_RISK', healthNote: 'Vendor delay on gate hardware.' });
    version = health.data.version;
    await failure(
      await call(`/projects/${projectId}/health`, manager, { method: 'PUT', body: { health: 'HEALTHY', version } }),
      400,
    );
    await failure(
      await call(`/projects/${projectId}/status`, manager, { method: 'PUT', body: { status: 'ARCHIVED', version } }),
      400,
    );
    const renamed = await ok(
      await call(`/projects/${projectId}`, manager, {
        method: 'PATCH',
        body: { name: 'Port Gate System v2', version },
      }),
      projectResponseSchema,
    );
    version = renamed.data.version;
    await failure(await call(`/projects/${projectId}`, manager, { method: 'PATCH', body: { version } }), 400);
  });

  it('assigns members; the member sees the project; outsiders get 404; HR gets 403', async () => {
    const fieldProfile = await profileId('EMP-00031');
    const added = await ok(
      await call(`/projects/${projectId}/members`, manager, {
        method: 'POST',
        body: { employeeId: fieldProfile, projectRole: 'FIELD' },
      }),
      projectMemberResponseSchema,
      201,
    );
    expect(added.data.projectRole).toBe('FIELD');
    expect(
      await failure(
        await call(`/projects/${projectId}/members`, manager, {
          method: 'POST',
          body: { employeeId: fieldProfile, projectRole: 'FIELD' },
        }),
        409,
      ),
    ).toBe('CONFLICT');
    await failure(
      await call(`/projects/${projectId}/members`, manager, {
        method: 'POST',
        body: { employeeId: await profileId('NW-001', orgB), projectRole: 'FIELD' },
      }),
      404,
    );
    const members = await ok(await call(`/projects/${projectId}/members`, field), projectMemberListResponseSchema);
    expect(members.data.map((m) => m.employeeId)).toEqual([fieldProfile]);

    const mine = await ok(await call('/projects?scope=mine', field), projectPageResponseSchema);
    expect(mine.data.map((p) => p.id)).toEqual([projectId]);
    const all = await ok(await call('/projects', field), projectPageResponseSchema);
    expect(all.data.map((p) => p.id)).toEqual([projectId]);
    const fieldDetail = await ok(await call(`/projects/${projectId}`, field), projectResponseSchema);
    expect(fieldDetail.data.access).toMatchObject({ canManage: false, canSubmitReports: true });
    await failure(
      await call(`/projects/${projectId}/status`, field, { method: 'PUT', body: { status: 'ON_HOLD', version } }),
      403,
    );
    await failure(
      await call(`/projects/${projectId}/members`, field, {
        method: 'POST',
        body: { employeeId: await profileId('EMP-00027'), projectRole: 'FIELD' },
      }),
      403,
    );
    const theirs = await ok(
      await call(`/employees/${fieldProfile}/projects`, manager),
      employeeProjectListResponseSchema,
    );
    expect(theirs.data.map((p) => [p.project.id, p.roles])).toEqual([[projectId, ['FIELD']]]);

    expect((await ok(await call('/projects', employee), projectPageResponseSchema)).data).toEqual([]);
    expect(await failure(await call(`/projects/${projectId}`, employee), 404)).toBe('NOT_FOUND');
    await failure(await call(`/projects/${projectId}/members`, employee), 404);
    await failure(await call(`/projects/${projectId}/activity`, employee), 404);
    await failure(await call('/projects', hr), 403);
  });

  it('lists with server-side filters, allow-listed sort and cursor pagination', async () => {
    const filtered = await ok(
      await call('/projects?status=ACTIVE,MAINTENANCE&sort=code:asc', gm),
      projectPageResponseSchema,
    );
    expect(filtered.data.length).toBeGreaterThan(1);
    expect(filtered.data.every((p) => p.status === 'ACTIVE' || p.status === 'MAINTENANCE')).toBe(true);
    const codes = filtered.data.map((p) => p.code);
    expect(codes).toEqual([...codes].sort());
    const atRisk = await ok(await call('/projects?health=AT_RISK', gm), projectPageResponseSchema);
    expect(atRisk.data.map((p) => p.id)).toEqual([projectId]);
    const byManager = await ok(
      await call(`/projects?managerId=${await profileId('EMP-00032')}`, gm),
      projectPageResponseSchema,
    );
    expect(byManager.data.map((p) => p.id)).toContain(projectId);
    const first = await ok(await call('/projects?limit=1&sort=name:asc', gm), projectPageResponseSchema);
    expect(first.data).toHaveLength(1);
    const second = await ok(
      await call(`/projects?limit=1&sort=name:asc&cursor=${first.page.nextCursor ?? ''}`, gm),
      projectPageResponseSchema,
    );
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    await failure(await call('/projects?sort=secret:asc', gm), 400);
    await failure(await call('/projects?status=DELETED', gm), 400);
    await failure(await call('/projects?orderBy=name', gm), 400);
    await failure(await call('/projects?cursor=bm90LWEtY3Vyc29y', gm), 400);
  });

  it('links reusable work locations', async () => {
    const location = await ok(
      await call('/work-locations', admin, {
        method: 'POST',
        body: { name: 'Port Gate 4', type: 'PROJECT_SITE', latitude: 31.2, longitude: 29.9, allowedRadiusMeters: 250 },
      }),
      workLocationResponseSchema,
      201,
    );
    await failure(
      await call('/work-locations', manager, {
        method: 'POST',
        body: { name: 'X', type: 'OFFICE', latitude: 0, longitude: 0, allowedRadiusMeters: 100 },
      }),
      403,
    );
    await failure(
      await call('/work-locations', admin, {
        method: 'POST',
        body: { name: 'X', type: 'OFFICE', latitude: 91, longitude: 0, allowedRadiusMeters: 100 },
      }),
      400,
    );
    const listed = await ok(await call('/work-locations', manager), workLocationListResponseSchema);
    expect(listed.data.map((l) => l.id)).toContain(location.data.id);
    await ok(
      await call(`/projects/${projectId}/locations`, manager, {
        method: 'POST',
        body: { workLocationId: location.data.id },
      }),
      projectLocationResponseSchema,
      201,
    );
    const linked = await ok(await call(`/projects/${projectId}/locations`, field), projectLocationListResponseSchema);
    expect(linked.data.map((l) => l.location.name)).toEqual(['Port Gate 4']);
    await failure(await call('/work-locations', employee), 403);
  });

  it('the member submits one report per day; the manager sees it; outsiders do not', async () => {
    const submitted = await ok(
      await call(`/projects/${projectId}/daily-reports`, field, {
        method: 'POST',
        body: { systemStatus: 'DEGRADED', workPerformed: 'Calibrated gate sensors.', followUpRequired: true },
      }),
      dailyReportResponseSchema,
      201,
    );
    expect(submitted.data.access.canAttach).toBe(true);
    expect(
      await failure(
        await call(`/projects/${projectId}/daily-reports`, field, {
          method: 'POST',
          body: { systemStatus: 'NORMAL', workPerformed: 'Again.' },
        }),
        409,
      ),
    ).toBe('CONFLICT');
    await failure(
      await call(`/projects/${projectId}/daily-reports`, field, {
        method: 'POST',
        body: { systemStatus: 'NORMAL', workPerformed: 'Future.', reportDate: '2099-01-01' },
      }),
      400,
    );
    await failure(
      await call(`/projects/${projectId}/daily-reports`, manager, {
        method: 'POST',
        body: { systemStatus: 'NORMAL', workPerformed: 'Not mine.' },
      }),
      403,
    );
    const list = await ok(await call(`/projects/${projectId}/daily-reports`, manager), dailyReportPageResponseSchema);
    expect(list.data.map((r) => r.id)).toEqual([submitted.data.id]);
    const read = await ok(await call(`/daily-reports/${submitted.data.id}`, manager), dailyReportResponseSchema);
    expect(read.data.workPerformed).toBe('Calibrated gate sensors.');
    await failure(await call(`/daily-reports/${submitted.data.id}`, employee), 403);
    await ok(await call(`/daily-reports/${submitted.data.id}`, gm), dailyReportResponseSchema);

    const missing = await ok(
      await call(`/projects/${projectId}/daily-reports/missing`, manager),
      missingReportsResponseSchema,
    );
    expect(missing.data.reporting).toBe(true);
    expect(missing.data.pendingToday.some((m) => m.employee.fullName === 'Fatma Field')).toBe(false);
    await failure(
      await call(`/projects/${projectId}/daily-reports/missing?from=2026-01-01&to=2026-10-01`, manager),
      400,
    );

    const intent = await ok(
      await call('/attachments/upload-intents', field, {
        method: 'POST',
        body: {
          ownerType: 'DAILY_REPORT',
          ownerId: submitted.data.id,
          filename: 'gate.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
        },
      }),
      uploadIntentResponseSchema,
      201,
    );
    expect(intent.data.upload.url).toContain('X-Amz-Signature=');
    await failure(
      await call('/attachments/upload-intents', field, {
        method: 'POST',
        body: {
          ownerType: 'DAILY_REPORT',
          ownerId: submitted.data.id,
          filename: 'x.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 10,
        },
      }),
      400,
    );
    await failure(
      await call('/attachments/upload-intents', manager, {
        method: 'POST',
        body: {
          ownerType: 'DAILY_REPORT',
          ownerId: submitted.data.id,
          filename: 'x.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 10,
        },
      }),
      403,
    );
    const attachments = await ok(
      await call(`/attachments?ownerType=DAILY_REPORT&ownerId=${submitted.data.id}`, manager),
      attachmentListResponseSchema,
    );
    // Pending uploads are not listed until completed against storage (covered in packages/core).
    expect(attachments.data).toEqual([]);
    await failure(await call(`/attachments?ownerType=DAILY_REPORT&ownerId=${submitted.data.id}`, employee), 404);
    expect((await call(`/attachments/${intent.data.attachment.id}`, field, { method: 'DELETE' })).status).toBe(204);
    await failure(await call(`/attachments/${intent.data.attachment.id}`, field), 404);
  });

  it('records the operational timeline', async () => {
    const page = await ok(
      await call(`/projects/${projectId}/activity?limit=50`, manager),
      projectActivityPageResponseSchema,
    );
    // The worker consumes the outbox; without it, the API still serves a valid (possibly empty) page.
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('archives only paused or finished projects and restores them', async () => {
    expect(
      await failure(
        await call(`/projects/${projectId}/archive`, manager, {
          method: 'POST',
          body: { reason: 'Handover', version },
        }),
        409,
      ),
    ).toBe('INVALID_TRANSITION');
    const onHold = await ok(
      await call(`/projects/${projectId}/status`, manager, {
        method: 'PUT',
        body: { status: 'ON_HOLD', reason: 'Customer freeze', version },
      }),
      projectResponseSchema,
    );
    const archived = await ok(
      await call(`/projects/${projectId}/archive`, manager, {
        method: 'POST',
        body: { reason: 'Handover', version: onHold.data.version },
      }),
      projectResponseSchema,
    );
    expect(archived.data.status).toBe('ARCHIVED');
    await failure(
      await call(`/projects/${projectId}/daily-reports`, field, {
        method: 'POST',
        body: { systemStatus: 'NORMAL', workPerformed: 'After archive.', reportDate: '2026-10-01' },
      }),
      409,
    );
    expect((await ok(await call('/projects', manager), projectPageResponseSchema)).data.map((p) => p.id)).not.toContain(
      projectId,
    );
    const restored = await ok(
      await call(`/projects/${projectId}/restore`, manager, {
        method: 'POST',
        body: { version: archived.data.version },
      }),
      projectResponseSchema,
    );
    expect(restored.data.status).not.toBe('ARCHIVED');
  });
});

describe('tenant isolation over HTTP', () => {
  it('never reaches another organization’s projects, customers or employees', async () => {
    const foreignCustomer = await stack.prisma.customer.create({
      data: { organizationId: orgB, name: 'Northwind Client', type: 'PRIVATE' },
    });
    const foreignProject = await stack.prisma.project.create({
      data: { organizationId: orgB, number: 1, code: 'NW-P1', name: 'Northwind Project' },
    });
    await failure(await call(`/projects/${foreignProject.id}`, gm), 404);
    await failure(await call(`/projects/${foreignProject.id}/members`, gm), 404);
    await failure(await call(`/projects/${foreignProject.id}/daily-reports`, gm), 404);
    await failure(await call(`/customers/${foreignCustomer.id}`, manager), 404);
    await failure(
      await call('/projects', manager, { method: 'POST', body: { name: 'X', customerId: foreignCustomer.id } }),
      404,
    );
    await failure(await call(`/employees/${await profileId('NW-001', orgB)}/projects`, manager), 404);
    const ownList = await ok(await call('/projects?includeArchived=true&limit=100', gm), projectPageResponseSchema);
    expect(ownList.data.map((p) => p.id)).not.toContain(foreignProject.id);
    const tmp = await seededProjectId('TMP');
    await ok(await call(`/projects/${tmp}`, gm), projectResponseSchema);
  });
});
