import { randomBytes, randomUUID } from 'node:crypto';

import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApprovalService,
  AsyncLocalTenantContext,
  createPrismaClient,
  createTenantScopedClient,
  loadMemberAccess,
  NotificationDeliveryService,
  notificationEntityAccess,
  NotificationWriter,
  QUEUE_NAMES,
  RequestService,
  seedDemoData,
  userChannel,
} from '@company-ops/core';
import type { ActionContext, EmailChannel, PrismaClient, QueueName, TenantScopedClient } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';
import { redisConnectionOptions } from '@company-ops/shared';

import { loadWorkerEnv } from '../src/config/worker-env.js';
import { createEmailChannel } from '../src/email/smtp-email-channel.js';
import { OutboxRelay } from '../src/outbox/outbox-relay.js';
import { handleNotificationJob } from '../src/processors/notifications/notification-job.js';
import type { NotificationJobDeps } from '../src/processors/notifications/notification-job.js';
import {
  handleRequestJob,
  REQUEST_EFFECT_RECORDED_JOB,
  REQUEST_SLA_SWEEP_JOB,
} from '../src/processors/requests/request-jobs.js';
import { RedisRealtimePublisher } from '../src/realtime/redis-realtime-publisher.js';

/**
 * Request side effects end to end with real PostgreSQL 18, Redis 8 and Mailpit (same images as
 * Compose): outbox -> notifications -> email over SMTP without form contents, deduplication, the
 * recipient re-check before sending, identifier-only real-time hints, the approval reminder sweep and
 * the trusted Phase 7 effect boundary.
 */
const REDIS_IMAGE = 'redis:8.10.2@sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
const ISSUER = 'http://127.0.0.1:9/realms/company-ops';
const PUBLIC_URL = 'http://ops.localhost.test:3000';

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

let db: TestDatabase;
let redis: StartedTestContainer;
let mailpit: StartedTestContainer;
let redisUrl: string;
let mailpitUrl: string;
let prisma: PrismaClient;
let tenantDb: TenantScopedClient;
let queues: Map<QueueName, Queue>;
let relay: OutboxRelay;
let publisher: Redis;
let subscriber: Redis;
let email: EmailChannel;
let orgId: string;
let foreignOrgId: string;
let requests: RequestService;
let approvals: ApprovalService;
const tenant = new AsyncLocalTenantContext();
const received: { channel: string; message: string }[] = [];

async function actionFor(employeeNumber: string): Promise<ActionContext> {
  const profile = await prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId: orgId, employeeNumber },
    select: { memberId: true },
  });
  const access = await tenant.run({ organizationId: orgId, memberId: null, userId: null }, () =>
    loadMemberAccess(tenantDb, orgId, [profile.memberId]),
  );
  const member = access.get(profile.memberId);
  if (member === undefined) throw new Error(`${employeeNumber} is not an active member`);
  return { principal: member.principal, request: { requestId: `test-${employeeNumber}` } };
}

const as = <T>(action: ActionContext, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.run(
    { organizationId: orgId, memberId: action.principal.memberId, userId: action.principal.userId },
    async () => await fn(),
  );

function deps(channel: EmailChannel = email): NotificationJobDeps {
  return {
    tenant,
    db: tenantDb,
    writer: new NotificationWriter(tenantDb, tenant),
    delivery: new NotificationDeliveryService(
      tenantDb,
      tenant,
      channel,
      PUBLIC_URL,
      'ops.localhost.test',
      notificationEntityAccess(tenantDb),
    ),
    realtime: new RedisRealtimePublisher(publisher),
    onRealtimeError: (error) => {
      throw error;
    },
  };
}

/** Relays the outbox and processes notification jobs until both are idle. */
async function pump(channel: EmailChannel = email): Promise<{ failed: number }> {
  const queue = queues.get('notifications');
  if (queue === undefined) throw new Error('no notifications queue');
  let failed = 0;
  const worker = new Worker(queue.name, (job) => handleNotificationJob(job.name, job.data, deps(channel)), {
    connection: redisConnectionOptions(redisUrl),
    autorun: false,
  });
  worker.on('failed', () => {
    failed += 1;
  });
  void worker.run();
  try {
    for (let round = 0; round < 60; round += 1) {
      const relayed = await relay.relayBatch();
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      const pending = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (relayed.claimed === 0 && pending === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    await worker.close();
  }
  return { failed };
}

async function mailbox(): Promise<MailpitSummary[]> {
  const response = await fetch(`${mailpitUrl}/api/v1/messages?limit=500`);
  const body = (await response.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

async function messageText(id: string): Promise<string> {
  const response = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  const body = (await response.json()) as { Text: string; HTML: string };
  return `${body.Text}\n${body.HTML}`;
}

async function workEmail(employeeNumber: string): Promise<string> {
  const row = await prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId: orgId, employeeNumber },
    select: { workEmail: true },
  });
  if (row.workEmail === null) throw new Error(`${employeeNumber} has no work email`);
  return row.workEmail;
}

async function typeId(key: string): Promise<string> {
  const row = await prisma.requestType.findFirstOrThrow({
    where: { organizationId: orgId, key },
    select: { id: true },
  });
  return row.id;
}

/** Submits a work-from-home request (direct manager approval, REMOTE attendance effect). */
async function submitWfh(requester: ActionContext, start: string, end: string, reason: string) {
  const requestTypeId = await typeId('work_from_home');
  return as(requester, () =>
    requests.create(requester, { requestTypeId, formData: { dates: { start, end }, reason }, submit: true }, undefined),
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await db.migrate();
  const password = randomBytes(16).toString('hex');
  [redis, mailpit] = await Promise.all([
    new GenericContainer(REDIS_IMAGE)
      .withCommand(['redis-server', '--requirepass', password])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
    new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025).forStatusCode(200))
      .start(),
  ]);
  const url = new URL(`redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`);
  url.password = password;
  redisUrl = url.toString();
  mailpitUrl = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;
  prisma = createPrismaClient(db.appUrl);
  tenantDb = createTenantScopedClient(prisma, tenant);
  orgId = (await seedDemoData(prisma, ISSUER)).organizationId;
  foreignOrgId = (await prisma.organization.findFirstOrThrow({ where: { id: { not: orgId } }, select: { id: true } }))
    .id;
  await prisma.outboxEvent.updateMany({ data: { dispatchedAt: new Date() } });
  queues = new Map(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: redisConnectionOptions(redisUrl) })]),
  );
  relay = new OutboxRelay(
    prisma,
    (name) => {
      const queue = queues.get(name);
      if (queue === undefined) throw new Error(`no queue ${name}`);
      return queue;
    },
    { batchSize: 100, leaseMs: 30_000, maxAttempts: 3, jobAttempts: 1 },
  );
  const env = loadWorkerEnv({
    DATABASE_URL: db.appUrl,
    REDIS_URL: redisUrl,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'unused-bucket',
    S3_ACCESS_KEY_ID: 'unused',
    S3_SECRET_ACCESS_KEY: 'unused',
    APP_PUBLIC_URL: PUBLIC_URL,
    SMTP_HOST: mailpit.getHost(),
    SMTP_PORT: String(mailpit.getMappedPort(1025)),
    SMTP_FROM: 'ops-test@localhost.test',
  });
  email = createEmailChannel(env);
  requests = new RequestService(tenantDb, tenant);
  approvals = new ApprovalService(tenantDb, tenant);
  publisher = new Redis(redisUrl);
  subscriber = new Redis(redisUrl);
  await subscriber.psubscribe('rt:org:*');
  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    received.push({ channel, message });
  });
}, 300_000);

afterAll(async () => {
  await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
  await Promise.allSettled([publisher.quit(), subscriber.quit()]);
  await prisma.$disconnect();
  await Promise.allSettled([redis.stop(), mailpit.stop()]);
  await db.stop();
});

describe('request notifications and real-time hints', () => {
  it('emails the frozen approver once without form contents and hints only the people involved', async () => {
    const requester = await actionFor('EMP-00009');
    const lead = await actionFor('EMP-00008');
    const secret = `Private reason ${randomUUID()}`;
    const created = await submitWfh(requester, '2027-04-05', '2027-04-06', secret);
    expect((await pump()).failed).toBe(0);

    const leadEmail = await workEmail('EMP-00008');
    const toLead = (await mailbox()).filter(
      (m) => m.To.some((to) => to.Address === leadEmail) && m.Subject.includes(created.key),
    );
    expect(toLead).toHaveLength(1);
    const text = await messageText(toLead[0]?.ID ?? '');
    expect(text).toContain(`${PUBLIC_URL}/requests/${created.id}`);
    expect(text).not.toContain(secret);

    // Re-relaying the same events creates no second notification or email.
    expect((await pump()).failed).toBe(0);
    expect(
      (await mailbox()).filter((m) => m.To.some((to) => to.Address === leadEmail) && m.Subject.includes(created.key)),
    ).toHaveLength(1);

    const leadChannel = userChannel(orgId, lead.principal.userId);
    const requesterChannel = userChannel(orgId, requester.principal.userId);
    const hint = { type: 'request.changed', entityType: 'request', entityId: created.id };
    const hintsOn = (channel: string) =>
      received.filter((r) => r.channel === channel).map((r) => JSON.parse(r.message) as unknown);
    expect(hintsOn(leadChannel)).toContainEqual(hint);
    expect(hintsOn(requesterChannel)).toContainEqual(hint);
    const colleague = await actionFor('EMP-00010');
    expect(hintsOn(userChannel(orgId, colleague.principal.userId))).not.toContainEqual(hint);
    expect(received.every((r) => r.channel.startsWith(`rt:org:${orgId}:`))).toBe(true);
    expect(received.some((r) => r.message.includes(secret))).toBe(false);
  });

  it('re-checks the recipient before sending and skips email for someone who left', async () => {
    const requester = await actionFor('EMP-00009');
    const created = await submitWfh(requester, '2027-05-03', '2027-05-04', 'Re-check');
    const unavailable: EmailChannel = {
      enabled: true,
      send: () => Promise.reject(Object.assign(new Error('down'), { code: 'ETIMEDOUT' })),
    };
    expect((await pump(unavailable)).failed).toBeGreaterThanOrEqual(1);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { organizationId: orgId, notification: { entityId: created.id, type: 'REQUEST_APPROVAL_ASSIGNED' } },
    });
    expect(delivery.status).toBe('FAILED');

    const lead = await actionFor('EMP-00008');
    await prisma.organizationMember.update({ where: { id: lead.principal.memberId }, data: { status: 'DISABLED' } });
    try {
      const job = {
        eventId: randomUUID(),
        organizationId: orgId,
        eventType: 'notification.email.requested',
        payload: { deliveryId: delivery.id },
      };
      expect(await handleNotificationJob('notification.email.send', job, deps())).toEqual({
        kind: 'email',
        outcome: 'skipped_inactive',
      });
      const skipped = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(skipped.sentAt).toBeNull();
      expect(skipped.status).not.toBe('SENT');
    } finally {
      await prisma.organizationMember.update({ where: { id: lead.principal.memberId }, data: { status: 'ACTIVE' } });
    }
  });
});

describe('requests queue', () => {
  it('reminds each overdue approver once per assignment', async () => {
    const requester = await actionFor('EMP-00009');
    const created = await submitWfh(requester, '2027-06-07', '2027-06-08', 'Reminder');
    const errors: unknown[] = [];
    const sweepDeps = {
      prisma,
      db: tenantDb,
      tenant,
      onOrganizationError: (_org: string, error: unknown) => errors.push(error),
    };
    const later = new Date(Date.now() + 3 * 24 * 3_600_000);
    const first = await handleRequestJob(REQUEST_SLA_SWEEP_JOB, {}, sweepDeps, later);
    expect(errors).toEqual([]);
    expect(first).toMatchObject({ kind: 'sweep', failedOrganizations: 0 });
    expect(first.kind === 'sweep' ? first.reminded : 0).toBeGreaterThanOrEqual(1);
    const second = await handleRequestJob(REQUEST_SLA_SWEEP_JOB, {}, sweepDeps, later);
    expect(second).toMatchObject({ kind: 'sweep', reminded: 0 });
    const reminders = await prisma.outboxEvent.findMany({
      where: { organizationId: orgId, eventType: 'notification.requested', aggregateId: created.id },
      select: { payload: true },
    });
    expect(
      reminders.filter((row) => (row.payload as { type?: unknown }).type === 'REQUEST_APPROVAL_OVERDUE'),
    ).toHaveLength(1);
  });

  it('hands a recorded effect to attendance only inside the event organization', async () => {
    const requester = await actionFor('EMP-00009');
    const lead = await actionFor('EMP-00008');
    const created = await submitWfh(requester, '2027-07-05', '2027-07-06', 'Effect');
    const approval = await prisma.requestApproval.findFirstOrThrow({
      where: { requestId: created.id, status: 'PENDING' },
      select: { id: true },
    });
    await as(lead, () => approvals.approve(lead, approval.id, undefined));
    const effect = await prisma.requestEffect.findFirstOrThrow({ where: { requestId: created.id } });
    expect(effect).toMatchObject({ kind: 'ATTENDANCE', mode: 'REMOTE', status: 'RECORDED' });
    const sweepDeps = { prisma, db: tenantDb, tenant, onOrganizationError: () => undefined };
    const job = (organizationId: string) => ({
      eventId: randomUUID(),
      organizationId,
      eventType: 'request.approved',
      payload: { requestId: created.id, effectId: effect.id },
    });
    // A future-dated effect materializes nothing yet; daily status derives from the effect itself.
    await expect(handleRequestJob(REQUEST_EFFECT_RECORDED_JOB, job(orgId), sweepDeps, new Date())).resolves.toEqual({
      kind: 'effect',
      effectId: effect.id,
      outcome: 'APPLIED',
      dates: 0,
    });
    // Re-delivery is harmless; a forged organization never reaches the effect.
    await expect(
      handleRequestJob(REQUEST_EFFECT_RECORDED_JOB, job(orgId), sweepDeps, new Date()),
    ).resolves.toMatchObject({ outcome: 'APPLIED', dates: 0 });
    await expect(
      handleRequestJob(REQUEST_EFFECT_RECORDED_JOB, job(foreignOrgId), sweepDeps, new Date()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      handleRequestJob(
        REQUEST_EFFECT_RECORDED_JOB,
        { ...job(orgId), eventType: 'request.effect.revoked' },
        sweepDeps,
        new Date(),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
