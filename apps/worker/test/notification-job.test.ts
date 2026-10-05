import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { AsyncLocalTenantContext } from '@company-ops/core';
import type {
  NotificationDeliveryService,
  NotificationWriter,
  RealtimeEvent,
  RealtimePublisher,
  TenantScopedClient,
} from '@company-ops/core';

import { relayRetryDelayMs } from '../src/outbox/outbox-relay.js';
import {
  DASHBOARD_INVALIDATE_JOB,
  handleNotificationJob,
  NOTIFICATION_CREATE_JOB,
  NOTIFICATION_EMAIL_JOB,
} from '../src/processors/notifications/notification-job.js';
import type { NotificationJobDeps } from '../src/processors/notifications/notification-job.js';

const ORG = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const MEMBER = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const USER = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const DELIVERY = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61';

const payload = {
  recipientMemberId: MEMBER,
  type: 'ROLE_GRANTED',
  severity: 'INFO',
  entityType: 'role',
  entityId: null,
  params: { roleName: 'Support agent' },
  dedupeKey: 'role.granted:1',
};

const job = (overrides: Record<string, unknown> = {}) => ({
  eventId: '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
  organizationId: ORG,
  eventType: 'notification.requested',
  payload,
  ...overrides,
});

type WriteKind = 'created' | 'duplicate' | 'recipient_not_found';

/** Records the tenant context each call ran under and every real-time publish. */
function harness(kind: WriteKind = 'created', options: { publishFails?: boolean } = {}) {
  const tenant = new AsyncLocalTenantContext();
  const contexts: unknown[] = [];
  const published: { channel: string; event: RealtimeEvent }[] = [];
  const realtimeErrors: unknown[] = [];
  const writer = {
    create: () => {
      contexts.push(tenant.get());
      return Promise.resolve(
        kind === 'recipient_not_found' ? { kind } : { kind, notificationId: 'n1', recipientUserId: USER },
      );
    },
  } as unknown as NotificationWriter;
  const delivery = {
    send: (deliveryId: string) => {
      contexts.push(tenant.get());
      return Promise.resolve(deliveryId === DELIVERY ? 'sent' : 'not_found');
    },
  } as unknown as NotificationDeliveryService;
  const realtime: RealtimePublisher = {
    publish: (channel, event) => {
      if (options.publishFails === true) {
        return Promise.reject(new Error('redis down'));
      }
      published.push({ channel, event });
      return Promise.resolve();
    },
  };
  const deps: NotificationJobDeps = {
    tenant,
    db: {} as TenantScopedClient,
    writer,
    delivery,
    realtime,
    onRealtimeError: (error) => realtimeErrors.push(error),
  };
  return { deps, tenant, contexts, published, realtimeErrors };
}

describe('handleNotificationJob', () => {
  it('runs the write in a system context of the event organization and hints the recipient', async () => {
    const { deps, tenant, contexts, published } = harness();
    await expect(handleNotificationJob(NOTIFICATION_CREATE_JOB, job(), deps)).resolves.toEqual({
      kind: 'notification',
      result: { kind: 'created', notificationId: 'n1', recipientUserId: USER },
    });
    expect(contexts).toEqual([{ organizationId: ORG, memberId: null, userId: null }]);
    expect(tenant.get()).toBeUndefined();
    expect(published).toEqual([
      {
        channel: `rt:org:${ORG}:user:${USER}`,
        event: { type: 'notification.created', entityType: 'notification', entityId: 'n1' },
      },
    ]);
  });

  it('does not re-announce a duplicate notification', async () => {
    const { deps, published } = harness('duplicate');
    await handleNotificationJob(NOTIFICATION_CREATE_JOB, job(), deps);
    expect(published).toEqual([]);
  });

  it('keeps a committed notification when the real-time publish fails', async () => {
    const { deps, realtimeErrors } = harness('created', { publishFails: true });
    await expect(handleNotificationJob(NOTIFICATION_CREATE_JOB, job(), deps)).resolves.toMatchObject({
      kind: 'notification',
    });
    expect(realtimeErrors).toHaveLength(1);
  });

  it.each([
    ['unknown job name', 'other.job', job()],
    ['missing organization', NOTIFICATION_CREATE_JOB, job({ organizationId: undefined })],
    ['non-uuid organization', NOTIFICATION_CREATE_JOB, job({ organizationId: 'org-1' })],
    ['other event type', NOTIFICATION_CREATE_JOB, job({ eventType: 'something.else' })],
    ['malformed payload', NOTIFICATION_CREATE_JOB, job({ payload: { ...payload, recipientMemberId: 'x' } })],
    ['extra payload field', NOTIFICATION_CREATE_JOB, job({ payload: { ...payload, organizationId: ORG } })],
    ['email job with notification data', NOTIFICATION_EMAIL_JOB, job()],
    [
      'email payload with extra field',
      NOTIFICATION_EMAIL_JOB,
      job({ eventType: 'notification.email.requested', payload: { deliveryId: DELIVERY, to: 'x@example.test' } }),
    ],
  ])('fails permanently on %s without side effects', async (_label, name, data) => {
    const { deps, contexts, published } = harness();
    await expect(handleNotificationJob(name, data, deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(contexts).toEqual([]);
    expect(published).toEqual([]);
  });

  it('fails permanently when the recipient is not a member of the event organization', async () => {
    const { deps } = harness('recipient_not_found');
    await expect(handleNotificationJob(NOTIFICATION_CREATE_JOB, job(), deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('sends an email delivery in a system context of the event organization', async () => {
    const { deps, contexts } = harness();
    const data = job({ eventType: 'notification.email.requested', payload: { deliveryId: DELIVERY } });
    await expect(handleNotificationJob(NOTIFICATION_EMAIL_JOB, data, deps)).resolves.toEqual({
      kind: 'email',
      outcome: 'sent',
    });
    expect(contexts).toEqual([{ organizationId: ORG, memberId: null, userId: null }]);
  });
});

describe('dashboard invalidation job', () => {
  const changed = (domains: unknown, overrides: Record<string, unknown> = {}) =>
    job({ eventType: 'dashboard.changed', payload: { domains }, ...overrides });

  const withInvalidator = () => {
    const calls: { organizationId: string; domains: readonly string[] }[] = [];
    const { deps } = harness();
    return {
      calls,
      deps: {
        ...deps,
        invalidate: (organizationId: string, domains: readonly string[]) => {
          calls.push({ organizationId, domains });
          return Promise.resolve();
        },
      } satisfies NotificationJobDeps,
    };
  };

  it("retires the event organization's domains, never a payload-supplied tenant", async () => {
    const { deps, calls } = withInvalidator();
    await expect(handleNotificationJob(DASHBOARD_INVALIDATE_JOB, changed(['attendance']), deps)).resolves.toEqual({
      kind: 'dashboard',
      domains: 1,
    });
    expect(calls).toEqual([{ organizationId: ORG, domains: ['attendance'] }]);
  });

  it.each([
    ['empty domains', changed([])],
    ['unknown domain', changed(['payroll'])],
    [
      'extra payload field',
      job({ eventType: 'dashboard.changed', payload: { domains: ['support'], organizationId: ORG } }),
    ],
    ['other event type', changed(['support'], { eventType: 'request.changed' })],
  ])('fails permanently on %s without invalidating', async (_label, data) => {
    const { deps, calls } = withInvalidator();
    await expect(handleNotificationJob(DASHBOARD_INVALIDATE_JOB, data, deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(calls).toEqual([]);
  });

  it('is a no-op without an invalidator (dashboards then rely on their TTL)', async () => {
    const { deps } = harness();
    await expect(handleNotificationJob(DASHBOARD_INVALIDATE_JOB, changed(['support', 'jira']), deps)).resolves.toEqual({
      kind: 'dashboard',
      domains: 2,
    });
  });
});

describe('relayRetryDelayMs', () => {
  it('backs off exponentially and caps at five minutes', () => {
    expect([1, 2, 3, 4].map(relayRetryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(relayRetryDelayMs(30)).toBe(300_000);
  });
});
