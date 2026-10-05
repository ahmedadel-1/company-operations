import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttachmentService } from '../../src/modules/attachments/attachment.service.js';
import type { ActionContext } from '../../src/modules/action-context.js';
import { SlaSweep } from '../../src/modules/support/sla-sweep.js';
import { SupportConfigService } from '../../src/modules/support/support-config.service.js';
import {
  SupportTicketAttachmentPolicy,
  TicketCommentService,
} from '../../src/modules/support/ticket-comment.service.js';
import { TicketWatcherService } from '../../src/modules/support/ticket-watcher.service.js';
import { TicketService } from '../../src/modules/support/ticket.service.js';
import type { CreateTicketInput } from '../../src/modules/support/ticket.service.js';
import type { TicketView } from '../../src/modules/support/ticket-views.js';
import { Prisma } from '../../src/platform/db/prisma.js';
import { encodeCursor } from '../../src/platform/pagination/cursor.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../src/platform/errors.js';
import { NO_SCAN } from '../../src/platform/storage/storage-port.js';
import type { StoragePort } from '../../src/platform/storage/storage-port.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Support operations against PostgreSQL 18 with the real migrations and the development seed:
 * ticket visibility (404 out of scope, 403 visible but not permitted), internal-note secrecy across
 * every read path and side channel, assignment eligibility, watchers, the resolve/verify/close
 * lifecycle, append-only history, idempotent creation, cursors, the SLA sweep and attachments.
 *
 * Actors (seed): EMP-00040 support agent (ORG scope), EMP-00019 support agent in Support Tier 1,
 * EMP-00041 project manager of IHD, EMP-00024 field employee on TMP, EMP-00004 employee (SELF),
 * EMP-00009 employee on POS only, EMP-00005 disabled member, NW-001 member of another organization.
 */
let s: SeededDatabase;
let tickets: TicketService;
let comments: TicketCommentService;
let watchers: TicketWatcherService;
let config: SupportConfigService;
let attachments: AttachmentService;

const stored = new Map<string, Uint8Array>();
const storage: StoragePort = {
  presignUpload: ({ key }) => Promise.resolve(`http://storage.test/${key}?signed`),
  presignDownload: ({ key }) => Promise.resolve(`http://storage.test/${key}?download`),
  head: (key) => {
    const bytes = stored.get(key);
    return Promise.resolve(bytes === undefined ? null : { sizeBytes: bytes.byteLength });
  },
  read: (key) => {
    const bytes = stored.get(key);
    if (bytes === undefined) {
      return Promise.reject(new Error('missing object'));
    }
    return Promise.resolve(
      (async function* chunks() {
        await Promise.resolve();
        yield bytes;
      })(),
    );
  },
  delete: (key) => {
    stored.delete(key);
    return Promise.resolve();
  },
};

/** Simulates the browser's pre-signed PUT for an upload intent URL. */
const putObject = (url: string, bytes: Uint8Array): void => {
  stored.set(new URL(url).pathname.slice(1), bytes);
};

let agent: ActionContext;
let tierAgent: ActionContext;
let pm: ActionContext;
let field: ActionContext;
let employee: ActionContext;
let unrelated: ActionContext;
let foreign: ActionContext;

const projectId = async (code: string): Promise<string> =>
  (await s.prisma.project.findFirstOrThrow({ where: { organizationId: s.demoId, code }, select: { id: true } })).id;

const report = (actor: ActionContext, input: Partial<CreateTicketInput> = {}, key?: string): Promise<TicketView> =>
  s.as(actor, () =>
    tickets.create(
      actor,
      {
        title: `Printer offline ${randomUUID().slice(0, 8)}`,
        description: 'The office printer does not respond.',
        severity: 'MEDIUM',
        impact: 'SINGLE_USER',
        ...input,
      },
      key,
    ),
  );

const fresh = (actor: ActionContext, id: string): Promise<TicketView> => s.as(actor, () => tickets.get(actor, id));

const move = async (actor: ActionContext, id: string, to: TicketView['status'], note?: string): Promise<TicketView> => {
  const current = await fresh(agent, id);
  return s.as(actor, () => tickets.transition(actor, id, current.version, { to, note }));
};

beforeAll(async () => {
  s = await startSeededDatabase();
  tickets = new TicketService(s.tenantDb, s.tenant);
  comments = new TicketCommentService(s.tenantDb, s.tenant);
  watchers = new TicketWatcherService(s.tenantDb, s.tenant);
  config = new SupportConfigService(s.tenantDb, s.tenant);
  attachments = new AttachmentService(
    s.tenantDb,
    s.tenant,
    storage,
    [new SupportTicketAttachmentPolicy(comments)],
    NO_SCAN,
  );
  agent = await s.actionFor('EMP-00040');
  tierAgent = await s.actionFor('EMP-00019');
  pm = await s.actionFor('EMP-00041');
  field = await s.actionFor('EMP-00024');
  employee = await s.actionFor('EMP-00004');
  unrelated = await s.actionFor('EMP-00009');
  foreign = await s.actionFor('NW-001', s.northwindId);
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('ticket creation', () => {
  it('derives priority from severity, numbers tickets and records the creation in history', async () => {
    const ticket = await report(employee, { severity: 'HIGH' });
    expect(ticket).toMatchObject({ status: 'NEW', priority: 'P2', assignee: null, project: null });
    expect(ticket.key).toBe(`SUP-${String(ticket.number)}`);
    const history = await s.as(employee, () => tickets.history(employee, ticket.id, {}));
    expect(history.items.map((event) => event.type)).toEqual(['CREATED']);
  });

  it('lets only triagers set the priority of a new ticket', async () => {
    await expect(report(employee, { priority: 'P1' })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await report(agent, { priority: 'P1' })).priority).toBe('P1');
  });

  it('replays an idempotent create and rejects a reused key with different content', async () => {
    const key = randomUUID();
    const first = await report(employee, { title: 'Idempotent ticket' }, key);
    const replay = await report(employee, { title: 'Idempotent ticket' }, key);
    expect(replay.id).toBe(first.id);
    await expect(report(employee, { title: 'Something else' }, key)).rejects.toBeInstanceOf(ConflictError);
    // Keys are per reporter: another member may use the same key.
    expect((await report(field, { title: 'Idempotent ticket' }, key)).id).not.toBe(first.id);
  });

  it('routes project tickets to the project support team and applies the matching SLA policy', async () => {
    const ticket = await report(field, { projectId: await projectId('TMP'), severity: 'HIGH', source: 'FIELD' });
    expect(ticket.assignedTeam?.name).toBe('Support Tier 1');
    expect(ticket.sla?.policy.name).toBe('High (business hours)');
    expect(ticket.sla?.firstResponseDueAt).not.toBeNull();
  });

  it('rejects projects the reporter cannot see and components of another project', async () => {
    await expect(report(employee, { projectId: await projectId('TMP') })).rejects.toBeInstanceOf(NotFoundError);
    const component = await s.prisma.supportComponent.findFirstOrThrow({
      where: { organizationId: s.demoId, name: 'Helpdesk portal' },
    });
    await expect(
      report(field, { projectId: await projectId('TMP'), componentId: component.id }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('visibility and authorization', () => {
  it('hides out-of-scope tickets as 404 and refuses visible-but-not-permitted actions with 403', async () => {
    const ticket = await report(employee);
    await expect(fresh(unrelated, ticket.id)).rejects.toBeInstanceOf(NotFoundError);
    const list = await s.as(unrelated, () => tickets.list(unrelated, { limit: 100 }));
    expect(list.items.some((item) => item.id === ticket.id)).toBe(false);
    // The reporter sees their ticket but cannot triage it.
    await expect(
      s.as(employee, () => tickets.transition(employee, ticket.id, ticket.version, { to: 'TRIAGED' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(employee, () => tickets.assign(employee, ticket.id, ticket.version, { assigneeMemberId: null })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('shows project tickets to the project manager and not to members of other projects', async () => {
    const ihd = await projectId('IHD');
    const ticket = await report(tierAgent, { projectId: ihd });
    expect((await fresh(pm, ticket.id)).id).toBe(ticket.id);
    const list = await s.as(pm, () => tickets.list(pm, { projectId: ihd, limit: 100 }));
    expect(list.items.some((item) => item.id === ticket.id)).toBe(true);
    const tmpTicket = await report(field, { projectId: await projectId('TMP') });
    await expect(fresh(pm, tmpTicket.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(fresh(unrelated, ticket.id)).rejects.toBeInstanceOf(NotFoundError);
    const summary = await s.as(pm, () => tickets.projectSummary(pm, ihd));
    expect(summary.openCount).toBeGreaterThanOrEqual(1);
    expect(summary.supportTeam?.name).toBe('Support Tier 1');
    await expect(s.as(unrelated, () => tickets.projectSummary(unrelated, ihd))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets reporters with project-scoped grants follow their own project-less tickets, and nobody else', async () => {
    // Field employees hold support.view/comment/verify at PROJECT scope only (SECURITY §2.5).
    const ticket = await report(field);
    expect(ticket.project).toBeNull();
    expect((await fresh(field, ticket.id)).id).toBe(ticket.id);
    const mine = await s.as(field, () => tickets.list(field, { view: 'reported_by_me', limit: 100 }));
    expect(mine.items.some((item) => item.id === ticket.id)).toBe(true);
    const reply = await s.as(field, () =>
      comments.add(field, ticket.id, { body: 'Still broken.', visibility: 'PUBLIC_INTERNAL' }),
    );
    expect(reply.visibility).toBe('PUBLIC_INTERNAL');
    await move(agent, ticket.id, 'RESOLVED', 'Replaced the cable.');
    const verified = await move(field, ticket.id, 'VERIFIED');
    expect(verified.status).toBe('VERIFIED');
    // The reporter rule never extends to internal notes, triage or other members' tickets.
    await expect(
      s.as(field, () => comments.add(field, ticket.id, { body: 'x', visibility: 'INTERNAL_NOTE' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const colleague = await s.actionFor('EMP-00025');
    await expect(fresh(colleague, ticket.id)).rejects.toBeInstanceOf(NotFoundError);
    const theirs = await s.as(colleague, () => tickets.list(colleague, { limit: 100 }));
    expect(theirs.items.some((item) => item.id === ticket.id)).toBe(false);
  });

  it('never resolves tickets of another organization', async () => {
    const ticket = await report(employee);
    await expect(fresh(foreign, ticket.id)).rejects.toBeInstanceOf(NotFoundError);
    const list = await s.as(foreign, () => tickets.list(foreign, { limit: 100 }));
    expect(list.items.some((item) => item.id === ticket.id)).toBe(false);
    await expect(
      s.as(foreign, () => comments.add(foreign, ticket.id, { body: 'x', visibility: 'PUBLIC_INTERNAL' })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects forged cursors with a validation error', async () => {
    for (const sort of ['createdAt:desc', 'priority:asc'] as const) {
      await expect(
        s.as(agent, () => tickets.list(agent, { sort, cursor: encodeCursor(['nope', randomUUID()]) })),
      ).rejects.toBeInstanceOf(InvalidInputError);
      await expect(s.as(agent, () => tickets.list(agent, { sort, cursor: 'not-base64-json' }))).rejects.toBeInstanceOf(
        InvalidInputError,
      );
      await expect(
        s.as(agent, () => tickets.list(agent, { sort, cursor: encodeCursor(['P1', 'not-a-uuid']) })),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  it('pages through the queue without gaps or duplicates for every sort', async () => {
    for (const sort of ['createdAt:desc', 'createdAt:asc', 'updatedAt:desc', 'priority:asc'] as const) {
      const all = await s.as(agent, () => tickets.list(agent, { sort, limit: 100 }));
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.as(agent, () => tickets.list(agent, { sort, limit: 3, cursor }));
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(all.items.map((item) => item.id));
    }
  });
});

describe('triage and assignment', () => {
  it('assigns only active, eligible members and audits the assignment', async () => {
    const ticket = await report(field, { projectId: await projectId('TMP') });
    const triaged = await move(agent, ticket.id, 'TRIAGED');
    expect(triaged.status).toBe('TRIAGED');
    const disabled = await s.employee('EMP-00005');
    await expect(
      s.as(agent, () => tickets.assign(agent, ticket.id, triaged.version, { assigneeMemberId: disabled.memberId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const plain = await s.employee('EMP-00009');
    await expect(
      s.as(agent, () => tickets.assign(agent, ticket.id, triaged.version, { assigneeMemberId: plain.memberId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const candidates = await s.as(agent, () => tickets.assignableMembers(agent, ticket.id, {}));
    expect(candidates.some((c) => c.memberId === disabled.memberId || c.memberId === plain.memberId)).toBe(false);
    expect(candidates.some((c) => c.memberId === tierAgent.principal.memberId)).toBe(true);

    const assigned = await s.as(agent, () =>
      tickets.assign(agent, ticket.id, triaged.version, { assigneeMemberId: tierAgent.principal.memberId }),
    );
    expect(assigned.assignee?.memberId).toBe(tierAgent.principal.memberId);
    await expect(
      s.as(agent, () => tickets.assign(agent, ticket.id, triaged.version, { assigneeMemberId: null })),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const audit = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, action: 'support.ticket.assigned', entityId: ticket.id },
    });
    expect(audit).toHaveLength(1);
    const notifications = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, eventType: 'notification.requested', aggregateId: ticket.id },
      select: { payload: true },
    });
    expect(
      notifications.some((event) =>
        JSON.stringify(event.payload).includes(`"recipientMemberId":"${tierAgent.principal.memberId}"`),
      ),
    ).toBe(true);
  });
});

describe('internal notes never leak', () => {
  it('keeps internal notes out of reporter reads, history, notifications, audit and errors', async () => {
    const secret = `internal-${randomUUID()}`;
    const ticket = await report(employee);
    await s.as(agent, () =>
      comments.add(agent, ticket.id, { body: 'We are looking into it.', visibility: 'PUBLIC_INTERNAL' }),
    );
    const note = await s.as(agent, () => comments.add(agent, ticket.id, { body: secret, visibility: 'INTERNAL_NOTE' }));

    const reporterView = await s.as(employee, () => comments.list(employee, ticket.id, {}));
    expect(reporterView.items.map((c) => c.visibility)).toEqual(['PUBLIC_INTERNAL']);
    expect(JSON.stringify(reporterView)).not.toContain(secret);
    const agentView = await s.as(agent, () => comments.list(agent, ticket.id, {}));
    expect(agentView.items.map((c) => c.body)).toContain(secret);

    const reporterHistory = await s.as(employee, () => tickets.history(employee, ticket.id, {}));
    expect(reporterHistory.items.some((event) => event.type.startsWith('INTERNAL_NOTE'))).toBe(false);
    const agentHistory = await s.as(agent, () => tickets.history(agent, ticket.id, {}));
    expect(agentHistory.items.some((event) => event.type === 'INTERNAL_NOTE_ADDED')).toBe(true);

    const detail = await fresh(employee, ticket.id);
    expect(detail.access).toMatchObject({ canAddInternalNote: false, canViewInternalNotes: false });
    expect(JSON.stringify(detail)).not.toContain(secret);

    await expect(
      s.as(employee, () => comments.edit(employee, ticket.id, note.id, { body: 'hijack' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(employee, () => comments.add(employee, ticket.id, { body: 'x', visibility: 'INTERNAL_NOTE' })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const outbox = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, aggregateId: ticket.id },
      select: { eventType: true, payload: true },
    });
    expect(JSON.stringify(outbox)).not.toContain(secret);
    const reporterMember = employee.principal.memberId;
    const toReporter = outbox.filter((event) =>
      JSON.stringify(event.payload).includes(`"recipientMemberId":"${reporterMember}"`),
    );
    expect(toReporter.some((event) => JSON.stringify(event.payload).includes('INTERNAL'))).toBe(false);
    expect(toReporter.some((event) => JSON.stringify(event.payload).includes('SUPPORT_TICKET_REPLIED'))).toBe(true);

    const events = await s.prisma.supportTicketEvent.findMany({
      where: { organizationId: s.demoId, ticketId: ticket.id },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    const audit = await s.prisma.auditLog.findMany({ where: { organizationId: s.demoId, entityId: ticket.id } });
    expect(JSON.stringify(audit)).not.toContain(secret);

    // Search does not match comment bodies.
    const search = await s.as(agent, () => tickets.list(agent, { q: secret }));
    expect(search.items).toHaveLength(0);
  });

  it('records the first response from a public reply by support, not from internal notes', async () => {
    const ticket = await report(employee);
    await s.as(agent, () => comments.add(agent, ticket.id, { body: 'note', visibility: 'INTERNAL_NOTE' }));
    expect((await fresh(agent, ticket.id)).sla?.firstRespondedAt ?? null).toBeNull();
    await s.as(agent, () => comments.add(agent, ticket.id, { body: 'reply', visibility: 'PUBLIC_INTERNAL' }));
    const row = await s.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.firstRespondedAt).not.toBeNull();
  });

  it('moves a waiting ticket back to work when the reporter replies', async () => {
    const ticket = await report(employee);
    await move(agent, ticket.id, 'WAITING_FOR_CUSTOMER');
    await s.as(employee, () =>
      comments.add(employee, ticket.id, { body: 'Here are the details.', visibility: 'PUBLIC_INTERNAL' }),
    );
    expect((await fresh(employee, ticket.id)).status).toBe('IN_PROGRESS');
  });
});

describe('watchers', () => {
  it('lets members watch tickets they can see and keeps others from adding unrelated members', async () => {
    const ticket = await report(employee);
    await s.as(employee, () => watchers.add(employee, ticket.id, employee.principal.memberId));
    await expect(
      s.as(employee, () => watchers.add(employee, ticket.id, tierAgent.principal.memberId)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(agent, () => watchers.add(agent, ticket.id, unrelated.principal.memberId)),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const list = await s.as(agent, () => watchers.add(agent, ticket.id, tierAgent.principal.memberId));
    expect(list.map((w) => w.member.memberId).sort()).toEqual(
      [employee.principal.memberId, tierAgent.principal.memberId].sort(),
    );
    await expect(
      s.as(unrelated, () => watchers.add(unrelated, ticket.id, unrelated.principal.memberId)),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Idempotent add.
    expect(await s.as(employee, () => watchers.add(employee, ticket.id, employee.principal.memberId))).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('requires a resolution note, keeps resolve, verify and close distinct and locks closed tickets', async () => {
    const ticket = await report(employee);
    await move(agent, ticket.id, 'IN_PROGRESS');
    await expect(move(agent, ticket.id, 'RESOLVED')).rejects.toBeInstanceOf(InvalidInputError);
    const resolved = await move(agent, ticket.id, 'RESOLVED', 'Replaced the toner.');
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Replaced the toner.', closedAt: null });
    await expect(move(agent, ticket.id, 'NEW')).rejects.toBeInstanceOf(InvalidTransitionError);
    // The SLA sweep never closes a resolved ticket.
    await s.asSystem(s.demoId, () => new SlaSweep(s.tenantDb, s.tenant).run(new Date(Date.now() + 30 * 86_400_000)));
    expect((await fresh(employee, ticket.id)).status).toBe('RESOLVED');

    const verified = await move(employee, ticket.id, 'VERIFIED');
    expect(verified.status).toBe('VERIFIED');
    await expect(move(employee, ticket.id, 'CLOSED')).rejects.toBeInstanceOf(ForbiddenError);
    const closed = await move(agent, ticket.id, 'CLOSED');
    expect(closed.closedAt).not.toBeNull();
    await expect(
      s.as(employee, () => comments.add(employee, ticket.id, { body: 'late', visibility: 'PUBLIC_INTERNAL' })),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const types = (await s.as(agent, () => tickets.history(agent, ticket.id, {}))).items.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(['RESOLVED', 'VERIFIED', 'CLOSED']));
  });

  it('keeps ticket history append-only at the database level', async () => {
    const ticket = await report(employee);
    const event = await s.prisma.supportTicketEvent.findFirstOrThrow({ where: { ticketId: ticket.id } });
    await expect(
      s.prisma.supportTicketEvent.update({ where: { id: event.id }, data: { type: 'TAMPERED' } }),
    ).rejects.toThrow();
    await expect(s.prisma.supportTicketEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    expect((await s.prisma.supportTicketEvent.findUniqueOrThrow({ where: { id: event.id } })).type).toBe('CREATED');
  });
});

describe('SLA sweep', () => {
  it('records breaches and escalations once, notifies, and never duplicates on re-runs', async () => {
    const started = new Date(Date.now() - 3 * 3_600_000);
    const backdated = new TicketService(s.tenantDb, s.tenant, () => started);
    const ticket = await s.as(field, () =>
      backdated.create(field, {
        title: 'Control room offline',
        description: 'All dashboards are down.',
        severity: 'CRITICAL',
        impact: 'SITE',
        projectId: undefined,
      }),
    );
    const tmpTicket = await s.as(field, async () =>
      backdated.create(field, {
        title: 'Control room offline (TMP)',
        description: 'All dashboards are down.',
        severity: 'CRITICAL',
        impact: 'SITE',
        projectId: await projectId('TMP'),
      }),
    );
    expect(tmpTicket.sla?.policy.name).toBe('Critical (24x7)');
    const sweep = new SlaSweep(s.tenantDb, s.tenant);
    const now = new Date();
    const first = await s.asSystem(s.demoId, () => sweep.run(now));
    expect(first.escalations).toBeGreaterThanOrEqual(2);
    const events = await s.prisma.slaEvent.findMany({ where: { ticketId: tmpTicket.id }, select: { kind: true } });
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['FIRST_RESPONSE_BREACHED', 'RESOLUTION_AT_RISK', 'ESCALATED']),
    );
    const row = await s.prisma.supportTicket.findUniqueOrThrow({ where: { id: tmpTicket.id } });
    expect(row).toMatchObject({ firstResponseSlaState: 'BREACHED', resolutionSlaState: 'AT_RISK', escalationLevel: 1 });
    const outboxBefore = await s.prisma.outboxEvent.count({
      where: { aggregateId: { in: [ticket.id, tmpTicket.id] } },
    });
    const notified = await s.prisma.outboxEvent.findMany({
      where: { aggregateId: tmpTicket.id, eventType: 'notification.requested' },
      select: { payload: true },
    });
    expect(notified.some((event) => JSON.stringify(event.payload).includes('SUPPORT_TICKET_ESCALATED'))).toBe(true);
    expect(notified.some((event) => JSON.stringify(event.payload).includes('SUPPORT_SLA_BREACHED'))).toBe(true);

    const second = await s.asSystem(s.demoId, () => sweep.run(now));
    expect(second.escalations).toBe(0);
    expect(await s.prisma.slaEvent.count({ where: { ticketId: tmpTicket.id } })).toBe(events.length);
    expect(await s.prisma.outboxEvent.count({ where: { aggregateId: { in: [ticket.id, tmpTicket.id] } } })).toBe(
      outboxBefore,
    );
    const history = (await s.as(agent, () => tickets.history(agent, tmpTicket.id, {}))).items.map((e) => e.type);
    expect(history.filter((type) => type === 'SLA_BREACHED')).toHaveLength(1);
  });

  it('pauses while waiting for the customer and does not breach a paused ticket', async () => {
    const started = new Date(Date.now() - 20 * 60_000);
    const backdated = new TicketService(s.tenantDb, s.tenant, () => started);
    const ticket = await s.as(employee, () =>
      backdated.create(employee, {
        title: 'Paused SLA',
        description: 'Waiting for logs.',
        severity: 'CRITICAL',
        impact: 'SINGLE_USER',
      }),
    );
    await s.as(agent, () =>
      comments.add(agent, ticket.id, { body: 'Please send logs.', visibility: 'PUBLIC_INTERNAL' }),
    );
    await move(agent, ticket.id, 'WAITING_FOR_CUSTOMER');
    await s.asSystem(s.demoId, () => new SlaSweep(s.tenantDb, s.tenant).run(new Date(Date.now() + 10 * 3_600_000)));
    const row = await s.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.resolutionSlaState).toBe('PAUSED');
    expect(await s.prisma.slaEvent.count({ where: { ticketId: ticket.id, kind: 'RESOLUTION_BREACHED' } })).toBe(0);
    const types = (await s.as(agent, () => tickets.history(agent, ticket.id, {}))).items.map((e) => e.type);
    expect(types).toContain('SLA_PAUSED');
  });
});

describe('configuration', () => {
  it('limits support configuration to ORG-wide config holders and validates escalation roles', async () => {
    await expect(s.as(agent, () => config.createCategory(agent, { name: 'Agent category' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const admin = await s.actionFor('EMP-00001');
    const category = await s.as(admin, () => config.createCategory(admin, { name: `Cat ${randomUUID().slice(0, 6)}` }));
    expect(category.active).toBe(true);
    const audit = await s.prisma.auditLog.count({
      where: { organizationId: s.demoId, action: 'support.category.created', entityId: category.id },
    });
    expect(audit).toBe(1);
    await expect(
      s.as(admin, () =>
        config.createRule(admin, {
          name: 'Bad rule',
          level: 1,
          trigger: 'UNRESOLVED_AFTER_MINUTES',
          threshold: 60,
          notify: { roles: ['NO_SUCH_ROLE'], projectRoles: [], memberIds: [] },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('keeps project components with their project: global only without one, 404 for invisible projects', async () => {
    const ihd = await projectId('IHD');
    const global = await s.as(employee, () => config.listComponents(employee, { includeInactive: false }));
    expect(global.length).toBeGreaterThan(0);
    expect(global.every((component) => component.project === null)).toBe(true);
    await expect(
      s.as(employee, () => config.listComponents(employee, { projectId: ihd, includeInactive: false })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const forProject = await s.as(pm, () => config.listComponents(pm, { projectId: ihd, includeInactive: false }));
    expect(forProject.map((component) => component.name)).toContain('Helpdesk portal');
    expect(forProject.map((component) => component.name)).not.toContain('Camera network');
    const admin = await s.actionFor('EMP-00001');
    const everything = await s.as(admin, () => config.listComponents(admin, { includeInactive: true }));
    expect(everything.map((component) => component.name)).toContain('Camera network');
  });
});

describe('composite tenant foreign keys (database level, unguarded client)', () => {
  const expectFkViolation = async (operation: Promise<unknown>) => {
    await expect(operation).rejects.toSatisfy(
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
    );
  };

  it('rejects support rows that reference another organization', async () => {
    const nw = await s.employee('NW-001', s.northwindId);
    const nwProject = await s.prisma.project.create({
      data: { organizationId: s.northwindId, number: 7001, code: 'NW-SUP', name: 'Northwind support project' },
      select: { id: true },
    });
    const nwTeam = await s.prisma.team.create({
      data: { organizationId: s.northwindId, name: `NW support ${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });
    const nwCategory = await s.prisma.supportCategory.create({
      data: { organizationId: s.northwindId, name: 'NW category' },
      select: { id: true },
    });
    const nwPolicy = await s.prisma.slaPolicy.create({
      data: {
        organizationId: s.northwindId,
        name: 'NW policy',
        priority: 1,
        firstResponseMinutes: 10,
        resolutionMinutes: 60,
      },
      select: { id: true },
    });
    const demo = await s.employee('EMP-00004');
    const demoTicket = await report(employee);

    let n = 0;
    const ticket = (data: Partial<Prisma.SupportTicketUncheckedCreateInput>) => {
      n += 1;
      return s.prisma.supportTicket.create({
        data: {
          organizationId: s.demoId,
          number: 80_000 + n,
          reporterMemberId: demo.memberId,
          source: 'INTERNAL',
          title: 'x',
          description: 'x',
          severity: 'LOW',
          priority: 'P4',
          impact: 'SINGLE_USER',
          ...data,
        },
      });
    };
    await expectFkViolation(ticket({ reporterMemberId: nw.memberId }));
    await expectFkViolation(ticket({ projectId: nwProject.id }));
    await expectFkViolation(ticket({ categoryId: nwCategory.id }));
    await expectFkViolation(ticket({ assignedTeamId: nwTeam.id }));
    await expectFkViolation(ticket({ assigneeMemberId: nw.memberId }));
    const due = new Date(Date.now() + 3_600_000);
    await expectFkViolation(
      ticket({
        slaPolicyId: nwPolicy.id,
        firstResponseDueAt: due,
        resolutionDueAt: due,
        firstResponseSlaState: 'ON_TRACK',
        resolutionSlaState: 'ON_TRACK',
      }),
    );

    await expectFkViolation(
      s.prisma.supportTicketComment.create({
        data: {
          organizationId: s.demoId,
          ticketId: demoTicket.id,
          authorMemberId: nw.memberId,
          body: 'x',
          visibility: 'PUBLIC_INTERNAL',
        },
      }),
    );
    await expectFkViolation(
      s.prisma.supportTicketWatcher.create({
        data: { organizationId: s.demoId, ticketId: demoTicket.id, memberId: nw.memberId },
      }),
    );
    await expectFkViolation(
      s.prisma.supportTicketEvent.create({
        data: { organizationId: s.northwindId, ticketId: demoTicket.id, type: 'COMMENTED' },
      }),
    );
    await expectFkViolation(
      s.prisma.slaEvent.create({
        data: { organizationId: s.northwindId, ticketId: demoTicket.id, kind: 'RESOLUTION_AT_RISK' },
      }),
    );
    await expectFkViolation(
      s.prisma.supportComponent.create({
        data: { organizationId: s.demoId, name: `Cross ${randomUUID().slice(0, 8)}`, projectId: nwProject.id },
      }),
    );
    await expectFkViolation(
      s.prisma.project.update({ where: { id: await projectId('TMP') }, data: { supportTeamId: nwTeam.id } }),
    );
  });
});

describe('attachments', () => {
  it('lets ticket viewers attach files and hides them from everyone else (no IDOR)', async () => {
    const ticket = await report(employee);
    const input = {
      ownerType: 'SUPPORT_TICKET' as const,
      ownerId: ticket.id,
      filename: 'screen.png',
      contentType: 'image/png',
      sizeBytes: 1024,
    };
    const intent = await s.as(employee, () => attachments.createUploadIntent(employee, input));
    expect(intent.upload.url).toContain('support-ticket');
    await expect(
      s.as(employee, () => attachments.createUploadIntent(employee, { ...input, contentType: 'text/html' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(employee, () => attachments.createUploadIntent(employee, { ...input, sizeBytes: 11 * 1024 * 1024 })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(unrelated, () => attachments.createUploadIntent(unrelated, input))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(unrelated, () => attachments.get(unrelated, intent.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      s.as(unrelated, () => attachments.listForOwner(unrelated, 'SUPPORT_TICKET', ticket.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(foreign, () => attachments.get(foreign, intent.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(employee, () => attachments.delete(employee, intent.attachment.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('records completed and removed attachments in the ticket history', async () => {
    const ticket = await report(employee);
    const bytes = new TextEncoder().encode('Printer log: paper jam at tray 2.\n');
    const intent = await s.as(employee, () =>
      attachments.createUploadIntent(employee, {
        ownerType: 'SUPPORT_TICKET',
        ownerId: ticket.id,
        filename: 'printer.log.txt',
        contentType: 'text/plain',
        sizeBytes: bytes.byteLength,
      }),
    );
    putObject(intent.upload.url, bytes);
    const completed = await s.as(employee, () => attachments.complete(employee, intent.attachment.id));
    expect(completed.status).toBe('AVAILABLE');
    await s.as(employee, () => attachments.complete(employee, intent.attachment.id));
    const afterUpload = (await s.as(employee, () => tickets.history(employee, ticket.id, {}))).items;
    const added = afterUpload.filter((event) => event.type === 'ATTACHMENT_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0]?.metadata).toMatchObject({ attachmentId: intent.attachment.id, filename: 'printer.log.txt' });

    await s.as(agent, () => attachments.delete(agent, intent.attachment.id));
    const afterDelete = (await s.as(employee, () => tickets.history(employee, ticket.id, {}))).items;
    expect(afterDelete.map((event) => event.type)).toEqual(['CREATED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED']);
    await expect(s.as(unrelated, () => tickets.history(unrelated, ticket.id, {}))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
