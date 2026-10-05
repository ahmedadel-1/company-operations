import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { permissionChannel, userChannel } from '@company-ops/core';

import { MAX_STREAMS_PER_USER } from '../src/realtime/realtime-hub.js';
import { createSession, seed, startApiStack } from './support/stack.js';
import type { ApiStack, TestSession } from './support/stack.js';

/**
 * `GET /notifications/events/stream` over real HTTP and Redis: a stream receives only its own
 * session's channels (user channel of the active organization; the support queue channel only for
 * ORG-wide `support.view`), never another organization's events for the same user, drops anything
 * that is not an identifiers-only event, and is limited per user.
 */
const SUBJECT = {
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  support: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f09',
} as const;

const TICKET_ID = '0190f0a0-0000-7000-8000-00000000a001';

let stack: ApiStack;
let publisher: Redis;
let orgA: string;
let orgB: string;

const opened: Stream[] = [];

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** An open SSE stream that collects parsed events until closed. */
class Stream {
  readonly events: SseEvent[] = [];
  private readonly controller = new AbortController();
  private buffer = '';

  private constructor(readonly status: number) {}

  static async open(session: TestSession | null): Promise<Stream> {
    const controller = new AbortController();
    const response = await fetch(`${stack.baseUrl}/api/v1/notifications/events/stream`, {
      headers: session === null ? {} : { cookie: session.cookie },
      signal: controller.signal,
    });
    const stream = new Stream(response.status);
    opened.push(stream);
    stream.controller.signal.addEventListener('abort', () => {
      controller.abort();
    });
    if (response.ok && response.body !== null) {
      void stream.pump(response.body);
    } else {
      await response.body?.cancel();
    }
    return stream;
  }

  changes(): unknown[] {
    return this.events.filter((e) => e.event === 'change').map((e) => JSON.parse(e.data) as unknown);
  }

  async waitFor(predicate: (events: readonly SseEvent[]) => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out; received ${JSON.stringify(this.events)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  close(): void {
    this.controller.abort();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.buffer += decoder.decode(value, { stream: true });
        let end = this.buffer.indexOf('\n\n');
        while (end !== -1) {
          this.parse(this.buffer.slice(0, end));
          this.buffer = this.buffer.slice(end + 2);
          end = this.buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        throw error;
      }
    }
  }

  private parse(block: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    this.events.push({ event, data: data.join('\n') });
  }
}

const ready = (events: readonly SseEvent[]) => events.some((e) => e.event === 'ready');

async function userIdOf(subject: string): Promise<string> {
  const user = await stack.prisma.user.findUniqueOrThrow({
    where: { idpIssuer_idpSubject: { idpIssuer: stack.env.OIDC_ISSUER, idpSubject: subject } },
    select: { id: true },
  });
  return user.id;
}

const event = (type: string) => JSON.stringify({ type, entityType: 'support_ticket', entityId: TICKET_ID });

beforeAll(async () => {
  stack = await startApiStack({ issuer: 'http://127.0.0.1:9/realms/company-ops' });
  orgA = await seed(stack);
  const second = await stack.prisma.organization.findFirstOrThrow({
    where: { id: { not: orgA } },
    select: { id: true },
  });
  orgB = second.id;
  publisher = new Redis(stack.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
}, 300_000);

afterAll(async () => {
  for (const stream of opened) {
    stream.close();
  }
  await publisher.quit();
  await stack.stop();
});

describe('live-update stream', () => {
  it('requires a session', async () => {
    const stream = await Stream.open(null);
    expect(stream.status).toBe(401);
  });

  it('delivers the user channel of the active organization only, never the same user in another organization', async () => {
    const gmUser = await userIdOf(SUBJECT.gm);
    const inA = await Stream.open(await createSession(stack, SUBJECT.gm, orgA));
    const inB = await Stream.open(await createSession(stack, SUBJECT.gm, orgB));
    expect([inA.status, inB.status]).toEqual([200, 200]);
    await inA.waitFor(ready);
    await inB.waitFor(ready);

    await publisher.publish(userChannel(orgA, gmUser), event('org-a.for-gm'));
    await publisher.publish(userChannel(orgB, gmUser), event('org-b.for-gm'));
    await inA.waitFor(() => inA.changes().length === 1);
    await inB.waitFor(() => inB.changes().length === 1);
    expect(inA.changes()).toEqual([{ type: 'org-a.for-gm', entityType: 'support_ticket', entityId: TICKET_ID }]);
    expect(inB.changes()).toEqual([{ type: 'org-b.for-gm', entityType: 'support_ticket', entityId: TICKET_ID }]);
    inA.close();
    inB.close();
  });

  it('sends the support queue channel only to ORG-wide support viewers and drops non-identifier payloads', async () => {
    const agent = await Stream.open(await createSession(stack, SUBJECT.support, orgA));
    const employee = await Stream.open(await createSession(stack, SUBJECT.employee, orgA));
    const foreignGm = await Stream.open(await createSession(stack, SUBJECT.gm, orgB));
    await agent.waitFor(ready);
    await employee.waitFor(ready);
    await foreignGm.waitFor(ready);

    const queue = permissionChannel(orgA, 'support.view');
    await publisher.publish(queue, 'not json');
    await publisher.publish(
      queue,
      JSON.stringify({ type: 'leak', entityType: 'support_ticket', entityId: TICKET_ID, title: 'Secret title' }),
    );
    await publisher.publish(queue, event('queue.changed'));
    await publisher.publish(userChannel(orgA, await userIdOf(SUBJECT.employee)), event('employee.marker'));
    await publisher.publish(userChannel(orgB, await userIdOf(SUBJECT.gm)), event('foreign.marker'));

    await agent.waitFor(() => agent.changes().length === 1);
    await employee.waitFor(() => employee.changes().length === 1);
    await foreignGm.waitFor(() => foreignGm.changes().length === 1);
    expect(agent.changes()).toEqual([{ type: 'queue.changed', entityType: 'support_ticket', entityId: TICKET_ID }]);
    expect(employee.changes()).toEqual([
      { type: 'employee.marker', entityType: 'support_ticket', entityId: TICKET_ID },
    ]);
    expect(foreignGm.changes()).toEqual([
      { type: 'foreign.marker', entityType: 'support_ticket', entityId: TICKET_ID },
    ]);
    expect(JSON.stringify(agent.events)).not.toContain('Secret title');
    agent.close();
    employee.close();
    foreignGm.close();
  });

  it(`allows ${String(MAX_STREAMS_PER_USER)} streams per user and refuses the next with 429`, async () => {
    const session = await createSession(stack, SUBJECT.employee, orgA);
    const open: Stream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i += 1) {
      const stream = await Stream.open(session);
      expect(stream.status).toBe(200);
      await stream.waitFor(ready);
      open.push(stream);
    }
    const refused = await Stream.open(session);
    refused.close();
    expect(refused.status).toBe(429);
    for (const stream of open) {
      stream.close();
    }
    // Slots are released when streams close.
    let reopened: Stream | null = null;
    const deadline = Date.now() + 5000;
    while (reopened?.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reopened = await Stream.open(session);
      if (reopened.status !== 200) reopened.close();
    }
    expect(reopened?.status).toBe(200);
    reopened?.close();
  });
});
