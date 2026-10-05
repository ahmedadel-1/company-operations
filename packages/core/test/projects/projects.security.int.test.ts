import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttachmentService } from '../../src/modules/attachments/attachment.service.js';
import { NotificationWriter } from '../../src/modules/notifications/notification.service.js';
import { CustomerService } from '../../src/modules/projects/customer.service.js';
import {
  DailyReportAttachmentPolicy,
  DailyReportMissingCheck,
  DailyReportService,
} from '../../src/modules/projects/daily-report.service.js';
import {
  parseActivityPayload,
  ProjectActivityService,
  ProjectActivityWriter,
} from '../../src/modules/projects/project-activity.js';
import { ProjectMemberService } from '../../src/modules/projects/project-member.service.js';
import { ProjectService } from '../../src/modules/projects/project.service.js';
import { rebuildProjectActivity } from '../../src/modules/projects/rebuild-activity.js';
import { ProjectLocationService, WorkLocationService } from '../../src/modules/projects/work-location.service.js';
import { localToday, addDays } from '../../src/modules/projects/business-date.js';
import { organizationsRequiringDailyReports } from '../../src/platform/db/sql/daily-report-check.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../src/platform/errors.js';
import { Prisma } from '../../src/platform/db/prisma.js';
import { NO_SCAN } from '../../src/platform/storage/storage-port.js';
import type { StoragePort } from '../../src/platform/storage/storage-port.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Phase 2 projects module against a real PostgreSQL with the development seed: tenant integrity
 * (composite keys, scoped services), PROJECT scope, membership escalation rules, optimistic
 * concurrency, counters under concurrency, daily reports, derived missing reports, the activity
 * consumer and daily-report attachments.
 */
let s: SeededDatabase;
let customers: CustomerService;
let projects: ProjectService;
let members: ProjectMemberService;
let locations: WorkLocationService;
let projectLocations: ProjectLocationService;
let reports: DailyReportService;
let activity: ProjectActivityService;
let writer: ProjectActivityWriter;
let attachments: AttachmentService;

const deleted: string[] = [];
const storage: StoragePort = {
  presignUpload: ({ key }) => Promise.resolve(`http://storage.test/${key}?signed`),
  presignDownload: ({ key }) => Promise.resolve(`http://storage.test/${key}?download`),
  head: () => Promise.resolve(null),
  read: () => Promise.reject(new Error('not used')),
  delete: (key) => {
    deleted.push(key);
    return Promise.resolve();
  },
};

async function projectId(code: string, organizationId = s.demoId): Promise<string> {
  return (await s.prisma.project.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } })).id;
}

async function grantRole(employeeNumber: string, key: string): Promise<void> {
  const employee = await s.employee(employeeNumber);
  const role = await s.prisma.role.findFirstOrThrow({ where: { organizationId: s.demoId, key }, select: { id: true } });
  await s.prisma.memberRole.create({
    data: { organizationId: s.demoId, memberId: employee.memberId, roleId: role.id },
  });
}

const expectFkViolation = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
  );
};

async function versionOf(id: string): Promise<number> {
  return (await s.prisma.project.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
}

/** Drains `project.activity.recorded` outbox events into the timeline, like the worker consumer. */
async function drainActivity(organizationId = s.demoId): Promise<void> {
  const events = await s.prisma.outboxEvent.findMany({
    where: { organizationId, eventType: 'project.activity.recorded' },
    orderBy: { id: 'asc' },
    select: { id: true, payload: true },
  });
  for (const event of events) {
    const payload = parseActivityPayload(event.payload);
    if (payload !== null) {
      await s.asSystem(organizationId, () => writer.record(event.id, payload));
    }
  }
}

beforeAll(async () => {
  s = await startSeededDatabase();
  customers = new CustomerService(s.tenantDb, s.tenant);
  projects = new ProjectService(s.tenantDb, s.tenant);
  members = new ProjectMemberService(s.tenantDb, s.tenant);
  locations = new WorkLocationService(s.tenantDb, s.tenant);
  projectLocations = new ProjectLocationService(s.tenantDb, s.tenant);
  reports = new DailyReportService(s.tenantDb, s.tenant);
  activity = new ProjectActivityService(s.tenantDb, s.tenant);
  writer = new ProjectActivityWriter(s.tenantDb, s.tenant);
  attachments = new AttachmentService(
    s.tenantDb,
    s.tenant,
    storage,
    [new DailyReportAttachmentPolicy(reports)],
    NO_SCAN,
  );
  // A project-scoped project manager: Laila (EMP-00013) manages TMP in the seed.
  await grantRole('EMP-00013', 'PROJECT_MANAGER');
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('customers', () => {
  it('org-wide project administrators manage customers; others cannot', async () => {
    const tm = await s.actionFor('EMP-00006');
    const created = await s.as(tm, () =>
      customers.create(tm, { name: 'Acme Utilities', type: 'PRIVATE', contactEmail: 'ops@acme.test' }),
    );
    expect(created).toMatchObject({ name: 'Acme Utilities', archived: false });
    await expect(
      s.as(tm, () => customers.create(tm, { name: 'acme utilities', type: 'PRIVATE' })),
    ).rejects.toBeInstanceOf(ConflictError);
    const archived = await s.as(tm, () => customers.update(tm, created.id, { archived: true }));
    expect(archived.archived).toBe(true);
    const page = await s.as(tm, () => customers.list(tm, { limit: 100 }));
    expect(page.items.some((c) => c.id === created.id)).toBe(false);

    const employee = await s.actionFor('EMP-00004');
    await expect(s.as(employee, () => customers.list(employee, {}))).rejects.toBeInstanceOf(ForbiddenError);
    const pm = await s.actionFor('EMP-00013');
    expect((await s.as(pm, () => customers.list(pm, {}))).items.length).toBeGreaterThan(0);
    await expect(s.as(pm, () => customers.create(pm, { name: 'Nope', type: 'PRIVATE' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('foreign customers are not found', async () => {
    const tm = await s.actionFor('EMP-00006');
    const foreign = await s.prisma.customer.create({
      data: { organizationId: s.northwindId, name: 'Northwind Customer', type: 'PRIVATE' },
      select: { id: true },
    });
    await expect(s.as(tm, () => customers.get(tm, foreign.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(tm, () => customers.update(tm, foreign.id, { name: 'Hijacked' }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(tm, () => projects.create(tm, { name: 'X', customerId: foreign.id }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('project creation and codes', () => {
  it('allocates PRJ numbers from the organization counter, safely under concurrency', async () => {
    const tm = await s.actionFor('EMP-00006');
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.as(tm, () => projects.create(tm, { name: `Concurrent ${String(i)}` }))),
    );
    const numbers = created.map((p) => p.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(8);
    expect((numbers.at(-1) ?? 0) - (numbers[0] ?? 0)).toBe(7);
    expect(created.every((p) => p.code === `PRJ-${String(p.number)}` && p.status === 'PLANNING')).toBe(true);
  });

  it('rejects duplicate codes (case-insensitive) and skips taken default codes', async () => {
    const tm = await s.actionFor('EMP-00006');
    await s.as(tm, () => projects.create(tm, { name: 'Coded', code: 'ALPHA' }));
    await expect(s.as(tm, () => projects.create(tm, { name: 'Dup', code: 'alpha' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    const counter = await s.prisma.organizationCounter.findFirstOrThrow({
      where: { organizationId: s.demoId, key: 'PRJ' },
    });
    const next = Number(counter.value) + 1;
    await s.as(tm, () => projects.create(tm, { name: 'Squatter', code: `PRJ-${String(next)}` }));
    const auto = await s.as(tm, () => projects.create(tm, { name: 'Auto' }));
    expect(auto.code).not.toBe(`PRJ-${String(next)}`);
  });

  it('only ORG-scoped creators may create; managers must be active employees of the organization', async () => {
    const pm = await s.actionFor('EMP-00013');
    await expect(s.as(pm, () => projects.create(pm, { name: 'Nope' }))).rejects.toBeInstanceOf(ForbiddenError);
    const tm = await s.actionFor('EMP-00006');
    const foreignProfile = await s.employee('NW-002', s.northwindId);
    await expect(
      s.as(tm, () => projects.create(tm, { name: 'X', projectManagerId: foreignProfile.profileId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const disabled = await s.employee('EMP-00005');
    await expect(
      s.as(tm, () => projects.create(tm, { name: 'X', projectManagerId: disabled.profileId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(tm, () => projects.create(tm, { name: 'X', timeZone: 'Mars/Base' }))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      s.as(tm, () => projects.create(tm, { name: 'X', startDate: '2026-10-10', targetEndDate: '2026-10-01' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('PROJECT scope: visibility and list filters', () => {
  it('a member sees only projects they staff; unknown and foreign projects are 404', async () => {
    const field = await s.actionFor('EMP-00024');
    const visible = await s.as(field, () => projects.list(field, { limit: 100 }));
    expect(visible.items.map((p) => p.code)).toEqual(['TMP']);
    await expect(s.as(field, async () => projects.get(field, await projectId('POS')))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const employee = await s.actionFor('EMP-00004');
    expect((await s.as(employee, () => projects.list(employee, {}))).items).toHaveLength(0);
  });

  it('ORG viewers see everything; HR (no project.view) sees nothing; mine and filters narrow the list', async () => {
    const gm = await s.actionFor('EMP-00002');
    const all = await s.as(gm, () => projects.list(gm, { limit: 100 }));
    expect(all.items.map((p) => p.code)).toEqual(expect.arrayContaining(['TMP', 'POS', 'IHD']));
    const hr = await s.actionFor('EMP-00003');
    expect((await s.as(hr, () => projects.list(hr, {}))).items).toHaveLength(0);
    expect((await s.as(gm, () => projects.list(gm, { scope: 'mine' }))).items).toHaveLength(0);
    const maintenance = await s.as(gm, () => projects.list(gm, { status: ['MAINTENANCE'] }));
    expect(maintenance.items.map((p) => p.code)).toEqual(['IHD']);
    const attention = await s.as(gm, () => projects.list(gm, { health: ['NEEDS_ATTENTION'] }));
    expect(attention.items.map((p) => p.code)).toEqual(['POS']);
    const byManager = await s.as(gm, async () =>
      projects.list(gm, { managerId: (await s.employee('EMP-00013')).profileId }),
    );
    expect(byManager.items.map((p) => p.code)).toEqual(['TMP']);
  });

  it('DEPARTMENT viewers see projects staffed by their departments', async () => {
    const fieldManager = await s.actionFor('EMP-00023');
    const visible = await s.as(fieldManager, () => projects.list(fieldManager, { limit: 100 }));
    expect(visible.items.map((p) => p.code).sort()).toEqual(['POS', 'TMP']);
  });

  it('paginates with a stable keyset over every sort', async () => {
    const gm = await s.actionFor('EMP-00002');
    for (const sort of ['updatedAt:desc', 'name:asc', 'code:desc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.as(gm, () => projects.list(gm, { sort, limit: 3, cursor }));
        seen.push(...page.items.map((p) => p.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe((await s.as(gm, () => projects.list(gm, { limit: 100 }))).items.length);
    }
  });

  it('employee projects are limited to what the caller may view', async () => {
    const field = await s.actionFor('EMP-00024');
    const developer = await s.employee('EMP-00009');
    expect(await s.as(field, () => projects.listForEmployee(field, developer.profileId))).toEqual([]);
    const gm = await s.actionFor('EMP-00002');
    const own = await s.as(gm, async () => projects.listForEmployee(gm, (await s.employee('EMP-00013')).profileId));
    expect(own.map((p) => [p.project.code, p.roles])).toEqual([['TMP', ['PROJECT_MANAGER']]]);
  });
});

describe('project lifecycle, health and optimistic concurrency', () => {
  it('changes status along allowed transitions and rejects stale versions', async () => {
    const tm = await s.actionFor('EMP-00006');
    const created = await s.as(tm, () => projects.create(tm, { name: 'Lifecycle' }));
    await expect(
      s.as(tm, () => projects.setStatus(tm, created.id, { status: 'COMPLETED', version: created.version })),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const active = await s.as(tm, () =>
      projects.setStatus(tm, created.id, { status: 'ACTIVE', reason: 'Kick-off', version: created.version }),
    );
    expect(active).toMatchObject({ status: 'ACTIVE', statusReason: 'Kick-off', version: created.version + 1 });
    await expect(
      s.as(tm, () => projects.update(tm, created.id, created.version, { name: 'Stale' })),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const health = await s.as(tm, () =>
      projects.setHealth(tm, created.id, { health: 'AT_RISK', note: 'Vendor delay', version: active.version }),
    );
    expect(health).toMatchObject({ health: 'AT_RISK', healthNote: 'Vendor delay' });
    await expect(s.as(tm, () => projects.archive(tm, created.id, { version: health.version }))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    const onHold = await s.as(tm, () =>
      projects.setStatus(tm, created.id, { status: 'ON_HOLD', version: health.version }),
    );
    const archived = await s.as(tm, () =>
      projects.archive(tm, created.id, { version: onHold.version, reason: 'Paused' }),
    );
    expect(archived).toMatchObject({ status: 'ARCHIVED' });
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      s.as(tm, () => projects.update(tm, created.id, archived.version, { name: 'Edit archived' })),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const restored = await s.as(tm, () => projects.restore(tm, created.id, { version: archived.version }));
    expect(restored).toMatchObject({ status: 'ON_HOLD', archivedAt: null });
    const audit = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, entityId: created.id },
      select: { action: true },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'project.created',
        'project.status_changed',
        'project.health_changed',
        'project.archived',
        'project.restored',
      ]),
    );
  });

  it('concurrent edits with the same version: exactly one wins', async () => {
    const tm = await s.actionFor('EMP-00006');
    const created = await s.as(tm, () => projects.create(tm, { name: 'Race' }));
    const results = await Promise.allSettled(
      ['A', 'B', 'C'].map((suffix) =>
        s.as(tm, () => projects.update(tm, created.id, created.version, { name: `Race ${suffix}` })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => r.reason instanceof VersionConflictError)).toBe(true);
    expect(await versionOf(created.id)).toBe(created.version + 1);
  });

  it('a project-scoped PM edits their project but cannot appoint managers or archive', async () => {
    const pm = await s.actionFor('EMP-00013');
    const tmp = await projectId('TMP');
    const before = await s.as(pm, () => projects.get(pm, tmp));
    expect(before.access).toMatchObject({ canManage: true, canAssignMembers: true, canAssignManagers: false });
    const updated = await s.as(pm, () => projects.update(pm, tmp, before.version, { notes: 'Weekly sync on Sunday' }));
    expect(updated.notes).toBe('Weekly sync on Sunday');
    const someone = await s.employee('EMP-00014');
    await expect(
      s.as(pm, () => projects.update(pm, tmp, updated.version, { projectManagerId: someone.profileId })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(pm, () => projects.setStatus(pm, tmp, { status: 'ON_HOLD', version: updated.version })),
    ).resolves.toMatchObject({ status: 'ON_HOLD' });
    const current = await versionOf(tmp);
    await expect(s.as(pm, () => projects.archive(pm, tmp, { version: current }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await s.as(pm, () => projects.setStatus(pm, tmp, { status: 'ACTIVE', version: current }));
    // Visible but not permitted is 403; not visible is 404.
    const developer = await s.actionFor('EMP-00014');
    await expect(
      s.as(developer, async () =>
        projects.setHealth(developer, tmp, { health: 'CRITICAL', note: 'x', version: await versionOf(tmp) }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(pm, async () =>
        projects.setHealth(pm, await projectId('POS'), { health: 'CRITICAL', note: 'x', version: 1 }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('membership', () => {
  it('a project-scoped PM can add regular members, which grants them PROJECT reach', async () => {
    const pm = await s.actionFor('EMP-00013');
    const tmp = await projectId('TMP');
    const employee = await s.employee('EMP-00004');
    const added = await s.as(pm, () =>
      members.add(pm, tmp, { employeeId: employee.profileId, projectRole: 'DEVELOPER' }),
    );
    expect(added).toMatchObject({ employeeId: employee.profileId, projectRole: 'DEVELOPER', endDate: null });
    const nowMember = await s.actionFor('EMP-00004');
    expect(nowMember.principal.reach?.projectIds.has(tmp)).toBe(true);
    expect((await s.as(nowMember, () => projects.list(nowMember, {}))).items.map((p) => p.code)).toEqual(['TMP']);
    await expect(
      s.as(pm, () => members.add(pm, tmp, { employeeId: employee.profileId, projectRole: 'QA' })),
    ).rejects.toBeInstanceOf(ConflictError);
    const notification = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, eventType: 'notification.requested', aggregateId: tmp },
      select: { payload: true },
    });
    expect(notification.some((n) => JSON.stringify(n.payload).includes('PROJECT_MEMBER_ADDED'))).toBe(true);
  });

  it('blocks escalation: manager roles, self-changes, broader grants, foreign or disabled people', async () => {
    const pm = await s.actionFor('EMP-00013');
    const tmp = await projectId('TMP');
    const developer = await s.employee('EMP-00016');
    await expect(
      s.as(pm, () => members.add(pm, tmp, { employeeId: developer.profileId, projectRole: 'PROJECT_MANAGER' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const self = await s.employee('EMP-00013');
    await expect(
      s.as(pm, () => members.add(pm, tmp, { employeeId: self.profileId, projectRole: 'DEVELOPER' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A plain project manager lacks support.resolve, which the team lead EMP-00008 holds at PROJECT scope.
    await grantRole('EMP-00029', 'PROJECT_MANAGER');
    const tmAdmin = await s.actionFor('EMP-00006');
    const plainManagerProfile = await s.employee('EMP-00029');
    const plainProject = await s.as(tmAdmin, () =>
      projects.create(tmAdmin, { name: 'Plain PM', projectManagerId: plainManagerProfile.profileId }),
    );
    const plainManager = await s.actionFor('EMP-00029');
    const lead = await s.employee('EMP-00008');
    await expect(
      s.as(plainManager, () =>
        members.add(plainManager, plainProject.id, { employeeId: lead.profileId, projectRole: 'DEVELOPER' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const plainField = await s.employee('EMP-00027');
    await s.as(plainManager, () =>
      members.add(plainManager, plainProject.id, { employeeId: plainField.profileId, projectRole: 'FIELD' }),
    );
    const foreign = await s.employee('NW-003', s.northwindId);
    await expect(
      s.as(pm, () => members.add(pm, tmp, { employeeId: foreign.profileId, projectRole: 'FIELD' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const disabled = await s.employee('EMP-00005');
    const tm = await s.actionFor('EMP-00006');
    await expect(
      s.as(tm, () => members.add(tm, tmp, { employeeId: disabled.profileId, projectRole: 'SUPPORT' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    // ORG-scoped assigners may appoint manager roles.
    const appointed = await s.as(tm, () =>
      members.add(tm, tmp, { employeeId: developer.profileId, projectRole: 'TECHNICAL_MANAGER' }),
    );
    expect(appointed.projectRole).toBe('TECHNICAL_MANAGER');
    await expect(
      s.as(pm, () => members.update(pm, tmp, developer.profileId, { projectRole: 'DEVELOPER' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(pm, () => members.remove(pm, tmp, developer.profileId))).rejects.toBeInstanceOf(ForbiddenError);
    await s.as(tm, () => members.remove(tm, tmp, developer.profileId));
    // Members without assign permission cannot change membership (403), others cannot see the project (404).
    const field = await s.actionFor('EMP-00024');
    await expect(
      s.as(field, () => members.add(field, tmp, { employeeId: developer.profileId, projectRole: 'QA' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = await s.actionFor('EMP-00027');
    await expect(
      s.as(outsider, () => members.add(outsider, tmp, { employeeId: developer.profileId, projectRole: 'QA' })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('changes roles and removes members with audit; history stays visible', async () => {
    const pm = await s.actionFor('EMP-00013');
    const tmp = await projectId('TMP');
    const employee = await s.employee('EMP-00004');
    const changed = await s.as(pm, () =>
      members.update(pm, tmp, employee.profileId, { projectRole: 'QA', endDate: '2027-01-31' }),
    );
    expect(changed).toMatchObject({ projectRole: 'QA', endDate: '2027-01-31' });
    await expect(
      s.as(pm, () => members.update(pm, tmp, employee.profileId, { startDate: '2027-02-01' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await s.as(pm, () => members.remove(pm, tmp, employee.profileId));
    await expect(s.as(pm, () => members.remove(pm, tmp, employee.profileId))).rejects.toBeInstanceOf(NotFoundError);
    const audit = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, entityId: tmp, action: { startsWith: 'project.member_' } },
      select: { action: true },
    });
    expect(new Set(audit.map((a) => a.action))).toEqual(
      new Set(['project.member_added', 'project.member_updated', 'project.member_removed']),
    );
    const removed = await s.actionFor('EMP-00004');
    await expect(s.as(removed, () => projects.get(removed, tmp))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('work locations', () => {
  it('location admins manage locations; PMs link active locations to their project', async () => {
    const hr = await s.actionFor('EMP-00003');
    const created = await s.as(hr, () =>
      locations.create(hr, {
        name: 'Giza Depot',
        type: 'OTHER',
        latitude: 29.987654,
        longitude: 31.211234,
        allowedRadiusMeters: 150,
      }),
    );
    expect(created).toMatchObject({ latitude: 29.987654, longitude: 31.211234, active: true });
    const pm = await s.actionFor('EMP-00013');
    await expect(
      s.as(pm, () =>
        locations.create(pm, { name: 'X', type: 'OTHER', latitude: 0, longitude: 0, allowedRadiusMeters: 100 }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const tmp = await projectId('TMP');
    const linked = await s.as(pm, () => projectLocations.link(pm, tmp, created.id));
    expect(linked.location.id).toBe(created.id);
    await expect(s.as(pm, () => projectLocations.link(pm, tmp, created.id))).rejects.toBeInstanceOf(ConflictError);
    await s.as(hr, () => locations.update(hr, created.id, { active: false }));
    await s.as(pm, () => projectLocations.unlink(pm, tmp, created.id));
    await expect(s.as(pm, () => projectLocations.link(pm, tmp, created.id))).rejects.toBeInstanceOf(InvalidInputError);
    const employee = await s.actionFor('EMP-00004');
    await expect(s.as(employee, () => locations.list(employee, {}))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('foreign locations cannot be linked', async () => {
    const foreign = await s.prisma.workLocation.create({
      data: {
        organizationId: s.northwindId,
        name: 'London Office',
        type: 'OFFICE',
        latitude: 51.5,
        longitude: -0.12,
        allowedRadiusMeters: 100,
      },
      select: { id: true },
    });
    const tm = await s.actionFor('EMP-00006');
    await expect(
      s.as(tm, async () => projectLocations.link(tm, await projectId('TMP'), foreign.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('daily reports', () => {
  it('a staffed field employee submits one report per business day in the project zone', async () => {
    const field = await s.actionFor('EMP-00025');
    const tmp = await projectId('TMP');
    const today = localToday(new Date(), 'Africa/Cairo');
    const report = await s.as(field, () =>
      reports.submit(field, tmp, { systemStatus: 'NORMAL', workPerformed: 'All good', followUpRequired: false }),
    );
    expect(report).toMatchObject({ reportDate: today, systemStatus: 'NORMAL', access: { canAttach: true } });
    await expect(
      s.as(field, () => reports.submit(field, tmp, { systemStatus: 'ISSUE', workPerformed: 'Again' })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      s.as(field, () =>
        reports.submit(field, tmp, { reportDate: addDays(today, 1), systemStatus: 'NORMAL', workPerformed: 'x' }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(field, () =>
        reports.submit(field, tmp, { reportDate: addDays(today, -8), systemStatus: 'NORMAL', workPerformed: 'x' }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    // The seed has fixed-date reports, so backfill the oldest day in the window that has none yet.
    const taken = await s.prisma.dailyReport.findMany({
      where: { projectId: tmp, reporter: { employeeNumber: 'EMP-00025' } },
      select: { reportDate: true },
    });
    const takenDates = new Set(taken.map((row) => row.reportDate.toISOString().slice(0, 10)));
    const backfillDate = [-7, -6, -5, -4, -3, -2, -1]
      .map((offset) => addDays(today, offset))
      .find((date) => !takenDates.has(date));
    expect(backfillDate).toBeDefined();
    const backfilled = await s.as(field, () =>
      reports.submit(field, tmp, {
        reportDate: backfillDate ?? today,
        systemStatus: 'DEGRADED',
        workPerformed: 'Late entry',
      }),
    );
    expect(backfilled.number).toBe(report.number + 1);
  });

  it('enforces permission, staffing and reporting status', async () => {
    const tmp = await projectId('TMP');
    const developer = await s.actionFor('EMP-00014');
    await expect(
      s.as(developer, () => reports.submit(developer, tmp, { systemStatus: 'NORMAL', workPerformed: 'x' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = await s.actionFor('EMP-00027');
    await expect(
      s.as(outsider, () => reports.submit(outsider, tmp, { systemStatus: 'NORMAL', workPerformed: 'x' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const posField = await s.actionFor('EMP-00026');
    await expect(
      s.as(posField, async () =>
        reports.submit(posField, await projectId('POS'), { systemStatus: 'NORMAL', workPerformed: 'x' }),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('report visibility follows daily_report.view scope; out of scope is 404', async () => {
    const tmp = await projectId('TMP');
    const reporter = await s.actionFor('EMP-00024');
    const colleague = await s.actionFor('EMP-00025');
    const own = await s.as(reporter, () => reports.listForProject(reporter, tmp, { limit: 100 }));
    expect(own.items.length).toBeGreaterThanOrEqual(3);
    const [first] = own.items;
    if (first === undefined) {
      throw new Error('The seed has daily reports on TMP');
    }
    const viaColleague = await s.as(colleague, () => reports.get(colleague, first.id));
    expect(viaColleague.access.canAttach).toBe(viaColleague.reporter.id === (await s.employee('EMP-00025')).profileId);
    const developer = await s.actionFor('EMP-00014');
    expect((await s.as(developer, () => reports.listForProject(developer, tmp, {}))).items).toHaveLength(0);
    await expect(s.as(developer, () => reports.get(developer, first.id))).rejects.toBeInstanceOf(NotFoundError);
    const gm = await s.actionFor('EMP-00002');
    expect(
      (await s.as(gm, () => reports.listForProject(gm, tmp, { systemStatus: ['DEGRADED'] }))).items.length,
    ).toBeGreaterThan(0);
    const foreignManager = await s.actionFor('NW-001', s.northwindId);
    await expect(s.as(foreignManager, () => reports.get(foreignManager, first.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('derives missing reports per project zone and validates the range', async () => {
    const pm = await s.actionFor('EMP-00013');
    const tmp = await projectId('TMP');
    const result = await s.as(pm, () => reports.missing(pm, tmp, {}));
    expect(result).toMatchObject({ timeZone: 'Africa/Cairo', reporting: true, policy: { required: true } });
    const field = await s.employee('EMP-00024');
    expect(result.missing.some((m) => m.employee.id === field.profileId)).toBe(true);
    const today = result.today;
    await expect(
      s.as(pm, () => reports.missing(pm, tmp, { from: addDays(today, -40), to: today })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(pm, () => reports.missing(pm, tmp, { from: today, to: addDays(today, -1) })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const developer = await s.actionFor('EMP-00014');
    await expect(s.as(developer, () => reports.missing(developer, tmp, {}))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the scheduled check notifies reporters and the PM once per project and date', async () => {
    expect(await organizationsRequiringDailyReports(s.prisma)).toEqual([s.demoId]);
    const check = new DailyReportMissingCheck(s.tenantDb, s.tenant, new NotificationWriter(s.tenantDb, s.tenant));
    const now = new Date();
    const first = await s.asSystem(s.demoId, () => check.run(now));
    const second = await s.asSystem(s.demoId, () => check.run(now));
    expect(second.notifications).toBe(0);
    const pm = await s.employee('EMP-00013');
    const summaries = await s.prisma.notification.count({
      where: { organizationId: s.demoId, recipientMemberId: pm.memberId, type: 'DAILY_REPORTS_MISSING_SUMMARY' },
    });
    expect(summaries).toBeGreaterThanOrEqual(first.notifications > 0 ? 1 : 0);
  });
});

describe('composite tenant keys (database level)', () => {
  it('rejects cross-organization references for every Phase 2 relation', async () => {
    const tmp = await projectId('TMP');
    const foreignProfile = await s.employee('NW-002', s.northwindId);
    const foreignProject = await s.prisma.project.create({
      data: { organizationId: s.northwindId, number: 1, code: 'NW-1', name: 'Northwind project' },
      select: { id: true },
    });
    const foreignCustomer = await s.prisma.customer.create({
      data: { organizationId: s.northwindId, name: 'NW only', type: 'PRIVATE' },
      select: { id: true },
    });
    const foreignLocation = await s.prisma.workLocation.create({
      data: {
        organizationId: s.northwindId,
        name: 'NW site',
        type: 'OTHER',
        latitude: 0,
        longitude: 0,
        allowedRadiusMeters: 50,
      },
      select: { id: true },
    });
    const demoMember = await s.employee('EMP-00024');
    // Linked to POS only, so links to TMP or IHD cannot hit the unique constraint first.
    const demoLocation = await s.prisma.workLocation.findFirstOrThrow({
      where: { organizationId: s.demoId, name: 'Alexandria Customer Site' },
      select: { id: true },
    });
    const project = (data: Partial<Prisma.ProjectUncheckedCreateInput>, n: number) =>
      s.prisma.project.create({
        data: { organizationId: s.demoId, number: 9000 + n, code: `X${String(n)}`, name: 'x', ...data },
      });
    await expectFkViolation(project({ customerId: foreignCustomer.id }, 1));
    await expectFkViolation(project({ projectManagerProfileId: foreignProfile.profileId }, 2));
    await expectFkViolation(project({ technicalManagerProfileId: foreignProfile.profileId }, 3));
    await expectFkViolation(project({ createdByMemberId: foreignProfile.memberId }, 4));

    const member = (data: Partial<Prisma.ProjectMemberUncheckedCreateInput>) =>
      s.prisma.projectMember.create({
        data: {
          organizationId: s.demoId,
          projectId: tmp,
          profileId: demoMember.profileId,
          projectRole: 'FIELD',
          startDate: new Date(),
          ...data,
        },
      });
    await expectFkViolation(member({ profileId: foreignProfile.profileId }));
    await expectFkViolation(member({ projectId: foreignProject.id }));
    await expectFkViolation(member({ projectId: await projectId('POS'), addedByMemberId: foreignProfile.memberId }));

    const link = (data: Partial<Prisma.ProjectLocationUncheckedCreateInput>) =>
      s.prisma.projectLocation.create({
        data: { organizationId: s.demoId, projectId: tmp, workLocationId: demoLocation.id, ...data },
      });
    await expectFkViolation(link({ workLocationId: foreignLocation.id }));
    await expectFkViolation(link({ projectId: foreignProject.id }));
    await expectFkViolation(link({ projectId: await projectId('IHD'), addedByMemberId: foreignProfile.memberId }));

    const report = (data: Partial<Prisma.DailyReportUncheckedCreateInput>, n: number) =>
      s.prisma.dailyReport.create({
        data: {
          organizationId: s.demoId,
          number: 90_000 + n,
          projectId: tmp,
          reporterProfileId: demoMember.profileId,
          reportDate: new Date(`2026-01-0${String(n)}T00:00:00.000Z`),
          systemStatus: 'NORMAL',
          workPerformed: 'x',
          submittedByMemberId: demoMember.memberId,
          ...data,
        },
      });
    await expectFkViolation(report({ projectId: foreignProject.id }, 1));
    await expectFkViolation(report({ reporterProfileId: foreignProfile.profileId }, 2));
    await expectFkViolation(report({ submittedByMemberId: foreignProfile.memberId }, 3));

    const entry = (data: Partial<Prisma.ProjectActivityUncheckedCreateInput>, n: number) =>
      s.prisma.projectActivity.create({
        data: {
          organizationId: s.demoId,
          projectId: tmp,
          occurredAt: new Date(),
          source: 'PROJECT',
          type: 'project.created',
          entityType: 'project',
          sourceEventId: `00000000-0000-7000-8000-00000000abc${String(n)}`,
          ...data,
        },
      });
    await expectFkViolation(entry({ projectId: foreignProject.id }, 1));
    await expectFkViolation(entry({ actorMemberId: foreignProfile.memberId }, 2));

    // Archived state and timestamp must agree (CHECK constraint).
    await expect(project({ status: 'ARCHIVED' }, 5)).rejects.toThrow(/projects_archived_check/);
  });
});

describe('project activity (outbox consumer, rebuildable)', () => {
  it('records timeline entries idempotently and hides daily-report entries from non-viewers', async () => {
    await drainActivity();
    const tmp = await projectId('TMP');
    const count = await s.prisma.projectActivity.count({ where: { organizationId: s.demoId, projectId: tmp } });
    await drainActivity();
    expect(await s.prisma.projectActivity.count({ where: { organizationId: s.demoId, projectId: tmp } })).toBe(count);
    const pm = await s.actionFor('EMP-00013');
    const timeline = await s.as(pm, () => activity.list(pm, tmp, { limit: 100 }));
    expect(timeline.items.map((i) => i.type)).toEqual(
      expect.arrayContaining([
        'project.created',
        'project.status_changed',
        'daily_report.submitted',
        'project.member_added',
      ]),
    );
    const developer = await s.actionFor('EMP-00014');
    const limited = await s.as(developer, () => activity.list(developer, tmp, { limit: 100 }));
    expect(limited.items.length).toBeGreaterThan(0);
    expect(limited.items.some((i) => i.source === 'DAILY_REPORT')).toBe(false);
    const outsider = await s.actionFor('EMP-00027');
    await expect(s.as(outsider, () => activity.list(outsider, tmp, {}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects forged cursors with a validation error instead of a database error', async () => {
    const tmp = await projectId('TMP');
    const pm = await s.actionFor('EMP-00013');
    const forged = (values: string[]) => Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
    const notUuid = forged([new Date().toISOString(), 'not-a-uuid']);
    await expect(s.as(pm, () => activity.list(pm, tmp, { cursor: notUuid }))).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(pm, () => customers.list(pm, { cursor: forged(['A', 'x']) }))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      s.as(pm, () => reports.listForProject(pm, tmp, { cursor: forged(['2026-10-01', 'x']) })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(pm, () => projects.list(pm, { cursor: notUuid }))).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('never links an event to a project of another organization and rebuilds from the outbox', async () => {
    const tmp = await projectId('TMP');
    const result = await s.asSystem(s.northwindId, () =>
      writer.record('00000000-0000-7000-8000-00000000beef', {
        projectId: tmp,
        occurredAt: new Date().toISOString(),
        source: 'PROJECT',
        type: 'project.updated',
        entityType: 'project',
        entityId: tmp,
        summaryParams: {},
        actorMemberId: null,
      }),
    );
    expect(result.kind).toBe('project_not_found');
    const before = await s.prisma.projectActivity.count({ where: { organizationId: s.demoId, projectId: tmp } });
    const rebuilt = await s.asSystem(s.demoId, () => writer.rebuild(tmp));
    expect(rebuilt.deleted).toBe(before);
    expect(rebuilt.created).toBe(before);
  });

  it('the operator rebuild is bound to one organization and resolves projects only inside it', async () => {
    expect(await rebuildProjectActivity(s.prisma, { organizationSlug: 'no-such-org' })).toEqual({
      kind: 'organization_not_found',
    });
    // TMP exists only in the demo organization.
    expect(await rebuildProjectActivity(s.prisma, { organizationSlug: 'northwind', projectCode: 'TMP' })).toEqual({
      kind: 'project_not_found',
    });
    const tmp = await projectId('TMP');
    const before = await s.prisma.projectActivity.count({ where: { organizationId: s.demoId, projectId: tmp } });
    const northwindBefore = await s.prisma.projectActivity.count({ where: { organizationId: s.northwindId } });
    expect(await rebuildProjectActivity(s.prisma, { organizationSlug: 'demo', projectCode: 'TMP' })).toEqual({
      kind: 'rebuilt',
      deleted: before,
      created: before,
    });
    expect(await s.prisma.projectActivity.count({ where: { organizationId: s.northwindId } })).toBe(northwindBefore);
  });
});

describe('daily-report attachments', () => {
  it('only the reporter uploads; viewers download; reporter or PM deletes; foreign reports are 404', async () => {
    const tmp = await projectId('TMP');
    const reporter = await s.actionFor('EMP-00024');
    const reporterProfile = await s.employee('EMP-00024');
    const [target] = (
      await s.as(reporter, () => reports.listForProject(reporter, tmp, { reporterId: reporterProfile.profileId }))
    ).items;
    if (target === undefined) {
      throw new Error('The seed has reports by EMP-00024');
    }
    const intentInput = {
      ownerType: 'DAILY_REPORT' as const,
      ownerId: target.id,
      filename: 'site.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
    };
    const intent = await s.as(reporter, () => attachments.createUploadIntent(reporter, intentInput));
    expect(intent.upload.url).toContain('daily-report');
    await expect(
      s.as(reporter, () => attachments.createUploadIntent(reporter, { ...intentInput, contentType: 'text/html' })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(reporter, () => attachments.createUploadIntent(reporter, { ...intentInput, sizeBytes: 11 * 1024 * 1024 })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const colleague = await s.actionFor('EMP-00025');
    await expect(s.as(colleague, () => attachments.createUploadIntent(colleague, intentInput))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const developer = await s.actionFor('EMP-00014');
    await expect(s.as(developer, () => attachments.createUploadIntent(developer, intentInput))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      s.as(developer, () => attachments.listForOwner(developer, 'DAILY_REPORT', target.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(colleague, () => attachments.delete(colleague, intent.attachment.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const pm = await s.actionFor('EMP-00013');
    await s.as(pm, () => attachments.delete(pm, intent.attachment.id));
    // The object is removed by the outbox consumer, so a storage outage cannot fail the delete.
    expect(deleted).toHaveLength(0);
    const cleanup = await s.prisma.outboxEvent.findFirstOrThrow({
      where: { organizationId: s.demoId, eventType: 'attachment.object.delete', aggregateId: intent.attachment.id },
      select: { payload: true },
    });
    expect(cleanup.payload).toEqual({ attachmentId: intent.attachment.id });
    expect(await s.asSystem(s.northwindId, () => attachments.deleteStoredObject(intent.attachment.id))).toBe(false);
    expect(await s.asSystem(s.demoId, () => attachments.deleteStoredObject(intent.attachment.id))).toBe(true);
    expect(deleted).toHaveLength(1);
    await expect(s.as(reporter, () => attachments.get(reporter, intent.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const foreignManager = await s.actionFor('NW-001', s.northwindId);
    await expect(
      s.as(foreignManager, () => attachments.createUploadIntent(foreignManager, intentInput)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
