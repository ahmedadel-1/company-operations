import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approvalInboxQuerySchema,
  attendanceTeamDayQuerySchema,
  contractListQuerySchema,
  corporateDocumentListQuerySchema,
  projectListQuerySchema,
  requestListQuerySchema,
  tenderListQuerySchema,
  ticketListQuerySchema,
} from '@company-ops/validation';

import type { ActionContext } from '../../src/modules/action-context.js';
import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';
import { ContractService } from '../../src/modules/commercial/contract.service.js';
import { CorporateDocumentService } from '../../src/modules/commercial/corporate-document.service.js';
import { TenderService } from '../../src/modules/commercial/tender.service.js';
import {
  bumpDashboardVersions,
  DashboardCache,
  InMemoryDashboardCacheStore,
} from '../../src/modules/dashboard/dashboard-cache.js';
import type { DashboardCacheStore } from '../../src/modules/dashboard/dashboard-cache.js';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service.js';
import { rangeWindow } from '../../src/modules/dashboard/engine/ranges.js';
import type { DashboardLink, DashboardMetric } from '../../src/modules/dashboard/links.js';
import { NeedsAttentionService } from '../../src/modules/dashboard/needs-attention.service.js';
import { SearchService } from '../../src/modules/dashboard/search.service.js';
import type { SearchInput, SearchType } from '../../src/modules/dashboard/search.service.js';
import { SetupChecklistService } from '../../src/modules/dashboard/setup-checklist.service.js';
import { NotificationDeliveryService } from '../../src/modules/notifications/notification-delivery.js';
import { notificationEntityAccess } from '../../src/modules/notifications/notification-entity-access.js';
import { NotificationPreferenceService } from '../../src/modules/notifications/notification-preferences.js';
import { NotificationWriter } from '../../src/modules/notifications/notification.service.js';
import { ProjectService } from '../../src/modules/projects/project.service.js';
import { ApprovalService } from '../../src/modules/requests/approval.service.js';
import { RequestService } from '../../src/modules/requests/request.service.js';
import { TicketService } from '../../src/modules/support/ticket.service.js';
import type { EmailChannel, EmailMessage } from '../../src/platform/email/email-channel.js';
import { ForbiddenError, InvalidInputError } from '../../src/platform/errors.js';
import type { NotificationRequestedPayload } from '../../src/platform/outbox/outbox.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Phase 8 dashboards, Needs Attention, trends, global search, the setup checklist and notification
 * preferences (ADR-0023) against PostgreSQL 18 with the real migrations and the development seed.
 *
 * Actors (demo organization): EMP-00001 org admin, EMP-00002 general manager, EMP-00003 HR admin,
 * EMP-00004 employee, EMP-00008 team lead of EMP-00009/10/11/28 (and PM of POS), EMP-00018 support
 * agent, EMP-00024 field employee on TMP, EMP-00041 project manager of IHD; NW-001 general manager of
 * the second organization. Every service shares one clock so dashboard numbers and the lists they link
 * to are evaluated at the same instant.
 */
let s: SeededDatabase;
const now = new Date();
const clock = (): Date => now;

let tickets: TicketService;
let projects: ProjectService;
let requests: RequestService;
let approvals: ApprovalService;
let attendance: AttendanceService;
let tenders: TenderService;
let contracts: ContractService;
let corporateDocuments: CorporateDocumentService;
let search: SearchService;
let checklist: SetupChecklistService;
let preferences: NotificationPreferenceService;

let admin: ActionContext;
let gm: ActionContext;
let hr: ActionContext;
let employee: ActionContext;
let lead: ActionContext;
let agent: ActionContext;
let field: ActionContext;
let pm: ActionContext;
let foreign: ActionContext;

/** The pending leave request of EMP-00009 (approver: the team lead) and its approval, made overdue. */
let leaveRequest: { id: string; number: number; approvalId: string };
/** The seeded TMP ticket (reporter EMP-00025), marked as breaching its SLA. */
let tmpTicket: { id: string; number: number };

const dashboards = (cache: DashboardCache = new DashboardCache(null)) =>
  new DashboardService(s.tenantDb, s.tenant, cache, clock);
const attention = (cache: DashboardCache = new DashboardCache(null)) =>
  new NeedsAttentionService(s.tenantDb, s.tenant, cache, clock);

const find = (who: ActionContext, q: string, types?: readonly SearchType[], extra: Partial<SearchInput> = {}) =>
  s.as(who, () => search.search(who, { q, types, ...extra }));

const titles = async (who: ActionContext, q: string, type: SearchType): Promise<string[]> =>
  (await find(who, q, [type])).groups.flatMap((group) => group.items.map((item) => item.title));

const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

interface Page {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
}

/**
 * The length of the list a dashboard link opens: the link's query is parsed by the same schema the API
 * applies to that list endpoint and every page is read through the list service.
 */
async function listLength(who: ActionContext, link: DashboardLink): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const raw = { ...link.query, limit: '100', ...(cursor === undefined ? {} : { cursor }) };
    let page: Page;
    if (link.path === '/support') {
      page = await s.as(who, () => tickets.list(who, ticketListQuerySchema.parse(raw)));
    } else if (link.path === '/projects') {
      page = await s.as(who, () => projects.list(who, projectListQuerySchema.parse(raw)));
    } else if (link.path === '/requests') {
      page = await s.as(who, () => requests.list(who, requestListQuerySchema.parse(raw)));
    } else if (link.path === '/approvals') {
      page = await s.as(who, () => approvals.inbox(who, approvalInboxQuerySchema.parse(raw)));
    } else if (link.path === '/attendance/team' && link.hash === 'day') {
      page = await s.as(who, () => attendance.teamDay(who, attendanceTeamDayQuerySchema.parse(raw)));
    } else if (link.path === '/tenders') {
      page = await s.as(who, () => tenders.list(who, tenderListQuerySchema.parse(raw)));
    } else if (link.path === '/contracts') {
      page = await s.as(who, () => contracts.list(who, contractListQuerySchema.parse(raw)));
    } else if (link.path === '/documents') {
      page = await s.as(who, () => corporateDocuments.list(who, corporateDocumentListQuerySchema.parse(raw)));
    } else {
      throw new Error(`No list for ${link.path}#${String(link.hash)}`);
    }
    total += page.items.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return total;
}

const isMetric = (value: unknown): value is DashboardMetric =>
  typeof value === 'object' &&
  value !== null &&
  'value' in value &&
  typeof value.value === 'number' &&
  'link' in value &&
  typeof value.link === 'object';

/** Every linked metric in a dashboard response, with its path for failure messages. */
function metricsOf(value: unknown, path = ''): { path: string; metric: DashboardMetric }[] {
  if (isMetric(value)) {
    return value.link === null ? [] : [{ path, metric: value }];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => metricsOf(child, path === '' ? key : `${path}.${key}`));
}

/** Asserts that each linked number equals the length of the list its link opens (skips the review queue). */
async function expectConsistent(who: ActionContext, response: unknown): Promise<number> {
  let checked = 0;
  for (const { path, metric } of metricsOf(response)) {
    const link = metric.link;
    if (link === null || link.hash === 'reviews') continue;
    expect({ path, value: await listLength(who, link) }).toEqual({ path, value: metric.value });
    checked += 1;
  }
  return checked;
}

beforeAll(async () => {
  s = await startSeededDatabase();
  tickets = new TicketService(s.tenantDb, s.tenant, clock);
  projects = new ProjectService(s.tenantDb, s.tenant);
  requests = new RequestService(s.tenantDb, s.tenant, clock);
  approvals = new ApprovalService(s.tenantDb, s.tenant, clock);
  attendance = new AttendanceService(s.tenantDb, s.tenant, clock);
  tenders = new TenderService(s.tenantDb, s.tenant, clock);
  contracts = new ContractService(s.tenantDb, s.tenant, clock);
  corporateDocuments = new CorporateDocumentService(s.tenantDb, s.tenant, clock);
  search = new SearchService(s.tenantDb, s.tenant);
  checklist = new SetupChecklistService(s.tenantDb, s.tenant);
  preferences = new NotificationPreferenceService(s.tenantDb, s.tenant);
  admin = await s.actionFor('EMP-00001');
  gm = await s.actionFor('EMP-00002');
  hr = await s.actionFor('EMP-00003');
  employee = await s.actionFor('EMP-00004');
  lead = await s.actionFor('EMP-00008');
  agent = await s.actionFor('EMP-00018');
  field = await s.actionFor('EMP-00024');
  pm = await s.actionFor('EMP-00041');
  foreign = await s.actionFor('NW-001', s.northwindId);

  // A pending leave request of EMP-00009; its approval (assigned to the team lead) is overdue.
  const requester = await s.actionFor('EMP-00009');
  const leaveType = await s.prisma.requestType.findFirstOrThrow({
    where: { organizationId: s.demoId, key: 'leave' },
    select: { id: true },
  });
  const start = dateOnly(new Date(now.getTime() + 60 * 86_400_000));
  const created = await s.as(requester, () =>
    requests.create(
      requester,
      { requestTypeId: leaveType.id, formData: { leaveType: 'annual', dates: { start, end: start } }, submit: true },
      undefined,
    ),
  );
  const approval = await s.prisma.requestApproval.findFirstOrThrow({
    where: { requestId: created.id, status: 'PENDING' },
    select: { id: true, approverMemberId: true },
  });
  expect(approval.approverMemberId).toBe(lead.principal.memberId);
  await s.prisma.requestApproval.update({
    where: { id: approval.id },
    data: { dueAt: new Date(now.getTime() - 3_600_000) },
  });
  const number = await s.prisma.requestInstance.findUniqueOrThrow({
    where: { id: created.id },
    select: { number: true },
  });
  leaveRequest = { id: created.id, number: number.number, approvalId: approval.id };

  const ticket = await s.prisma.supportTicket.findFirstOrThrow({
    where: { organizationId: s.demoId, title: 'Gate 3 camera feed drops every few minutes' },
    select: { id: true, number: true },
  });
  await s.prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      firstResponseSlaState: 'AT_RISK',
      resolutionSlaState: 'BREACHED',
      resolutionDueAt: new Date(now.getTime() - 7_200_000),
    },
  });
  tmpTicket = ticket;
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('role dashboards: permissions and scopes', () => {
  it('an employee gets only the personal dashboard; every management view is refused', async () => {
    const service = dashboards();
    const me = await s.as(employee, () => service.me(employee));
    expect(me.approvals).not.toBeNull();
    // support.view SELF: reports tickets, does not work them.
    expect(me.assignedTickets).toBeNull();
    expect(me.projects).toEqual([]);
    await expect(s.as(employee, () => service.team(employee))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(employee, () => service.support(employee))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(employee, () => service.projects(employee))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(employee, () => service.executive(employee))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(employee, () => service.trend(employee, 'support_flow', '7d'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.as(employee, () => service.trend(employee, 'attendance_presence', '7d'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('a field employee sees only assigned projects and the support queue of those projects', async () => {
    const service = dashboards();
    const me = await s.as(field, () => service.me(field));
    expect(me.projects.map((project) => project.code)).toEqual(['TMP']);
    expect(me.projects[0]?.link).toEqual({
      path: `/projects/${me.projects[0]?.id ?? ''}`,
      query: {},
      hash: 'overview',
    });
    const support = await s.as(field, () => service.support(field));
    // Only the TMP ticket is in a PROJECT-scoped queue of a TMP member.
    expect(support.support.open.value).toBe(1);
    expect(support.support.slaBreached.value).toBe(1);
    await expect(s.as(field, () => service.projects(field))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(field, () => service.team(field))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a support agent gets the organization queue but no project or executive dashboard', async () => {
    const service = dashboards();
    const support = await s.as(agent, () => service.support(agent));
    expect(support.support.open.value).toBe(2);
    expect(support.support.assignedToMe?.value).toBe(0);
    expect(support.support.slaAtRisk.value).toBe(1);
    expect(support.support.slaBreached.value).toBe(1);
    await expect(s.as(agent, () => service.projects(agent))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(agent, () => service.executive(agent))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a project manager sees health only for the projects they manage', async () => {
    const result = await s.as(pm, () => dashboards().projects(pm));
    expect(result.projects.watchlist.map((item) => item.code)).toEqual(['IHD']);
    expect(result.projects.active.value).toBe(1);
    expect(result.projects.healthy.value).toBe(1);
    // github.view / jira.view PROJECT: present, nothing connected in the seed.
    expect(result.development.jira?.freshness).toEqual({ status: 'NOT_CONNECTED', lastSyncAt: null, stale: false });
    expect(result.development.github?.freshness.status).toBe('NOT_CONNECTED');
  });

  it('the general manager gets every executive section; HR gets the team view but not the executive one', async () => {
    const executive = await s.as(gm, () => dashboards().executive(gm));
    expect(executive.today).not.toBeNull();
    expect(executive.projects?.active.value).toBe(3);
    expect(executive.support?.open.value).toBe(2);
    expect(executive.development.jira).not.toBeNull();
    const team = await s.as(hr, () => dashboards().team(hr));
    expect(team.attendance.employees.value).toBeGreaterThan(30);
    await expect(s.as(hr, () => dashboards().executive(hr))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a team lead's attendance view covers only the team", async () => {
    const team = await s.as(lead, () => dashboards().team(lead));
    // The lead plus EMP-00009/10/11/28.
    expect(team.attendance.employees.value).toBe(4);
    expect(team.attendance.employees.link).toEqual({
      path: '/attendance/team',
      query: { date: team.attendance.date },
      hash: 'day',
    });
  });

  it('is tenant-isolated: the second organization sees none of the demo data', async () => {
    const executive = await s.as(foreign, () => dashboards().executive(foreign));
    expect(executive.projects?.active.value).toBe(0);
    expect(executive.support?.open.value).toBe(0);
    expect(executive.today?.employees.value).toBe(3);
    const feed = await s.as(foreign, () => attention().list(foreign));
    expect(feed.items).toEqual([]);
  });
});

describe('count = linked list length', () => {
  it.each([
    ['general manager', () => gm],
    ['team lead', () => lead],
    ['support agent', () => agent],
    ['field employee', () => field],
    ['project manager', () => pm],
    ['HR admin', () => hr],
    ['employee', () => employee],
  ])('every linked number on the dashboards of the %s', async (_label, who) => {
    const actor = who();
    const service = dashboards();
    const responses: unknown[] = [await s.as(actor, () => service.me(actor))];
    const optional = async (read: () => Promise<unknown>): Promise<void> => {
      try {
        responses.push(await read());
      } catch (error: unknown) {
        if (!(error instanceof ForbiddenError)) throw error;
      }
    };
    await optional(() => s.as(actor, () => service.team(actor)));
    await optional(() => s.as(actor, () => service.support(actor)));
    await optional(() => s.as(actor, () => service.projects(actor)));
    await optional(() => s.as(actor, () => service.executive(actor)));
    let checked = 0;
    for (const response of responses) checked += await expectConsistent(actor, response);
    expect(checked).toBeGreaterThan(0);
  });

  it('the overdue approval appears in the waiting and overdue numbers and their filtered inboxes', async () => {
    const me = await s.as(lead, () => dashboards().me(lead));
    expect(me.approvals?.waiting.value).toBe(1);
    expect(me.approvals?.overdue.value).toBe(1);
    expect(me.approvals?.overdue.link).toEqual({ path: '/approvals', query: { overdue: 'true' }, hash: null });
    const requester = await s.actionFor('EMP-00009');
    const mine = await s.as(requester, () => dashboards().me(requester));
    expect(mine.myPendingRequests.value).toBe(1);
    expect(await listLength(requester, mine.myPendingRequests.link ?? { path: '', query: {}, hash: null })).toBe(1);
  });

  it('support links always carry the queue view, so the screen never applies its own default', async () => {
    const support = await s.as(agent, () => dashboards().support(agent));
    for (const { metric } of metricsOf(support)) {
      expect(metric.link?.query.view).toBeDefined();
    }
    expect(support.support.escalated.link?.query).toEqual({ view: 'all', status: 'ESCALATED' });
  });
});

describe('needs attention', () => {
  it('shows the overdue approval to its approver only, with a deep link to the request', async () => {
    const feed = await s.as(lead, () => attention().list(lead));
    const item = feed.items.find((entry) => entry.entity.id === leaveRequest.approvalId);
    expect(item).toMatchObject({
      type: 'APPROVAL_OVERDUE',
      severity: 'HIGH',
      params: { key: `REQ-${String(leaveRequest.number)}` },
      link: { path: `/requests/${leaveRequest.id}`, query: {}, hash: null },
      scope: 'SELF',
    });
    for (const other of [employee, agent, gm]) {
      const theirs = await s.as(other, () => attention().list(other));
      expect(theirs.items.some((entry) => entry.entity.id === leaveRequest.approvalId)).toBe(false);
    }
  });

  it('deduplicates a ticket that is both at risk and breached, and hides it from people outside its scope', async () => {
    const feed = await s.as(agent, () => attention().list(agent));
    const forTicket = feed.items.filter((entry) => entry.entity.id === tmpTicket.id);
    expect(forTicket).toHaveLength(1);
    expect(forTicket[0]).toMatchObject({ type: 'TICKET_SLA_BREACHED', scope: 'ORG' });
    const fieldFeed = await s.as(field, () => attention().list(field));
    expect(fieldFeed.items.filter((entry) => entry.entity.id === tmpTicket.id)).toHaveLength(1);
    const employeeFeed = await s.as(employee, () => attention().list(employee));
    expect(employeeFeed.items.some((entry) => entry.entity.id === tmpTicket.id)).toBe(false);
  });

  it('orders by severity, then waiting time', async () => {
    const feed = await s.as(gm, () => attention().list(gm));
    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
    for (let index = 1; index < feed.items.length; index += 1) {
      const previous = feed.items[index - 1];
      const current = feed.items[index];
      if (previous === undefined || current === undefined) continue;
      expect(rank[previous.severity]).toBeLessThanOrEqual(rank[current.severity]);
    }
    expect(feed.total).toBeGreaterThanOrEqual(feed.items.length);
  });
});

describe('trends', () => {
  it('support flow: organization-zone daily buckets equal the tickets created in the window', async () => {
    const trend = await s.as(agent, () => dashboards().trend(agent, 'support_flow', '7d'));
    expect(trend.dates).toHaveLength(7);
    expect(trend.timeZone).toBe('Africa/Cairo');
    const window = rangeWindow('7d', now, 'Africa/Cairo');
    expect(trend.dates).toEqual(window.dates);
    const created = trend.series.find((series) => series.key === 'created');
    const total = (created?.values ?? []).reduce((sum, value) => sum + value, 0);
    const listed = await listLength(agent, {
      path: '/support',
      query: { view: 'all', createdFrom: window.start.toISOString(), createdTo: window.end.toISOString() },
      hash: null,
    });
    expect(total).toBe(listed);
    expect(total).toBe(2);
  });

  it('respects scope: the field employee counts only TMP tickets; 90 days have 90 buckets', async () => {
    const trend = await s.as(field, () => dashboards().trend(field, 'support_flow', '90d'));
    expect(trend.dates).toHaveLength(90);
    const created = trend.series.find((series) => series.key === 'created');
    expect((created?.values ?? []).reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it('attendance presence needs attendance.team', async () => {
    const trend = await s.as(lead, () => dashboards().trend(lead, 'attendance_presence', '30d'));
    expect(trend.series.map((series) => series.key)).toEqual(['present']);
    expect(trend.series[0]?.values).toHaveLength(30);
    await expect(s.as(agent, () => dashboards().trend(agent, 'attendance_presence', '30d'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('dashboard cache security', () => {
  it('never serves one scope to another: different scopes, members and tenants get their own entries', async () => {
    const store = new InMemoryDashboardCacheStore();
    const service = dashboards(new DashboardCache(store));
    const agentView = await s.as(agent, () => service.support(agent));
    const fieldView = await s.as(field, () => service.support(field));
    expect(agentView.support.open.value).toBe(2);
    expect(fieldView.support.open.value).toBe(1);
    // Same role and scope, but "assigned to me" is personal: a second agent gets its own entry.
    const otherAgent = await s.actionFor('EMP-00019');
    await s.as(otherAgent, () => service.support(otherAgent));
    const supportKeys = [...store.entries.keys()].filter((key) => key.includes(':support:'));
    expect(supportKeys).toHaveLength(3);
    const executiveDemo = await s.as(gm, () => service.executive(gm));
    const executiveForeign = await s.as(foreign, () => service.executive(foreign));
    expect(executiveDemo.projects?.active.value).toBe(3);
    expect(executiveForeign.projects?.active.value).toBe(0);
    const keys = [...store.entries.keys()].filter((key) => key.startsWith('dash:v1:'));
    expect(keys.some((key) => key.startsWith(`dash:v1:${s.northwindId}:executive:`))).toBe(true);
    expect(
      keys.every((key) => key.startsWith(`dash:v1:${s.demoId}:`) || key.startsWith(`dash:v1:${s.northwindId}:`)),
    ).toBe(true);
  });

  it('checks the permission before reading the cache', async () => {
    const store = new InMemoryDashboardCacheStore();
    const service = dashboards(new DashboardCache(store));
    await s.as(gm, () => service.executive(gm));
    await s.as(gm, () => service.projects(gm));
    await expect(s.as(employee, () => service.executive(employee))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(agent, () => service.projects(agent))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a domain version bump retires cached numbers; other tenants are unaffected', async () => {
    const store = new InMemoryDashboardCacheStore();
    const service = dashboards(new DashboardCache(store));
    const before = await s.as(gm, () => service.projects(gm));
    const foreignBefore = await s.as(foreign, () => service.projects(foreign));
    const max = await s.prisma.project.aggregate({ where: { organizationId: s.demoId }, _max: { number: true } });
    const added = await s.prisma.project.create({
      data: {
        organizationId: s.demoId,
        number: (max._max.number ?? 0) + 1,
        code: 'CACHE',
        name: 'Cache probe',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    try {
      // Cached: the change is not visible until its event bumps the version.
      expect((await s.as(gm, () => service.projects(gm))).projects.active.value).toBe(before.projects.active.value);
      await bumpDashboardVersions(store, s.demoId, ['projects']);
      expect((await s.as(gm, () => service.projects(gm))).projects.active.value).toBe(before.projects.active.value + 1);
      expect(await store.get(`dash:ver:${s.northwindId}:projects`)).toBeNull();
      expect(await s.as(foreign, () => service.projects(foreign))).toEqual(foreignBefore);
    } finally {
      await s.prisma.project.delete({ where: { id: added.id } });
    }
  });

  it('falls back to the source tables when the cache fails or hangs', async () => {
    const failing: DashboardCacheStore = {
      get: () => Promise.reject(new Error('down')),
      mget: () => Promise.reject(new Error('down')),
      setWithTtl: () => Promise.reject(new Error('down')),
      increment: () => Promise.reject(new Error('down')),
    };
    const hanging: DashboardCacheStore = {
      get: () => new Promise(() => undefined),
      mget: () => new Promise(() => undefined),
      setWithTtl: () => new Promise(() => undefined),
      increment: () => new Promise(() => undefined),
    };
    const errors: string[] = [];
    const reference = await s.as(agent, () => dashboards().support(agent));
    for (const store of [failing, hanging]) {
      const cache = new DashboardCache(store, (operation) => errors.push(operation), 60, 50);
      const result = await s.as(agent, () => dashboards(cache).support(agent));
      expect(result.support).toEqual(reference.support);
    }
    expect(errors).toEqual(['versions', 'versions']);
    await bumpDashboardVersions(failing, s.demoId, ['support'], (operation) => errors.push(operation));
    expect(errors.at(-1)).toBe('bump');
  });
});

describe('global search security', () => {
  it('returns an accessible project and hides an inaccessible one', async () => {
    expect(await titles(field, 'Traffic', 'projects')).toEqual(['Traffic Management Platform']);
    expect(await titles(field, 'Retail', 'projects')).toEqual([]);
    expect(await titles(field, 'POS', 'projects')).toEqual([]);
    expect(await titles(employee, 'Traffic', 'projects')).toEqual([]);
    expect(await titles(gm, 'Retail', 'projects')).toEqual(['Retail POS Rollout']);
    const [group] = (await find(field, 'TMP', ['projects'])).groups;
    expect(group?.items[0]?.key).toBe('TMP');
    expect(group?.items[0]?.link.path).toMatch(/^\/projects\//);
  });

  it('is tenant-isolated in both directions', async () => {
    expect(await titles(foreign, 'Traffic', 'projects')).toEqual([]);
    expect(await titles(foreign, 'Salma', 'employees')).toEqual([]);
    expect(await titles(gm, 'Paula', 'employees')).toEqual([]);
    expect(await titles(foreign, 'Paula', 'employees')).toEqual(['Paula Jensen']);
  });

  it('matches work email only for callers who may see contact details', async () => {
    expect(await titles(admin, 'salma.adel', 'employees')).toEqual(['Salma Adel']);
    expect(await titles(employee, 'salma.adel', 'employees')).toEqual([]);
    expect(await titles(employee, 'Salma', 'employees')).toEqual(['Salma Adel']);
  });

  it('finds tickets by title and key in the support.view scope only', async () => {
    expect(await titles(agent, 'camera', 'tickets')).toEqual(['Gate 3 camera feed drops every few minutes']);
    const key = `SUP-${String(tmpTicket.number)}`;
    const byKey = await find(agent, key, ['tickets']);
    expect(byKey.groups[0]?.items[0]).toMatchObject({ key, link: { path: `/support/tickets/${tmpTicket.id}` } });
    expect(await titles(field, 'camera', 'tickets')).toHaveLength(1);
    expect(await titles(field, 'Helpdesk portal', 'tickets')).toEqual([]);
    expect(await titles(employee, 'camera', 'tickets')).toEqual([]);
  });

  it('finds requests by key and type for the requester and scope holders, never for peers', async () => {
    const key = `REQ-${String(leaveRequest.number)}`;
    const requester = await s.actionFor('EMP-00009');
    const peer = await s.actionFor('EMP-00010');
    const ids = async (who: ActionContext, q: string) =>
      (await find(who, q, ['requests'])).groups.flatMap((group) => group.items.map((item) => item.id));
    expect(await ids(requester, key)).toEqual([leaveRequest.id]);
    expect(await ids(requester, 'leave')).toContain(leaveRequest.id);
    expect(await ids(lead, key)).toEqual([leaveRequest.id]);
    expect(await ids(hr, key)).toEqual([leaveRequest.id]);
    expect(await ids(gm, key)).toEqual([leaveRequest.id]);
    expect(await ids(peer, key)).toEqual([]);
    // Regression: organization-wide request.view matched nothing beyond own requests (empty `OR` branch).
    for (const holder of [hr, gm, admin]) {
      const page = await s.as(holder, () => requests.list(holder, { view: 'all', q: key }));
      expect(page.items.map((item) => item.id)).toEqual([leaveRequest.id]);
    }
    expect(await ids(foreign, key)).toEqual([]);
  });

  it('treats LIKE wildcards as literal text (regression: unescaped % and _ matched everything)', async () => {
    const max = await s.prisma.project.aggregate({ where: { organizationId: s.demoId }, _max: { number: true } });
    const added = await s.prisma.project.create({
      data: {
        organizationId: s.demoId,
        number: (max._max.number ?? 0) + 1,
        code: 'PCT',
        name: 'Rollout 50% Phase',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    try {
      expect(await titles(gm, '50%', 'projects')).toEqual(['Rollout 50% Phase']);
      for (const q of ['%%', '__', '5_%', '\\%']) {
        const response = await find(gm, q);
        expect({ q, items: response.groups.flatMap((group) => group.items) }).toEqual({ q, items: [] });
      }
    } finally {
      await s.prisma.project.delete({ where: { id: added.id } });
    }
  });

  it('is bounded: short, long and foreign-cursor queries are rejected; pages are capped', async () => {
    await expect(find(gm, 'a')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(find(gm, 'x'.repeat(101))).rejects.toBeInstanceOf(InvalidInputError);
    const first = await find(gm, 'an', ['employees'], { limit: 2 });
    const cursor = first.groups[0]?.nextCursor;
    expect(first.groups[0]?.items).toHaveLength(2);
    expect(cursor).toBeTruthy();
    const second = await find(gm, 'an', ['employees'], { limit: 2, cursor: cursor ?? '' });
    const firstIds = new Set(first.groups[0]?.items.map((item) => item.id));
    expect(second.groups[0]?.items.some((item) => firstIds.has(item.id))).toBe(false);
    await expect(find(gm, 'ah', ['employees'], { cursor: cursor ?? '' })).rejects.toBeInstanceOf(InvalidInputError);
    const all = await find(gm, 'an', undefined, { limit: 50 });
    for (const group of all.groups) expect(group.items.length).toBeLessThanOrEqual(10);
  });

  it('jira results need jira.view and only come from mapped, connected projects', async () => {
    const response = await find(gm, 'TMP', ['jira']);
    expect(response.groups).toEqual([{ type: 'jira', items: [], nextCursor: null }]);
    expect((await find(employee, 'TMP', ['jira'])).groups[0]?.items).toEqual([]);
  });
});

describe('setup checklist', () => {
  it('is for organization administrators only and reflects the current rows', async () => {
    const result = await s.as(admin, () => checklist.get(admin));
    const byKey = new Map(result.items.map((item) => [item.key, item]));
    expect(byKey.get('organization')?.done).toBe(true);
    expect(byKey.get('departments')).toMatchObject({ done: true, link: { path: '/departments' } });
    expect(byKey.get('projects')).toMatchObject({ done: true, count: 3 });
    expect(byKey.get('jira')).toMatchObject({ done: false, optional: true });
    expect(byKey.get('github')).toMatchObject({ done: false, optional: true });
    expect(result.completed).toBeLessThanOrEqual(result.required);
    for (const who of [gm, hr, employee, foreign]) {
      await expect(s.as(who, () => checklist.get(who))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('notification preferences', () => {
  const request = (
    recipientMemberId: string,
    type: string,
    severity: NotificationRequestedPayload['severity'],
    dedupeKey: string,
  ): NotificationRequestedPayload => ({
    recipientMemberId,
    type,
    severity,
    entityType: null,
    entityId: null,
    params: {},
    dedupeKey,
    email: true,
  });

  it('lists every category with the locked combinations and refuses to turn them off', async () => {
    const owner = await s.actionFor('EMP-00011');
    const { items } = await s.as(owner, () => preferences.get(owner));
    expect(items.find((item) => item.category === 'ACCESS')).toEqual({
      category: 'ACCESS',
      inApp: true,
      email: true,
      inAppLocked: true,
      emailLocked: true,
    });
    expect(items.find((item) => item.category === 'INTEGRATIONS')).toMatchObject({
      inAppLocked: true,
      emailLocked: false,
    });
    await expect(
      s.as(owner, () => preferences.update(owner, [{ category: 'ACCESS', channel: 'EMAIL', enabled: false }])),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(owner, () => preferences.update(owner, [{ category: 'INTEGRATIONS', channel: 'IN_APP', enabled: false }])),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(owner, () =>
        preferences.update(owner, [
          { category: 'SUPPORT', channel: 'EMAIL', enabled: false },
          { category: 'SUPPORT', channel: 'EMAIL', enabled: true },
        ]),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('applies only to the caller, is audited, and mutes in-app and email except for critical notices', async () => {
    const owner = await s.actionFor('EMP-00011');
    const other = await s.actionFor('EMP-00010');
    const updated = await s.as(owner, () =>
      preferences.update(owner, [
        { category: 'REQUESTS', channel: 'IN_APP', enabled: false },
        { category: 'REQUESTS', channel: 'EMAIL', enabled: false },
      ]),
    );
    expect(updated.items.find((item) => item.category === 'REQUESTS')).toMatchObject({ inApp: false, email: false });
    const others = await s.as(other, () => preferences.get(other));
    expect(others.items.find((item) => item.category === 'REQUESTS')).toMatchObject({ inApp: true, email: true });
    expect(
      await s.prisma.auditLog.count({
        where: {
          organizationId: s.demoId,
          action: 'notification.preferences.updated',
          entityId: owner.principal.memberId,
        },
      }),
    ).toBe(1);

    const writer = new NotificationWriter(s.tenantDb, s.tenant);
    const muted = await s.asSystem(s.demoId, () =>
      writer.create(request(owner.principal.memberId, 'REQUEST_APPROVED', 'INFO', 'pref-muted')),
    );
    expect(muted).toMatchObject({ kind: 'created', recipientUserId: null });
    const mutedId = muted.kind === 'recipient_not_found' ? '' : muted.notificationId;
    const mutedRow = await s.prisma.notification.findUniqueOrThrow({
      where: { id: mutedId },
      select: { readAt: true },
    });
    expect(mutedRow.readAt).not.toBeNull();
    expect(await s.prisma.notificationDelivery.count({ where: { notificationId: mutedId } })).toBe(0);

    const critical = await s.asSystem(s.demoId, () =>
      writer.create(request(owner.principal.memberId, 'REQUEST_APPROVED', 'CRITICAL', 'pref-critical')),
    );
    expect(critical).toMatchObject({ kind: 'created', recipientUserId: owner.principal.userId });
    const criticalId = critical.kind === 'recipient_not_found' ? '' : critical.notificationId;
    const criticalRow = await s.prisma.notification.findUniqueOrThrow({
      where: { id: criticalId },
      select: { readAt: true },
    });
    expect(criticalRow.readAt).toBeNull();
    expect(await s.prisma.notificationDelivery.count({ where: { notificationId: criticalId } })).toBe(1);
  });

  it('the worker re-checks the preference before sending a queued email', async () => {
    const owner = await s.actionFor('EMP-00028');
    const writer = new NotificationWriter(s.tenantDb, s.tenant);
    const created = await s.asSystem(s.demoId, () =>
      writer.create(request(owner.principal.memberId, 'SUPPORT_TICKET_ASSIGNED', 'INFO', 'pref-recheck')),
    );
    const notificationId = created.kind === 'recipient_not_found' ? '' : created.notificationId;
    const delivery = await s.prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId },
      select: { id: true },
    });
    await s.as(owner, () => preferences.update(owner, [{ category: 'SUPPORT', channel: 'EMAIL', enabled: false }]));
    const sent: EmailMessage[] = [];
    const channel: EmailChannel = {
      enabled: true,
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const service = new NotificationDeliveryService(
      s.tenantDb,
      s.tenant,
      channel,
      'http://localhost:3000',
      'localhost',
      notificationEntityAccess(s.tenantDb),
    );
    expect(await s.asSystem(s.demoId, () => service.send(delivery.id))).toBe('skipped_preference');
    expect(sent).toEqual([]);
    expect(
      await s.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: { status: true } }),
    ).toEqual({ status: 'SKIPPED' });
  });
});
