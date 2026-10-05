import { randomBytes, randomUUID } from 'node:crypto';

import { Queue, QueueEvents, Worker } from 'bullmq';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AsyncLocalTenantContext,
  AttachmentService,
  createPrismaClient,
  createTenantScopedClient,
  DISABLED_EMAIL,
  enqueueOutboxEvent,
  NO_REALTIME,
  NO_SCAN,
  NotificationDeliveryService,
  notificationEntityAccess,
  NotificationWriter,
  outboxJobId,
  QUEUE_NAMES,
  seedDemoData,
} from '@company-ops/core';
import type { PrismaClient, QueueName, StoragePort } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';
import { redisConnectionOptions } from '@company-ops/shared';

import { OutboxRelay } from '../src/outbox/outbox-relay.js';
import { expirePendingAttachments } from '../src/processors/maintenance/expire-attachments.js';
import { handleNotificationJob } from '../src/processors/notifications/notification-job.js';
import type { NotificationJobDeps } from '../src/processors/notifications/notification-job.js';

/**
 * Outbox -> BullMQ -> notifications consumer with real PostgreSQL 18 and Redis 8 (same images as
 * Compose). Proves transactional delivery, deterministic job ids (no duplicates on re-relay),
 * idempotent consumption, retry and permanent-failure behaviour, and tenant binding by the
 * event's own organization.
 */
const REDIS_IMAGE = 'redis:8.10.2@sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee';
const ISSUER = 'http://127.0.0.1:9/realms/company-ops';
const MAX_ATTEMPTS = 2;

let db: TestDatabase;
let redis: StartedTestContainer;
let redisUrl: string;
let prisma: PrismaClient;
let queues: Map<QueueName, Queue>;
let relay: OutboxRelay;
let orgA: string;
let orgB: string;
let employeeMemberId: string;
let foreignMemberId: string;
const tenant = new AsyncLocalTenantContext();

function jobDeps(writer: NotificationWriter): NotificationJobDeps {
  const db = createTenantScopedClient(prisma, tenant);
  return {
    tenant,
    db,
    writer,
    delivery: new NotificationDeliveryService(
      db,
      tenant,
      DISABLED_EMAIL,
      'http://localhost:3000',
      'localhost',
      notificationEntityAccess(db),
    ),
    realtime: NO_REALTIME,
    onRealtimeError: () => undefined,
  };
}

const notification = (recipientMemberId: string, dedupeKey: string) => ({
  eventType: 'notification.requested' as const,
  aggregateType: 'member',
  aggregateId: recipientMemberId,
  payload: {
    recipientMemberId,
    type: 'ROLE_GRANTED',
    severity: 'INFO' as const,
    entityType: 'role',
    entityId: null,
    params: { roleName: 'Support agent' },
    dedupeKey,
  },
});

async function drain(queue: Queue, expected: { completed: number; failed: number }): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const counts = await queue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed');
    if ((counts.completed ?? 0) >= expected.completed && (counts.failed ?? 0) >= expected.failed) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Queue ${queue.name} did not settle: ${JSON.stringify(await queue.getJobCounts())}`);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await db.migrate();
  const password = randomBytes(16).toString('hex');
  redis = await new GenericContainer(REDIS_IMAGE)
    .withCommand(['redis-server', '--requirepass', password])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  const url = new URL(`redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`);
  url.password = password;
  redisUrl = url.toString();
  prisma = createPrismaClient(db.appUrl);
  const report = await seedDemoData(prisma, ISSUER);
  orgA = report.organizationId;
  orgB = report.secondOrganizationId;
  employeeMemberId = (
    await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgA, user: { idpSubject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04' } },
    })
  ).id;
  foreignMemberId = (await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: orgB } })).id;
  queues = new Map(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: redisConnectionOptions(redisUrl) })]),
  );
  relay = new OutboxRelay(
    prisma,
    (name) => {
      const queue = queues.get(name);
      if (queue === undefined) {
        throw new Error(`no queue ${name}`);
      }
      return queue;
    },
    { batchSize: 50, leaseMs: 30_000, maxAttempts: MAX_ATTEMPTS, jobAttempts: 3 },
  );
  // Events created by the seed itself are not part of these scenarios (the app role cannot delete).
  await prisma.outboxEvent.updateMany({ data: { dispatchedAt: new Date() } });
}, 300_000);

afterAll(async () => {
  await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.stop();
  await db.stop();
});

describe('outbox relay', () => {
  it('relays each committed event exactly once per job id, even when re-relayed after a crash', async () => {
    const eventId = await prisma.$transaction((tx) =>
      enqueueOutboxEvent(tx, orgA, notification(employeeMemberId, 'e2e:1')),
    );
    // A rolled-back business change leaves no event behind.
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(tx, orgA, notification(employeeMemberId, 'e2e:rolled-back'));
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');

    expect(await relay.relayBatch()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    // Simulate a relay that queued the job but crashed before marking the event dispatched.
    await prisma.outboxEvent.update({ where: { id: eventId }, data: { dispatchedAt: null, availableAt: new Date(0) } });
    expect(await relay.relayBatch()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });

    const notifications = queues.get('notifications');
    const job = await notifications?.getJob(outboxJobId(eventId));
    expect(job?.data).toMatchObject({ eventId, organizationId: orgA, eventType: 'notification.requested' });
    expect(await notifications?.count()).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: employeeMemberId } })).toBe(1);
  });

  it('retries an event without a route with backoff, then leaves it permanently failed', async () => {
    const event = await prisma.outboxEvent.create({
      data: { organizationId: orgA, eventType: 'unknown.type', aggregateType: 'test', payload: {} },
    });
    expect((await relay.relayBatch()).failed).toBe(1);
    let row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.lastError).toContain('No route');
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(0) } });
    expect((await relay.relayBatch()).failed).toBe(1);
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(0) } });
    expect((await relay.relayBatch()).claimed).toBe(0);
    row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.dispatchedAt).toBeNull();
  });
});

describe('notifications consumer', () => {
  it('creates one notification per event, fails foreign recipients permanently, and is idempotent', async () => {
    const writer = new NotificationWriter(createTenantScopedClient(prisma, tenant), tenant);
    // Recipient from another organization, inside an orgA event: never resolvable in orgA.
    const foreignEvent = await prisma.$transaction((tx) =>
      enqueueOutboxEvent(tx, orgA, notification(foreignMemberId, 'e2e:foreign')),
    );
    await relay.relayBatch();

    const queue = queues.get('notifications');
    if (queue === undefined) {
      throw new Error('no notifications queue');
    }
    const worker = new Worker(queue.name, (job) => handleNotificationJob(job.name, job.data, jobDeps(writer)), {
      connection: redisConnectionOptions(redisUrl),
    });
    const events = new QueueEvents(queue.name, { connection: redisConnectionOptions(redisUrl) });
    try {
      await drain(queue, { completed: 1, failed: 1 });
    } finally {
      await worker.close();
      await events.close();
    }

    expect(
      await prisma.notification.count({ where: { organizationId: orgA, recipientMemberId: employeeMemberId } }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { recipientMemberId: foreignMemberId } })).toBe(0);
    const failed = await queue.getJob(outboxJobId(foreignEvent));
    expect(await failed?.getState()).toBe('failed');
    // UnrecoverableError: no further attempts despite `attempts: 3`.
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toContain('not a member');

    // Re-delivering a processed job is a no-op.
    const done = (await queue.getCompleted())[0];
    await expect(handleNotificationJob(done?.name ?? '', done?.data, jobDeps(writer))).resolves.toMatchObject({
      kind: 'notification',
      result: { kind: 'duplicate' },
    });
    expect(
      await prisma.notification.count({ where: { organizationId: orgA, recipientMemberId: employeeMemberId } }),
    ).toBe(1);
  });

  it('binds the tenant from the event organization, so a payload cannot target another tenant', async () => {
    const writer = new NotificationWriter(createTenantScopedClient(prisma, tenant), tenant);
    // An orgB-scoped job naming an orgA member is rejected (the recipient is looked up in orgB only).
    await expect(
      handleNotificationJob(
        'notification.create',
        {
          eventId: randomUUID(),
          organizationId: orgB,
          eventType: 'notification.requested',
          payload: notification(employeeMemberId, 'e2e:cross').payload,
        },
        jobDeps(writer),
      ),
    ).rejects.toThrow('not a member');
    expect(await prisma.notification.count({ where: { organizationId: orgB } })).toBe(0);
  });
});

describe('maintenance', () => {
  it('expires abandoned upload intents per organization and removes their objects', async () => {
    const owner = await prisma.employeeProfile.findFirstOrThrow({ where: { organizationId: orgA } });
    const key = `org/${orgA}/employee-avatar/${randomUUID()}`;
    const stale = await prisma.attachment.create({
      data: {
        organizationId: orgA,
        ownerType: 'EMPLOYEE_AVATAR',
        ownerId: owner.id,
        storageKey: key,
        originalFilename: 'a.png',
        declaredContentType: 'image/png',
        declaredSizeBytes: 10,
        uploadedByMemberId: owner.memberId,
        uploadExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const deleted: string[] = [];
    // Recording port: the S3 adapter itself is covered against SeaweedFS in packages/core.
    const storage: StoragePort = {
      presignUpload: () => Promise.reject(new Error('unused')),
      presignDownload: () => Promise.reject(new Error('unused')),
      head: () => Promise.resolve(null),
      read: () => Promise.reject(new Error('unused')),
      delete: (k) => {
        deleted.push(k);
        return Promise.resolve();
      },
    };
    const attachments = new AttachmentService(createTenantScopedClient(prisma, tenant), tenant, storage, [], NO_SCAN);
    expect(await expirePendingAttachments({ prisma, tenant, attachments })).toBe(1);
    expect(deleted).toEqual([key]);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.status).toBe('DELETED');
    expect(
      await prisma.auditLog.count({
        where: { organizationId: orgA, action: 'attachment.expired', entityId: stale.id },
      }),
    ).toBe(1);
    expect(await expirePendingAttachments({ prisma, tenant, attachments })).toBe(0);
  });
});
