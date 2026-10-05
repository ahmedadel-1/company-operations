import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AsyncLocalTenantContext, createTenantScopedClient, NotificationWriter } from '@company-ops/core';
import {
  attachmentResponseSchema,
  auditEventPageResponseSchema,
  auditEventResponseSchema,
  createEmployeeResponseSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  employeePageResponseSchema,
  employeeResponseSchema,
  errorEnvelopeSchema,
  failedJobListResponseSchema,
  invitationResponseSchema,
  jobTitleListResponseSchema,
  jobTitleResponseSchema,
  markAllReadResponseSchema,
  memberRoleListResponseSchema,
  notificationPageResponseSchema,
  notificationResponseSchema,
  organizationResponseSchema,
  ownProfileResponseSchema,
  roleListResponseSchema,
  teamListResponseSchema,
  teamMemberAddedResponseSchema,
  teamMemberListResponseSchema,
  teamResponseSchema,
  unreadCountResponseSchema,
  uploadIntentResponseSchema,
} from '@company-ops/validation';

import { createSession, PUBLIC_URL, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * Every Phase 1 endpoint over real HTTP, with each success body validated against the shared Zod
 * contract the OpenAPI document and the generated client are built from.
 */
const SUBJECT = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  hr: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
} as const;

let stack: ApiStack;
let orgA: string;
let admin: TestSession;
let hr: TestSession;
let employee: TestSession;

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

async function errorCode(response: Response): Promise<string> {
  return errorEnvelopeSchema.parse(await response.json()).error.code;
}

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  admin = await createSession(stack, SUBJECT.admin, orgA, { mfa: true });
  hr = await createSession(stack, SUBJECT.hr, orgA, { mfa: true });
  employee = await createSession(stack, SUBJECT.employee, orgA);
}, 300_000);

afterAll(async () => {
  await stack.stop();
});

describe('organization settings', () => {
  it('every member reads them; only org.settings.manage changes them', async () => {
    const read = await ok(await call('/organization', employee), organizationResponseSchema);
    expect(read.data.id).toBe(orgA);
    expect((await call('/organization', employee, { method: 'PATCH', body: { name: 'X' } })).status).toBe(403);
    const updated = await ok(
      await call('/organization', admin, { method: 'PATCH', body: { workWeek: [7, 1, 2, 3, 4] } }),
      organizationResponseSchema,
    );
    expect(updated.data.workWeek).toEqual([1, 2, 3, 4, 7]);
    const invalid = await call('/organization', admin, { method: 'PATCH', body: { timeZone: 'Mars/Base' } });
    expect(invalid.status).toBe(400);
  });
});

describe('employees', () => {
  it('lists with filters and cursor pagination', async () => {
    const first = await ok(await call('/employees?limit=10', hr), employeePageResponseSchema);
    expect(first.data).toHaveLength(10);
    expect(first.page.nextCursor).not.toBeNull();
    const second = await ok(
      await call(`/employees?limit=10&cursor=${first.page.nextCursor ?? ''}`, hr),
      employeePageResponseSchema,
    );
    expect(second.data.map((e) => e.id)).not.toContain(first.data[0]?.id);
    const search = await ok(await call('/employees?q=EMP-00003', hr), employeePageResponseSchema);
    expect(search.data.map((e) => e.employeeNumber)).toContain('EMP-00003');
    expect((await call('/employees?cursor=bm90LWEtY3Vyc29y', hr)).status).toBe(400);
  });

  it('creates, updates, disables and manages invitations (HR with MFA)', async () => {
    const created = await ok(
      await call('/employees', hr, {
        method: 'POST',
        body: { fullName: 'New Hire', workEmail: 'new.hire@example.test' },
      }),
      createEmployeeResponseSchema,
      201,
    );
    const id = created.data.employee.id;
    expect(created.data.employee.memberStatus).toBe('INVITED');
    expect(created.data.invitation.url.startsWith(`${PUBLIC_URL}/api/v1/auth/login?invitation=`)).toBe(true);

    const updated = await ok(
      await call(`/employees/${id}`, hr, {
        method: 'PATCH',
        body: { phone: '+1 555 0100', employmentType: 'CONTRACTOR' },
      }),
      employeeResponseSchema,
    );
    expect(updated.data.employmentType).toBe('CONTRACTOR');

    const reissued = await ok(
      await call(`/employees/${id}/invitation`, hr, { method: 'POST' }),
      invitationResponseSchema,
      201,
    );
    expect(reissued.data.url).not.toBe(created.data.invitation.url);
    // An invited member is not disabled but has the invitation revoked.
    expect((await call(`/employees/${id}/status`, hr, { method: 'PUT', body: { status: 'DISABLED' } })).status).toBe(
      409,
    );
    expect((await call(`/employees/${id}/invitation`, hr, { method: 'DELETE' })).status).toBe(204);

    const active = await stack.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: orgA, employeeNumber: 'EMP-00020' },
    });
    const disabled = await ok(
      await call(`/employees/${active.id}/status`, hr, { method: 'PUT', body: { status: 'DISABLED' } }),
      employeeResponseSchema,
    );
    expect(disabled.data.memberStatus).toBe('DISABLED');
    const enabled = await ok(
      await call(`/employees/${active.id}/status`, hr, { method: 'PUT', body: { status: 'ACTIVE' } }),
      employeeResponseSchema,
    );
    expect(enabled.data.memberStatus).toBe('ACTIVE');
    const audit = await stack.prisma.auditLog.findMany({ where: { organizationId: orgA, entityId: id } });
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['employee.created', 'employee.updated']));
  });

  it('own profile: read and change only self-service fields', async () => {
    const own = await ok(await call('/me/profile', employee), ownProfileResponseSchema);
    expect(own.data?.employeeNumber).toBe('EMP-00004');
    const changed = await ok(
      await call('/me/profile', employee, { method: 'PATCH', body: { locale: 'ar', timeZone: 'Asia/Riyadh' } }),
      employeeResponseSchema,
    );
    expect(changed.data.locale).toBe('ar');
    expect((await call('/me/profile', employee, { method: 'PATCH', body: { fullName: 'Self-promoted' } })).status).toBe(
      400,
    );
  });
});

describe('departments, teams and job titles', () => {
  it('manages the structure with department.manage and reads it with employee.view', async () => {
    const list = await ok(await call('/departments', employee), departmentListResponseSchema);
    expect(list.data.length).toBeGreaterThan(0);
    expect((await call('/departments', employee, { method: 'POST', body: { name: 'X', code: 'X' } })).status).toBe(403);

    const dept = await ok(
      await call('/departments', hr, { method: 'POST', body: { name: 'Research', code: 'RND' } }),
      departmentResponseSchema,
      201,
    );
    await ok(
      await call(`/departments/${dept.data.id}`, hr, { method: 'PATCH', body: { name: 'R&D' } }),
      departmentResponseSchema,
    );
    const archived = await ok(
      await call(`/departments/${dept.data.id}/archive`, hr, { method: 'POST' }),
      departmentResponseSchema,
    );
    expect(archived.data.archived).toBe(true);
    await ok(await call(`/departments/${dept.data.id}/unarchive`, hr, { method: 'POST' }), departmentResponseSchema);
    const cycle = await call(`/departments/${dept.data.id}`, hr, {
      method: 'PATCH',
      body: { parentDepartmentId: dept.data.id },
    });
    expect(cycle.status).toBe(400);

    const team = await ok(
      await call('/teams', hr, { method: 'POST', body: { name: 'Lab', departmentId: dept.data.id } }),
      teamResponseSchema,
      201,
    );
    const profile = await stack.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: orgA, employeeNumber: 'EMP-00010' },
    });
    const added = await ok(
      await call(`/teams/${team.data.id}/members/${profile.id}`, hr, { method: 'PUT' }),
      teamMemberAddedResponseSchema,
    );
    expect(added.data.created).toBe(true);
    const again = await ok(
      await call(`/teams/${team.data.id}/members/${profile.id}`, hr, { method: 'PUT' }),
      teamMemberAddedResponseSchema,
    );
    expect(again.data.created).toBe(false);
    const members = await ok(await call(`/teams/${team.data.id}/members`, employee), teamMemberListResponseSchema);
    expect(members.data.map((m) => m.employeeId)).toEqual([profile.id]);
    expect((await call(`/teams/${team.data.id}/members/${profile.id}`, hr, { method: 'DELETE' })).status).toBe(204);
    await ok(
      await call(`/teams/${team.data.id}`, hr, { method: 'PATCH', body: { name: 'Lab 2' } }),
      teamResponseSchema,
    );
    await ok(await call(`/teams/${team.data.id}/archive`, hr, { method: 'POST' }), teamResponseSchema);
    await ok(await call(`/teams/${team.data.id}/unarchive`, hr, { method: 'POST' }), teamResponseSchema);
    await ok(await call(`/teams/${team.data.id}`, employee), teamResponseSchema);
    await ok(await call('/teams?includeArchived=true', employee), teamListResponseSchema);

    const title = await ok(
      await call('/job-titles', hr, { method: 'POST', body: { name: 'Researcher' } }),
      jobTitleResponseSchema,
      201,
    );
    await ok(
      await call(`/job-titles/${title.data.id}`, hr, { method: 'PATCH', body: { archived: true } }),
      jobTitleResponseSchema,
    );
    const titles = await ok(await call('/job-titles?includeArchived=true', employee), jobTitleListResponseSchema);
    expect(titles.data.some((t) => t.id === title.data.id && t.archived)).toBe(true);
  });
});

describe('roles', () => {
  it('lists roles and member grants; grants and revokes with role.manage', async () => {
    const roles = await ok(await call('/roles', employee), roleListResponseSchema);
    const supportAgent = roles.data.find((r) => r.key === 'SUPPORT_AGENT');
    const orgAdmin = roles.data.find((r) => r.key === 'ORG_ADMIN');
    expect(orgAdmin?.administratorEquivalent).toBe(true);
    const member = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgA, user: { idpSubject: SUBJECT.gm } },
    });
    const granted = await call(`/members/${member.id}/roles`, admin, {
      method: 'POST',
      body: { roleId: supportAgent?.id },
    });
    expect(granted.status).toBe(200);
    const grants = await ok(await call(`/members/${member.id}/roles`, employee), memberRoleListResponseSchema);
    expect(grants.data.map((g) => g.key)).toContain('SUPPORT_AGENT');
    expect(
      (await call(`/members/${member.id}/roles/${supportAgent?.id ?? ''}`, admin, { method: 'DELETE' })).status,
    ).toBe(204);

    // Self-escalation and last-admin protection.
    const self = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgA, user: { idpSubject: SUBJECT.admin } },
    });
    const selfChange = await call(`/members/${self.id}/roles/${orgAdmin?.id ?? ''}`, admin, { method: 'DELETE' });
    expect(selfChange.status).toBe(403);
  });
});

describe('audit', () => {
  it('lists, filters and reads tenant audit events with audit.view', async () => {
    const page = await ok(await call('/audit/events?actionPrefix=role.&limit=5', admin), auditEventPageResponseSchema);
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((e) => e.action.startsWith('role.'))).toBe(true);
    const first = page.data[0];
    const one = await ok(await call(`/audit/events/${first?.id ?? ''}`, admin), auditEventResponseSchema);
    expect(one.data.id).toBe(first?.id);
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/token|secret|password/i);
    expect((await call('/audit/events', hr)).status).toBe(403);
    const bad = await call('/audit/events?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', admin);
    expect(bad.status).toBe(400);
  });

  it('exposes no audit write endpoint', async () => {
    const write = await call('/audit/events', admin, { method: 'POST', body: { action: 'x' } });
    expect(write.status).toBe(404);
    const first = await stack.prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgA } });
    expect((await call(`/audit/events/${first.id}`, admin, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('notifications', () => {
  it('lists, counts and marks the caller’s own notifications only', async () => {
    const member = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgA, user: { idpSubject: SUBJECT.employee } },
    });
    const tenant = new AsyncLocalTenantContext();
    const writer = new NotificationWriter(createTenantScopedClient(stack.prisma, tenant), tenant);
    await tenant.run({ organizationId: orgA, memberId: null, userId: null }, async () => {
      for (const key of ['a', 'b']) {
        await writer.create({
          recipientMemberId: member.id,
          type: 'ROLE_GRANTED',
          severity: 'INFO',
          entityType: 'role',
          entityId: null,
          params: { roleName: 'Support agent' },
          dedupeKey: `features-test:${key}`,
        });
      }
    });
    const count = await ok(await call('/notifications/unread-count', employee), unreadCountResponseSchema);
    expect(count.data.unread).toBeGreaterThanOrEqual(2);
    const list = await ok(await call('/notifications?unreadOnly=true', employee), notificationPageResponseSchema);
    const first = list.data[0];
    const read = await ok(
      await call(`/notifications/${first?.id ?? ''}/read`, employee, { method: 'POST' }),
      notificationResponseSchema,
    );
    expect(read.data.readAt).not.toBeNull();
    expect((await call(`/notifications/${first?.id ?? ''}/read`, hr, { method: 'POST' })).status).toBe(404);
    const all = await ok(
      await call('/notifications/read-all', employee, { method: 'POST' }),
      markAllReadResponseSchema,
    );
    expect(all.data.updated).toBeGreaterThanOrEqual(1);
    expect((await ok(await call('/notifications/unread-count', employee), unreadCountResponseSchema)).data.unread).toBe(
      0,
    );
  });
});

describe('attachments', () => {
  it('issues an upload intent with a pre-signed PUT and never exposes the storage key', async () => {
    const own = await ok(await call('/me/profile', employee), ownProfileResponseSchema);
    const intent = await ok(
      await call('/attachments/upload-intents', employee, {
        method: 'POST',
        body: {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: own.data?.id,
          filename: '../me.png',
          contentType: 'image/png',
          sizeBytes: 1024,
        },
      }),
      uploadIntentResponseSchema,
      201,
    );
    expect(intent.data.attachment.filename).toBe('me.png');
    expect(intent.data.upload.url).toContain('X-Amz-Signature=');
    expect(JSON.stringify(intent)).not.toContain('"storageKey"');
    const fetched = await ok(
      await call(`/attachments/${intent.data.attachment.id}`, employee),
      attachmentResponseSchema,
    );
    expect(fetched.data.status).toBe('PENDING_UPLOAD');
    // Not available yet: no download URL. (Completion against real storage is covered in packages/core.)
    expect((await call(`/attachments/${intent.data.attachment.id}/download-url`, employee)).status).toBe(404);
    // Only the uploader may complete; for anyone else the attachment does not exist.
    expect((await call(`/attachments/${intent.data.attachment.id}/complete`, hr, { method: 'POST' })).status).toBe(404);

    // Another employee's avatar: visible owner, but no upload rights.
    const other = await stack.prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: orgA, employeeNumber: 'EMP-00010' },
    });
    const forbidden = await call('/attachments/upload-intents', employee, {
      method: 'POST',
      body: {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: other.id,
        filename: 'x.png',
        contentType: 'image/png',
        sizeBytes: 10,
      },
    });
    expect(forbidden.status).toBe(403);
    const html = await call('/attachments/upload-intents', employee, {
      method: 'POST',
      body: {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: own.data?.id,
        filename: 'x.html',
        contentType: 'text/html',
        sizeBytes: 10,
      },
    });
    expect(html.status).toBe(400);
    expect(await errorCode(html)).toBe('VALIDATION_FAILED');
  });
});

describe('failed jobs', () => {
  it('shows failing outbox events of the active organization to org.settings.manage only', async () => {
    const event = await stack.prisma.outboxEvent.findFirstOrThrow({ where: { organizationId: orgA } });
    await stack.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { lastError: 'Queue unavailable', attempts: 3 },
    });
    const list = await ok(await call('/admin/failed-jobs', admin), failedJobListResponseSchema);
    const found = list.data.find((job) => job.id === event.id);
    expect(found).toMatchObject({ source: 'outbox', attempts: 3, error: 'Queue unavailable' });
    expect(JSON.stringify(list)).not.toContain('"payload"');
    expect((await call('/admin/failed-jobs', hr)).status).toBe(403);
  });
});
