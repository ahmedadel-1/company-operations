import { randomBytes, randomUUID } from 'node:crypto';

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AsyncLocalTenantContext,
  createPrismaClient,
  createTenantScopedClient,
  loadMemberAccess,
  NotificationDeliveryService,
  notificationEntityAccess,
  NotificationWriter,
  QUEUE_NAMES,
  seedDemoData,
  TicketCommentService,
  TicketService,
  userChannel,
} from '@company-ops/core';
import type { ActionContext, EmailChannel, PrismaClient, QueueName, TenantScopedClient } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';
import { redisConnectionOptions } from '@company-ops/shared';

import { loadWorkerEnv } from '../src/config/worker-env.js';
import { createEmailChannel, messageIdHost } from '../src/email/smtp-email-channel.js';
import { OutboxRelay } from '../src/outbox/outbox-relay.js';
import { handleNotificationJob } from '../src/processors/notifications/notification-job.js';
import type { NotificationJobDeps } from '../src/processors/notifications/notification-job.js';
import { sweepSlas } from '../src/processors/sla/sla-sweep-job.js';
import { RedisRealtimePublisher } from '../src/realtime/redis-realtime-publisher.js';

/**
 * Support side effects end to end with real PostgreSQL 18, Redis 8 and Mailpit (same images as
 * Compose): outbox -> notifications -> email delivery over SMTP, deduplication, SMTP failure and
 * retry, internal-note secrecy in email, tenant-scoped real-time hints and the SLA sweep job.
 */
const REDIS_IMAGE = 'redis:8.10.2@sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
const ISSUER = 'http://127.0.0.1:9/realms/company-ops';
const PUBLIC_URL = 'http://ops.localhost.test:3000';

interface MailpitSummary {
  readonly ID: string;
  readonly MessageID: string;
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
  expect(messageIdHost(env)).toBe('ops.localhost.test');
  email = createEmailChannel(env);
  expect(email.enabled).toBe(true);
  publisher = new Redis(redisUrl);
  subscriber = new Redis(redisUrl);
  await subscriber.psubscribe(`rt:org:${orgId}:*`);
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

describe('support email and real-time delivery', () => {
  it('emails the assignee once through SMTP, records the delivery and hints live views', async () => {
    const agent = await actionFor('EMP-00040');
    const reporter = await actionFor('EMP-00004');
    const assignee = await actionFor('EMP-00019');
    const tickets = new TicketService(tenantDb, tenant);
    const description = `Secret description ${randomUUID()}`;
    const ticket = await as(reporter, () =>
      tickets.create(reporter, { title: 'Laptop will not boot', description, severity: 'HIGH', impact: 'SINGLE_USER' }),
    );
    const assigned = await as(agent, () =>
      tickets.assign(agent, ticket.id, ticket.version, { assigneeMemberId: assignee.principal.memberId }),
    );
    expect((await pump()).failed).toBe(0);

    const assigneeEmail = (
      await prisma.employeeProfile.findFirstOrThrow({ where: { organizationId: orgId, employeeNumber: 'EMP-00019' } })
    ).workEmail;
    const messages = (await mailbox()).filter((m) => m.To.some((to) => to.Address === assigneeEmail));
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.Subject).toBe(`[${assigned.key}] Assigned to you: Laptop will not boot`);
    const content = await messageText(message?.ID ?? '');
    expect(content).toContain(`${PUBLIC_URL}/support/tickets/${ticket.id}`);
    expect(content).not.toContain(description);

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { organizationId: orgId, notification: { entityId: ticket.id, type: 'SUPPORT_TICKET_ASSIGNED' } },
    });
    expect(delivery).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
    expect(message?.MessageID).toBe(`${delivery.id}@ops.localhost.test`);

    // Re-delivering the same email job sends nothing.
    const again = await handleNotificationJob(
      'notification.email.send',
      {
        eventId: randomUUID(),
        organizationId: orgId,
        eventType: 'notification.email.requested',
        payload: { deliveryId: delivery.id },
      },
      deps(),
    );
    expect(again).toEqual({ kind: 'email', outcome: 'already_sent' });
    expect((await mailbox()).filter((m) => m.To.some((to) => to.Address === assigneeEmail))).toHaveLength(1);

    // Live hints: identifiers only, on the organization's user channels.
    const assigneeChannel = userChannel(orgId, assignee.principal.userId);
    const hints = received.filter((r) => r.channel === assigneeChannel).map((r) => JSON.parse(r.message) as unknown);
    expect(hints).toEqual(
      expect.arrayContaining([
        { type: 'support.ticket.changed', entityType: 'support_ticket', entityId: ticket.id },
        expect.objectContaining({ type: 'notification.created', entityType: 'notification' }),
      ]),
    );
    expect(received.every((r) => r.channel.startsWith(`rt:org:${orgId}:`))).toBe(true);
    expect(received.some((r) => r.message.includes(description))).toBe(false);
  });

  it('never emails internal notes and tells the reporter only about public replies', async () => {
    const agent = await actionFor('EMP-00040');
    const reporter = await actionFor('EMP-00004');
    const tickets = new TicketService(tenantDb, tenant);
    const comments = new TicketCommentService(tenantDb, tenant);
    const secret = `internal ${randomUUID()}`;
    const reply = `public ${randomUUID()}`;
    const ticket = await as(reporter, () =>
      tickets.create(reporter, {
        title: 'VPN drops',
        description: 'VPN drops hourly.',
        severity: 'LOW',
        impact: 'SINGLE_USER',
      }),
    );
    await as(agent, () => comments.add(agent, ticket.id, { body: secret, visibility: 'INTERNAL_NOTE' }));
    await as(agent, () => comments.add(agent, ticket.id, { body: reply, visibility: 'PUBLIC_INTERNAL' }));
    expect((await pump()).failed).toBe(0);

    const all = await mailbox();
    for (const message of all) {
      const content = await messageText(message.ID);
      expect(content).not.toContain(secret);
      expect(content).not.toContain(reply);
    }
    const reporterEmail = (
      await prisma.employeeProfile.findFirstOrThrow({ where: { organizationId: orgId, employeeNumber: 'EMP-00004' } })
    ).workEmail;
    const toReporter = all.filter((m) => m.To.some((to) => to.Address === reporterEmail));
    expect(toReporter.map((m) => m.Subject)).toEqual([`[SUP-${String(ticket.number)}] New reply: VPN drops`]);
  });

  it('records an SMTP failure, retries, and sends exactly once when SMTP recovers', async () => {
    const agent = await actionFor('EMP-00040');
    const reporter = await actionFor('EMP-00004');
    const assignee = await actionFor('EMP-00020');
    const tickets = new TicketService(tenantDb, tenant);
    const ticket = await as(reporter, () =>
      tickets.create(reporter, {
        title: 'Monitor flickers',
        description: 'Flickers.',
        severity: 'LOW',
        impact: 'SINGLE_USER',
      }),
    );
    await as(agent, () =>
      tickets.assign(agent, ticket.id, ticket.version, { assigneeMemberId: assignee.principal.memberId }),
    );
    const broken: EmailChannel = {
      enabled: true,
      send: () => Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' })),
    };
    expect((await pump(broken)).failed).toBeGreaterThanOrEqual(1);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { organizationId: orgId, notification: { entityId: ticket.id, type: 'SUPPORT_TICKET_ASSIGNED' } },
    });
    expect(delivery).toMatchObject({ status: 'FAILED', lastError: 'Error ECONNREFUSED' });
    // The failed job stays visible in BullMQ for operators.
    const failedJobs = await queues.get('notifications')?.getFailed();
    expect(failedJobs?.some((job) => job.name === 'notification.email.send')).toBe(true);

    const retry = await handleNotificationJob(
      'notification.email.send',
      {
        eventId: randomUUID(),
        organizationId: orgId,
        eventType: 'notification.email.requested',
        payload: { deliveryId: delivery.id },
      },
      deps(),
    );
    expect(retry).toEqual({ kind: 'email', outcome: 'sent' });
    const sent = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(sent).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
  });

  it('suppresses a queued email when the recipient lost access to the ticket, once and without retrying', async () => {
    const agent = await actionFor('EMP-00040');
    const reporter = await actionFor('EMP-00004');
    const assignee = await actionFor('EMP-00030');
    const tickets = new TicketService(tenantDb, tenant);
    const title = `Badge reader offline ${randomUUID()}`;
    const ticket = await as(reporter, () =>
      tickets.create(reporter, { title, description: 'Door 3.', severity: 'LOW', impact: 'SINGLE_USER' }),
    );
    await as(agent, () =>
      tickets.assign(agent, ticket.id, ticket.version, { assigneeMemberId: assignee.principal.memberId }),
    );
    const unavailable: EmailChannel = {
      enabled: true,
      send: () => Promise.reject(Object.assign(new Error('down'), { code: 'ETIMEDOUT' })),
    };
    expect((await pump(unavailable)).failed).toBeGreaterThanOrEqual(1);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { organizationId: orgId, notification: { entityId: ticket.id, type: 'SUPPORT_TICKET_ASSIGNED' } },
    });
    expect(delivery.status).toBe('FAILED');

    // The assignee's support role is revoked while the email waits for its retry.
    await prisma.memberRole.deleteMany({ where: { organizationId: orgId, memberId: assignee.principal.memberId } });
    const job = {
      eventId: randomUUID(),
      organizationId: orgId,
      eventType: 'notification.email.requested',
      payload: { deliveryId: delivery.id },
    };
    expect(await handleNotificationJob('notification.email.send', job, deps())).toEqual({
      kind: 'email',
      outcome: 'suppressed_not_authorized',
    });
    const suppressed = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(suppressed).toMatchObject({ status: 'SUPPRESSED', lastError: 'recipient_not_authorized', sentAt: null });
    expect(suppressed.lastError).not.toContain(title);
    // Terminal: a later attempt neither sends nor changes the record.
    expect(await handleNotificationJob('notification.email.send', job, deps())).toEqual({
      kind: 'email',
      outcome: 'already_sent',
    });
    const assigneeEmail = (
      await prisma.employeeProfile.findFirstOrThrow({ where: { organizationId: orgId, employeeNumber: 'EMP-00030' } })
    ).workEmail;
    expect(
      (await mailbox()).some((m) => m.To.some((to) => to.Address === assigneeEmail) && m.Subject.includes(title)),
    ).toBe(false);
  });

  it('runs the SLA sweep job per organization and escalates overdue critical tickets once', async () => {
    const reporter = await actionFor('EMP-00024');
    const started = new Date(Date.now() - 3 * 3_600_000);
    const tickets = new TicketService(tenantDb, tenant, () => started);
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: orgId, code: 'TMP' } });
    const ticket = await as(reporter, () =>
      tickets.create(reporter, {
        title: 'Signals dark',
        description: 'Traffic signals dark at junction 4.',
        severity: 'CRITICAL',
        impact: 'SITE',
        projectId: project.id,
      }),
    );
    const errors: unknown[] = [];
    const run = () =>
      sweepSlas({ prisma, db: tenantDb, tenant, onOrganizationError: (_org, error) => errors.push(error) }, new Date());
    const first = await run();
    expect(errors).toEqual([]);
    expect(first.organizations).toBeGreaterThanOrEqual(1);
    expect(first.escalations).toBeGreaterThanOrEqual(1);
    const second = await run();
    expect(second.escalations).toBe(0);
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.escalationLevel).toBe(1);
    expect(row.firstResponseSlaState).toBe('BREACHED');
  });
});
