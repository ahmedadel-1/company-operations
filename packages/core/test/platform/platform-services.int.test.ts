import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkspaceEnvFile, parseEnv, storageEnvSchema } from '@company-ops/config';

import { AttachmentService } from '../../src/modules/attachments/attachment.service.js';
import { AuditQueryService } from '../../src/modules/audit/audit-query.service.js';
import { NotificationService, NotificationWriter } from '../../src/modules/notifications/notification.service.js';
import { bootstrapOrganization } from '../../src/modules/organizations/bootstrap-organization.js';
import { EmployeeAvatarPolicy } from '../../src/modules/people/employee-avatar.policy.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { InvitationRedemptionService } from '../../src/modules/people/invitation-redemption.service.js';
import {
  claimOutboxEvents,
  markOutboxEventDispatched,
  markOutboxEventFailed,
} from '../../src/platform/db/sql/outbox.js';
import {
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  TenantIsolationError,
} from '../../src/platform/errors.js';
import { enqueueOutboxEvent } from '../../src/platform/outbox/outbox.js';
import type { NotificationRequestedPayload } from '../../src/platform/outbox/outbox.js';
import { S3Storage } from '../../src/platform/storage/s3-storage.js';
import { NO_SCAN } from '../../src/platform/storage/storage-port.js';
import type { AttachmentScanner } from '../../src/platform/storage/storage-port.js';
import { startSeededDatabase, TEST_ISSUER } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';
import { DEMO_EMPLOYEES } from '../../src/dev-seed/demo-people.js';

/**
 * Audit read API, notifications, outbox relay primitives, attachments (against the configured
 * S3 endpoint, SeaweedFS in development) and the first-run bootstrap, on a real PostgreSQL.
 * Requires the development infrastructure: `pnpm infra:up`.
 */
loadWorkspaceEnvFile(import.meta.dirname);
const storageEnv = parseEnv('storage', storageEnvSchema, process.env);

let s: SeededDatabase;
let storage: S3Storage;
let employees: EmployeeService;

// 1x1 transparent PNG.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

const attachmentsWith = (scanner: AttachmentScanner = NO_SCAN) =>
  new AttachmentService(s.tenantDb, s.tenant, storage, [new EmployeeAvatarPolicy(employees)], scanner);

beforeAll(async () => {
  s = await startSeededDatabase();
  employees = new EmployeeService(s.tenantDb, s.tenant);
  storage = new S3Storage({
    endpoint: storageEnv.S3_ENDPOINT,
    region: storageEnv.S3_REGION,
    bucket: storageEnv.S3_BUCKET,
    accessKeyId: storageEnv.S3_ACCESS_KEY_ID,
    secretAccessKey: storageEnv.S3_SECRET_ACCESS_KEY,
    forcePathStyle: storageEnv.S3_FORCE_PATH_STYLE,
  });
}, 240_000);

afterAll(async () => {
  storage.destroy();
  await s.stop();
});

describe('audit read API', () => {
  it('requires audit.view at ORG scope', async () => {
    const audit = new AuditQueryService(s.tenantDb, s.tenant);
    const hr = await s.actionFor('EMP-00003');
    await expect(s.as(hr, () => audit.list(hr, {}))).rejects.toBeInstanceOf(ForbiddenError);
    const gm = await s.actionFor('EMP-00002');
    const page = await s.as(gm, () => audit.list(gm, { limit: 5 }));
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
  });

  it('is tenant-scoped: northwind rows never appear and foreign ids are 404', async () => {
    const audit = new AuditQueryService(s.tenantDb, s.tenant);
    const gm = await s.actionFor('EMP-00002');
    const foreign = await s.prisma.auditLog.findFirstOrThrow({ where: { organizationId: s.northwindId } });
    await expect(s.as(gm, () => audit.get(gm, foreign.id))).rejects.toBeInstanceOf(NotFoundError);
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.as(gm, () => audit.list(gm, { limit: 100, cursor }));
      all.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(all.length).toBe(await s.prisma.auditLog.count({ where: { organizationId: s.demoId } }));
    expect(new Set(all).size).toBe(all.length);
    const northwindIds = new Set(
      (await s.prisma.auditLog.findMany({ where: { organizationId: s.northwindId }, select: { id: true } })).map(
        (r) => r.id,
      ),
    );
    expect(all.some((id) => northwindIds.has(id))).toBe(false);
  });

  it('filters by action, prefix, entity and time window; rejects malformed cursors', async () => {
    const audit = new AuditQueryService(s.tenantDb, s.tenant);
    const gm = await s.actionFor('EMP-00002');
    const created = await s.as(gm, () => audit.list(gm, { action: 'member.created', limit: 100 }));
    expect(created.items.length).toBe(DEMO_EMPLOYEES.length);
    expect(created.items.every((item) => item.action === 'member.created')).toBe(true);
    const roles = await s.as(gm, () => audit.list(gm, { actionPrefix: 'role.', limit: 100 }));
    expect(roles.items.every((item) => item.action.startsWith('role.'))).toBe(true);
    const future = await s.as(gm, () => audit.list(gm, { from: new Date(Date.now() + 60_000).toISOString() }));
    expect(future.items).toHaveLength(0);
    await expect(s.as(gm, () => audit.list(gm, { cursor: 'garbage' }))).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('platform audit logs are not reachable through the tenant-scoped client', async () => {
    const gm = await s.actionFor('EMP-00002');
    await expect(s.as(gm, () => s.tenantDb.platformAuditLog.findMany())).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe('notifications', () => {
  const request = (recipientMemberId: string, dedupeKey: string): NotificationRequestedPayload => ({
    recipientMemberId,
    type: 'ROLE_GRANTED',
    severity: 'INFO',
    entityType: 'role',
    entityId: null,
    params: { roleName: 'Support agent' },
    dedupeKey,
  });

  it('the writer is idempotent by dedupe key under a system tenant context', async () => {
    const writer = new NotificationWriter(s.tenantDb, s.tenant);
    const recipient = await s.employee('EMP-00004');
    const first = await s.asSystem(s.demoId, () => writer.create(request(recipient.memberId, 'k-1')));
    const second = await s.asSystem(s.demoId, () => writer.create(request(recipient.memberId, 'k-1')));
    expect(first.kind).toBe('created');
    expect(second).toEqual({
      kind: 'duplicate',
      notificationId: first.kind === 'recipient_not_found' ? '' : first.notificationId,
      recipientUserId: first.kind === 'recipient_not_found' ? '' : first.recipientUserId,
    });
    expect(
      await s.prisma.notification.count({ where: { organizationId: s.demoId, recipientMemberId: recipient.memberId } }),
    ).toBe(1);
  });

  it('a recipient from another organization is never written (event organization binds the context)', async () => {
    const writer = new NotificationWriter(s.tenantDb, s.tenant);
    const foreign = await s.employee('NW-002', s.northwindId);
    expect(await s.asSystem(s.demoId, () => writer.create(request(foreign.memberId, 'k-x')))).toEqual({
      kind: 'recipient_not_found',
    });
  });

  it('members only see and mark their own notifications', async () => {
    const service = new NotificationService(s.tenantDb, s.tenant);
    const writer = new NotificationWriter(s.tenantDb, s.tenant);
    const owner = await s.actionFor('EMP-00004');
    const other = await s.actionFor('EMP-00009');
    await s.asSystem(s.demoId, () => writer.create(request(owner.principal.memberId, 'k-2')));
    const page = await s.as(owner, () => service.list(owner, {}));
    expect(page.items).toHaveLength(2);
    expect(await s.as(owner, () => service.unreadCount(owner))).toBe(2);
    const target = page.items[0]?.id ?? '';
    await expect(s.as(other, () => service.markRead(other, target))).rejects.toBeInstanceOf(NotFoundError);
    expect((await s.as(other, () => service.list(other, {}))).items).toHaveLength(0);
    const read = await s.as(owner, () => service.markRead(owner, target));
    expect(read.readAt).not.toBeNull();
    expect(await s.as(owner, () => service.markAllRead(owner))).toBe(1);
    expect(await s.as(owner, () => service.unreadCount(owner))).toBe(0);
  });

  it('member-scoped services refuse a system context', async () => {
    const service = new NotificationService(s.tenantDb, s.tenant);
    const owner = await s.actionFor('EMP-00004');
    await expect(s.asSystem(s.demoId, () => service.list(owner, {}))).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe('outbox relay primitives', () => {
  it('commits events atomically with the business change', async () => {
    const recipient = await s.employee('EMP-00010');
    await expect(
      s.prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(tx, s.demoId, {
          eventType: 'notification.requested',
          aggregateType: 'member',
          aggregateId: recipient.memberId,
          payload: {
            recipientMemberId: recipient.memberId,
            type: 'ROLE_GRANTED',
            severity: 'INFO',
            entityType: null,
            entityId: null,
            params: {},
            dedupeKey: 'rolled-back',
          },
        });
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');
    expect(await s.prisma.outboxEvent.count({ where: { aggregateId: recipient.memberId } })).toBe(0);
  });

  it('concurrent relays never claim the same event; leases and attempts are tracked', async () => {
    const seeded = await s.prisma.outboxEvent.count({ where: { dispatchedAt: null } });
    for (const [organizationId, number] of [
      [s.demoId, 'EMP-00011'],
      [s.northwindId, 'NW-003'],
      [s.demoId, 'EMP-00014'],
    ] as const) {
      const recipient = await s.employee(number, organizationId);
      await enqueueOutboxEvent(s.prisma, organizationId, {
        eventType: 'notification.requested',
        aggregateType: 'member',
        aggregateId: recipient.memberId,
        payload: {
          recipientMemberId: recipient.memberId,
          type: 'ROLE_GRANTED',
          severity: 'INFO',
          entityType: null,
          entityId: null,
          params: {},
          dedupeKey: `relay-${number}`,
        },
      });
    }
    const pending = await s.prisma.outboxEvent.count({ where: { dispatchedAt: null } });
    expect(pending).toBe(seeded + 3);
    const [a, b] = await Promise.all([
      claimOutboxEvents(s.prisma, { limit: 100, leaseMs: 60_000, maxAttempts: 5 }),
      claimOutboxEvents(s.prisma, { limit: 100, leaseMs: 60_000, maxAttempts: 5 }),
    ]);
    const claimed = [...a, ...b];
    expect(claimed).toHaveLength(pending);
    expect(new Set(claimed.map((e) => e.id)).size).toBe(pending);
    expect(claimed.every((e) => e.attempts === 1)).toBe(true);
    // Leased: nothing is due again until the lease expires.
    expect(await claimOutboxEvents(s.prisma, { limit: 100, leaseMs: 60_000, maxAttempts: 5 })).toHaveLength(0);

    const [first, second] = claimed;
    if (first === undefined || second === undefined) throw new Error('expected two events');
    const third = claimed[2];
    if (third === undefined) throw new Error('expected three events');
    // Every update is bound to the event's own organization: a mismatched pair changes nothing.
    const wrongOrganization = first.organizationId === s.demoId ? s.northwindId : s.demoId;
    await markOutboxEventDispatched(s.prisma, { id: first.id, organizationId: wrongOrganization });
    expect((await s.prisma.outboxEvent.findUniqueOrThrow({ where: { id: first.id } })).dispatchedAt).toBeNull();
    await markOutboxEventDispatched(s.prisma, first);
    await markOutboxEventDispatched(s.prisma, third);
    await markOutboxEventFailed(s.prisma, second, 'queue unavailable', 0);
    const retried = await claimOutboxEvents(s.prisma, { limit: 100, leaseMs: 60_000, maxAttempts: 2 });
    expect(retried.map((e) => e.id)).toEqual([second.id]);
    expect(retried[0]?.attempts).toBe(2);
    await markOutboxEventFailed(s.prisma, second, 'queue unavailable', 0);
    // Out of attempts: permanently failed, never claimed again.
    expect(await claimOutboxEvents(s.prisma, { limit: 100, leaseMs: 60_000, maxAttempts: 2 })).toHaveLength(0);
    const failed = await s.prisma.outboxEvent.findUniqueOrThrow({ where: { id: second.id } });
    expect(failed).toMatchObject({ attempts: 2, lastError: 'queue unavailable', dispatchedAt: null });
    const dispatched = await s.prisma.outboxEvent.findUniqueOrThrow({ where: { id: first.id } });
    expect(dispatched.dispatchedAt).not.toBeNull();
  });
});

describe('attachments (S3 endpoint)', () => {
  const upload = async (url: string, contentType: string, body: Buffer) => {
    const response = await fetch(url, { method: 'PUT', body, headers: { 'content-type': contentType } });
    expect(response.status).toBe(200);
  };

  it('intent -> presigned PUT -> complete verifies bytes, then an authorized short-lived download', async () => {
    const attachments = attachmentsWith();
    const owner = await s.actionFor('EMP-00004');
    const profile = await s.employee('EMP-00004');
    const intent = await s.as(owner, () =>
      attachments.createUploadIntent(owner, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: profile.profileId,
        filename: '../../etc/<me>.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
      }),
    );
    expect(intent.attachment).toMatchObject({ status: 'PENDING_UPLOAD', filename: 'me.png' });
    expect(intent.attachment).not.toHaveProperty('storageKey');
    expect(new URL(intent.upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');

    await expect(s.as(owner, () => attachments.complete(owner, intent.attachment.id))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await upload(intent.upload.url, 'image/png', PNG);
    const done = await s.as(owner, () => attachments.complete(owner, intent.attachment.id));
    expect(done).toMatchObject({ status: 'AVAILABLE', contentType: 'image/png', sizeBytes: PNG.byteLength });
    expect(done.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const row = await s.prisma.attachment.findUniqueOrThrow({ where: { id: done.id } });
    expect(row.storageKey.startsWith(`org/${s.demoId}/employee-avatar/`)).toBe(true);

    const viewer = await s.actionFor('EMP-00009');
    const url = await s.as(viewer, () => attachments.downloadUrl(viewer, done.id));
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60');
    const response = await fetch(url);
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, entityId: done.id, action: 'attachment.downloaded' },
      }),
    ).toBe(1);

    await s.as(owner, () => employees.setAvatar(owner, profile.profileId, done.id));
    const withAvatar = await s.as(owner, () => employees.getOwn(owner));
    expect(withAvatar?.hasAvatar).toBe(true);
  });

  it('retires replaced and cleared photos so they can no longer be listed or downloaded', async () => {
    const attachments = attachmentsWith();
    const owner = await s.actionFor('EMP-00005');
    const profile = await s.employee('EMP-00005');
    const viewer = await s.actionFor('EMP-00009');
    const uploadPhoto = async () => {
      const intent = await s.as(owner, () =>
        attachments.createUploadIntent(owner, {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: profile.profileId,
          filename: 'me.png',
          contentType: 'image/png',
          sizeBytes: PNG.byteLength,
        }),
      );
      await upload(intent.upload.url, 'image/png', PNG);
      return (await s.as(owner, () => attachments.complete(owner, intent.attachment.id))).id;
    };
    const objectDeletions = (attachmentId: string) =>
      s.prisma.outboxEvent.count({
        where: { organizationId: s.demoId, eventType: 'attachment.object.delete', aggregateId: attachmentId },
      });

    const first = await uploadPhoto();
    await s.as(owner, () => employees.setAvatar(owner, profile.profileId, first));
    await expect(
      s.as(viewer, () => attachments.listForOwner(viewer, 'EMPLOYEE_AVATAR', profile.profileId)),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const second = await uploadPhoto();
    await s.as(owner, () => employees.setAvatar(owner, profile.profileId, second));
    expect((await s.prisma.attachment.findUniqueOrThrow({ where: { id: first } })).status).toBe('DELETED');
    expect(await objectDeletions(first)).toBe(1);
    await expect(s.as(viewer, () => attachments.downloadUrl(viewer, first))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(viewer, () => attachments.downloadUrl(viewer, second))).resolves.toContain('X-Amz-Expires=60');

    // Setting the same photo again retires nothing.
    await s.as(owner, () => employees.setAvatar(owner, profile.profileId, second));
    expect((await s.prisma.attachment.findUniqueOrThrow({ where: { id: second } })).status).toBe('AVAILABLE');

    await s.as(owner, () => employees.setAvatar(owner, profile.profileId, null));
    expect((await s.prisma.attachment.findUniqueOrThrow({ where: { id: second } })).status).toBe('DELETED');
    expect(await objectDeletions(second)).toBe(1);
    await expect(s.as(viewer, () => attachments.downloadUrl(viewer, second))).rejects.toBeInstanceOf(NotFoundError);
    const stored = await s.prisma.attachment.findUniqueOrThrow({ where: { id: second } });
    await s.tenant.run({ organizationId: s.demoId, memberId: null, userId: null }, () =>
      attachments.deleteStoredObject(second),
    );
    expect(await storage.head(stored.storageKey)).toBeNull();
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, action: 'attachment.deleted', entityId: { in: [first, second] } },
      }),
    ).toBe(2);
  });

  it('rejects disguised content (magic bytes), size mismatches and disallowed types', async () => {
    const attachments = attachmentsWith();
    const owner = await s.actionFor('EMP-00004');
    const profile = await s.employee('EMP-00004');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const disguised = await s.as(owner, () =>
      attachments.createUploadIntent(owner, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: profile.profileId,
        filename: 'cat.png',
        contentType: 'image/png',
        sizeBytes: html.byteLength,
      }),
    );
    await upload(disguised.upload.url, 'image/png', html);
    const rejected = await s.as(owner, () => attachments.complete(owner, disguised.attachment.id));
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'unrecognized_content' });
    const stored = await s.prisma.attachment.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(await storage.head(stored.storageKey)).toBeNull();

    const wrongSize = await s.as(owner, () =>
      attachments.createUploadIntent(owner, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: profile.profileId,
        filename: 'a.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength + 10,
      }),
    );
    await upload(wrongSize.upload.url, 'image/png', PNG);
    expect(await s.as(owner, () => attachments.complete(owner, wrongSize.attachment.id))).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'size_mismatch',
    });
    await expect(
      s.as(owner, () =>
        attachments.createUploadIntent(owner, {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: profile.profileId,
          filename: 'a.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 10,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(owner, () =>
        attachments.createUploadIntent(owner, {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: profile.profileId,
          filename: 'big.png',
          contentType: 'image/png',
          sizeBytes: 6 * 1024 * 1024,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('the scan hook can reject an upload', async () => {
    const attachments = attachmentsWith({ scan: () => Promise.resolve('INFECTED') });
    const owner = await s.actionFor('EMP-00004');
    const profile = await s.employee('EMP-00004');
    const intent = await s.as(owner, () =>
      attachments.createUploadIntent(owner, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: profile.profileId,
        filename: 'x.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
      }),
    );
    await upload(intent.upload.url, 'image/png', PNG);
    expect(await s.as(owner, () => attachments.complete(owner, intent.attachment.id))).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'infected',
    });
  });

  it('owner authorization, uploader-only completion and cross-tenant access', async () => {
    const attachments = attachmentsWith();
    const employee = await s.actionFor('EMP-00004');
    const colleague = await s.employee('EMP-00009');
    await expect(
      s.as(employee, () =>
        attachments.createUploadIntent(employee, {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: colleague.profileId,
          filename: 'x.png',
          contentType: 'image/png',
          sizeBytes: 10,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const foreignOwner = await s.employee('NW-002', s.northwindId);
    await expect(
      s.as(employee, () =>
        attachments.createUploadIntent(employee, {
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: foreignOwner.profileId,
          filename: 'x.png',
          contentType: 'image/png',
          sizeBytes: 10,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const available = await s.prisma.attachment.findFirstOrThrow({
      where: { organizationId: s.demoId, status: 'AVAILABLE' },
    });
    const outsider = await s.actionFor('NW-002', s.northwindId);
    await expect(s.as(outsider, () => attachments.get(outsider, available.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(outsider, () => attachments.downloadUrl(outsider, available.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const other = await s.actionFor('EMP-00009');
    const pending = await s.as(employee, async () =>
      attachments.createUploadIntent(employee, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: (await s.employee('EMP-00004')).profileId,
        filename: 'y.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
      }),
    );
    await expect(s.as(other, () => attachments.complete(other, pending.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('expired pending uploads are cleaned up under a system context', async () => {
    const attachments = attachmentsWith();
    const owner = await s.actionFor('EMP-00004');
    const intent = await s.as(owner, async () =>
      attachments.createUploadIntent(owner, {
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: (await s.employee('EMP-00004')).profileId,
        filename: 'late.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
      }),
    );
    await upload(intent.upload.url, 'image/png', PNG);
    expect(await s.asSystem(s.demoId, () => attachments.expirePendingUpload(intent.attachment.id))).toBe(false);
    await s.prisma.attachment.update({
      where: { id: intent.attachment.id },
      data: { uploadExpiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await s.asSystem(s.northwindId, () => attachments.expirePendingUpload(intent.attachment.id))).toBe(false);
    expect(await s.asSystem(s.demoId, () => attachments.expirePendingUpload(intent.attachment.id))).toBe(true);
    const row = await s.prisma.attachment.findUniqueOrThrow({ where: { id: intent.attachment.id } });
    expect(row.status).toBe('DELETED');
    expect(await storage.head(row.storageKey)).toBeNull();
  });
});

describe('first-run bootstrap', () => {
  const input = (reissueInvitation = false) => ({
    organization: {
      slug: 'acme',
      name: 'Acme',
      timeZone: 'Asia/Dubai',
      workWeek: [1, 2, 3, 4, 5],
      defaultLocale: 'en' as const,
    },
    admin: { fullName: 'Ada Admin', workEmail: 'ada@acme.test', employeeNumber: 'ADMIN-1' },
    reissueInvitation,
  });

  it('creates the organization and one admin invitation, idempotently, and audits it', async () => {
    const first = await bootstrapOrganization(s.prisma, input());
    if (first.kind !== 'invited') throw new Error(`unexpected ${first.kind}`);
    expect(first.organizationCreated).toBe(true);
    const again = await bootstrapOrganization(s.prisma, input());
    expect(again).toEqual({
      kind: 'invitation_pending',
      organizationId: first.organizationId,
      memberId: first.memberId,
    });
    const reissued = await bootstrapOrganization(s.prisma, input(true));
    if (reissued.kind !== 'invited') throw new Error(`unexpected ${reissued.kind}`);
    expect(reissued.memberId).toBe(first.memberId);
    expect(await s.prisma.organization.count({ where: { slug: 'acme' } })).toBe(1);
    expect(await s.prisma.organizationMember.count({ where: { organizationId: first.organizationId } })).toBe(1);
    expect(await s.prisma.role.count({ where: { organizationId: first.organizationId } })).toBe(10);

    const redemption = new InvitationRedemptionService(s.prisma);
    const user = await s.prisma.user.create({
      data: { idpIssuer: TEST_ISSUER, idpSubject: 'ada-subject', displayName: 'Ada' },
    });
    expect(await redemption.redeem(first.invitation.token, user.id, {})).toEqual({ kind: 'invalid' });
    expect((await redemption.redeem(reissued.invitation.token, user.id, {})).kind).toBe('accepted');
    expect(await bootstrapOrganization(s.prisma, input(true))).toEqual({
      kind: 'already_bootstrapped',
      organizationId: first.organizationId,
    });
    expect(
      await s.prisma.platformAuditLog.count({
        where: { targetOrganizationId: first.organizationId, action: { startsWith: 'platform.organization.' } },
      }),
    ).toBe(3);
    const roles = await s.prisma.memberRole.findMany({
      where: { organizationId: first.organizationId, memberId: first.memberId },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.key)).toEqual(['ORG_ADMIN']);
  });
});
