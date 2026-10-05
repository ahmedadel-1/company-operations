import { describe, expect, it } from 'vitest';

import {
  auditEventListQuerySchema,
  createEmployeeRequestSchema,
  createUploadIntentRequestSchema,
  employeeListQuerySchema,
  notificationRequestedPayloadSchema,
  structureListQuerySchema,
  updateEmployeeRequestSchema,
  updateOrganizationRequestSchema,
} from '../src/index.js';

const uuid = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('people contracts', () => {
  it('accepts a minimal employee and rejects unknown fields (no mass assignment)', () => {
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'Ada' }).success).toBe(true);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'Ada', organizationId: uuid }).success).toBe(false);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'Ada', memberStatus: 'ACTIVE' }).success).toBe(false);
  });

  it('validates references, dates, emails and phone formats', () => {
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'A', departmentId: 'not-a-uuid' }).success).toBe(false);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'A', joinDate: '2026-13-01' }).success).toBe(false);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'A', workEmail: 'nope' }).success).toBe(false);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'A', phone: '<script>' }).success).toBe(false);
    expect(createEmployeeRequestSchema.safeParse({ fullName: 'A', employeeNumber: '../x' }).success).toBe(false);
  });

  it('accepts partial updates and rejects empty ones', () => {
    expect(updateEmployeeRequestSchema.safeParse({ phone: '+1 555 0100' }).success).toBe(true);
    expect(updateEmployeeRequestSchema.safeParse({ employmentStatus: 'ON_LEAVE' }).success).toBe(true);
    expect(updateEmployeeRequestSchema.safeParse({ fullName: '' }).success).toBe(false);
    expect(updateEmployeeRequestSchema.safeParse({}).success).toBe(false);
    expect(updateOrganizationRequestSchema.safeParse({}).success).toBe(false);
    expect(updateOrganizationRequestSchema.safeParse({ workWeek: [0] }).success).toBe(false);
  });

  it('bounds list queries and parses boolean flags strictly', () => {
    expect(employeeListQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    expect(employeeListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(employeeListQuerySchema.safeParse({ cursor: 'a b' }).success).toBe(false);
    expect(structureListQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
    expect(structureListQuerySchema.safeParse({ includeArchived: '1' }).success).toBe(false);
  });
});

describe('audit contracts', () => {
  it('requires from < to and well-formed action filters', () => {
    expect(
      auditEventListQuerySchema.safeParse({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(auditEventListQuerySchema.safeParse({ action: "role.granted' OR 1=1" }).success).toBe(false);
    expect(auditEventListQuerySchema.safeParse({ actionPrefix: 'role.' }).success).toBe(true);
  });
});

describe('attachment contracts', () => {
  it('only allows owner types with a policy and bare MIME types', () => {
    const base = { ownerId: uuid, filename: 'a.png', contentType: 'image/png', sizeBytes: 10 };
    expect(createUploadIntentRequestSchema.safeParse({ ...base, ownerType: 'EMPLOYEE_AVATAR' }).success).toBe(true);
    expect(createUploadIntentRequestSchema.safeParse({ ...base, ownerType: 'SUPPORT_TICKET' }).success).toBe(true);
    expect(createUploadIntentRequestSchema.safeParse({ ...base, ownerType: 'SUPPORT_COMMENT' }).success).toBe(false);
    expect(createUploadIntentRequestSchema.safeParse({ ...base, ownerType: 'REQUEST' }).success).toBe(true);
    expect(
      createUploadIntentRequestSchema.safeParse({
        ...base,
        ownerType: 'EMPLOYEE_AVATAR',
        contentType: 'text/html; charset=utf-8',
      }).success,
    ).toBe(false);
    expect(
      createUploadIntentRequestSchema.safeParse({ ...base, ownerType: 'EMPLOYEE_AVATAR', sizeBytes: 0 }).success,
    ).toBe(false);
  });
});

describe('job payload contracts', () => {
  it('validates notification requests strictly', () => {
    const payload = {
      recipientMemberId: uuid,
      type: 'ROLE_GRANTED',
      severity: 'INFO',
      entityType: 'role',
      entityId: null,
      params: { roleName: 'Support agent' },
      dedupeKey: 'role.granted:1',
    };
    expect(notificationRequestedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(notificationRequestedPayloadSchema.safeParse({ ...payload, type: 'lower' }).success).toBe(false);
    expect(notificationRequestedPayloadSchema.safeParse({ ...payload, params: { nested: { a: 1 } } }).success).toBe(
      false,
    );
    expect(notificationRequestedPayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  });
});
