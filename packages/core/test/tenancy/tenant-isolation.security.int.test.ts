import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemberStatus, Prisma, createPrismaClient } from '../../src/platform/db/prisma.js';
import type { PrismaClient } from '../../src/platform/db/prisma.js';
import { seedDemoData } from '../../src/dev-seed/seed.js';
import { MemberRepository } from '../../src/modules/access/member.repository.js';
import { RoleGrantService } from '../../src/modules/access/role-grant.service.js';
import type { ActionContext } from '../../src/modules/action-context.js';
import { computeEffectivePermissions } from '../../src/modules/authorization/effective-permissions.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { provisionOrganization } from '../../src/modules/organizations/provision-organization.js';
import { NotFoundError, TenantIsolationError } from '../../src/platform/errors.js';
import { AsyncLocalTenantContext } from '../../src/platform/tenancy/tenant-context.js';
import type { TenantContext } from '../../src/platform/tenancy/tenant-context.js';
import { createTenantScopedClient } from '../../src/platform/tenancy/tenant-guard.js';
import type { TenantScopedClient } from '../../src/platform/tenancy/tenant-guard.js';
import { DEMO_EMPLOYEES } from '../../src/dev-seed/demo-people.js';

/**
 * Tenant isolation against a real PostgreSQL 18 with the real migration, connected as the runtime
 * role (ops_app). Nothing about the database or the guard is mocked.
 */
const ISSUER = 'http://keycloak.test/realms/company-ops';

let db: TestDatabase;
let prisma: PrismaClient;
let tenantDb: TenantScopedClient;
const tenant = new AsyncLocalTenantContext();

interface OrgFixture {
  readonly id: string;
  readonly memberId: string;
  readonly userId: string;
  readonly otherMemberId: string;
  readonly roleIds: Record<string, string>;
}
let orgA: OrgFixture;
let orgB: OrgFixture;

const ctx = (org: OrgFixture): TenantContext => ({
  organizationId: org.id,
  memberId: org.memberId,
  userId: org.userId,
});

/** The fixture admin acting with their real ORG_ADMIN permissions. */
async function adminAction(org: OrgFixture, requestId?: string): Promise<ActionContext> {
  const grants = await prisma.rolePermission.findMany({
    where: { organizationId: org.id, roleId: org.roleIds.ORG_ADMIN ?? '' },
    select: { permissionKey: true, scope: true },
  });
  return {
    principal: {
      organizationId: org.id,
      memberId: org.memberId,
      userId: org.userId,
      permissions: computeEffectivePermissions(grants),
    },
    request: requestId === undefined ? undefined : { requestId },
  };
}
// Prisma queries are lazy (they run when awaited), so the await must happen inside the context.
const asOrg = <T>(org: OrgFixture, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.run(ctx(org), async () => await fn());

async function fixture(organizationId: string, adminSubject: string): Promise<OrgFixture> {
  const roles = await prisma.role.findMany({ where: { organizationId }, select: { id: true, key: true } });
  const roleIds = Object.fromEntries(roles.map((r) => [r.key, r.id]));
  const admin = await prisma.organizationMember.findFirstOrThrow({
    where: { organizationId, user: { idpSubject: adminSubject } },
    select: { id: true, user: { select: { id: true } } },
  });
  if (admin.user === null) throw new Error('fixture admin must be linked to a user');
  const other = await prisma.organizationMember.findFirstOrThrow({
    where: { organizationId, id: { not: admin.id } },
    select: { id: true },
  });
  return { id: organizationId, memberId: admin.id, userId: admin.user.id, otherMemberId: other.id, roleIds };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await db.migrate();
  prisma = createPrismaClient(db.appUrl);
  tenantDb = createTenantScopedClient(prisma, tenant);

  const seeded = await seedDemoData(prisma, ISSUER);
  orgA = await fixture(seeded.organizationId, '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01');

  const provisioned = await provisionOrganization(
    prisma,
    { slug: 'other-co', name: 'Other Co', timeZone: 'Europe/Berlin', workWeek: [1, 2, 3, 4, 5] },
    { type: 'CLI' },
  );
  const identities = new IdentityService(prisma);
  for (const subject of ['b-admin', 'b-employee']) {
    const user = await identities.upsertUser({ issuer: ISSUER, subject, email: null, displayName: subject });
    await prisma.organizationMember.create({
      data: { organizationId: provisioned.organizationId, userId: user.id, status: MemberStatus.ACTIVE },
    });
  }
  orgB = await fixture(provisioned.organizationId, 'b-admin');
}, 240_000);

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

describe('migration and database roles', () => {
  it('reports the schema as up to date after migrate deploy', async () => {
    expect(await db.migrateStatus()).toMatch(/Database schema is up to date/);
  });

  it.each([
    ['CREATE TABLE', 'CREATE TABLE probe (id int)'],
    ['ALTER TABLE', 'ALTER TABLE organizations ADD COLUMN probe int'],
    ['DROP TABLE', 'DROP TABLE roles'],
    ['CREATE FUNCTION', 'CREATE FUNCTION probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
    ['TRUNCATE', 'TRUNCATE roles'],
    ['DISABLE TRIGGER', 'ALTER TABLE audit_logs DISABLE TRIGGER USER'],
    ['read migration history', 'SELECT count(*) FROM _prisma_migrations'],
  ])('the runtime role cannot %s', async (_label, sql) => {
    const result = await db.psql('ops_app', sql);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/permission denied|must be owner|does not exist/);
  });

  it('the runtime role has DML on tenant tables but cannot change or remove audit rows', async () => {
    expect((await db.psql('ops_app', 'SELECT count(*) FROM organization_members')).exitCode).toBe(0);
    for (const sql of [
      "UPDATE audit_logs SET action = 'x.y'",
      'DELETE FROM audit_logs',
      'TRUNCATE audit_logs',
      'DELETE FROM platform_audit_logs',
    ]) {
      const result = await db.psql('ops_app', sql);
      expect(result.exitCode, sql).not.toBe(0);
      expect(result.output).toMatch(/permission denied/);
    }
  });

  it('audit tables are append-only even for the table owner (trigger)', async () => {
    for (const sql of [
      "UPDATE audit_logs SET action = 'x.y'",
      'DELETE FROM platform_audit_logs',
      'TRUNCATE audit_logs',
    ]) {
      const result = await db.psql('ops_migrator', sql);
      expect(result.exitCode, sql).not.toBe(0);
      expect(result.output).toMatch(/append-only/);
    }
  });

  it('enforces domain CHECK constraints', async () => {
    const insert = (slug: string, workWeek: string) =>
      db.psql(
        'ops_app',
        `INSERT INTO organizations (id, slug, name, time_zone, work_week, updated_at) VALUES (gen_random_uuid(), '${slug}', 'X', 'UTC', '${workWeek}', now())`,
      );
    expect((await insert('Bad_Slug', '{1,2}')).output).toMatch(/organizations_slug_check/);
    expect((await insert('ok-slug', '{0,8}')).output).toMatch(/organizations_work_week_check/);
    expect((await insert('ok-slug', '{}')).output).toMatch(/organizations_work_week_check/);
  });
});

describe('composite tenant foreign keys (database level, unguarded client)', () => {
  const expectFkViolation = async (operation: Promise<unknown>) => {
    await expect(operation).rejects.toSatisfy(
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
    );
  };

  it('rejects granting a role of Org B to a member of Org A', async () => {
    await expectFkViolation(
      prisma.memberRole.create({
        data: { organizationId: orgA.id, memberId: orgA.otherMemberId, roleId: orgB.roleIds.EMPLOYEE ?? '' },
      }),
    );
    await expectFkViolation(
      prisma.memberRole.create({
        data: { organizationId: orgB.id, memberId: orgA.otherMemberId, roleId: orgB.roleIds.EMPLOYEE ?? '' },
      }),
    );
  });

  it('rejects cross-organization grantor, inviter, role permission and audit actor references', async () => {
    await expectFkViolation(
      prisma.memberRole.create({
        data: {
          organizationId: orgA.id,
          memberId: orgA.otherMemberId,
          roleId: orgA.roleIds.TECHNICAL_MANAGER ?? '',
          grantedByMemberId: orgB.memberId,
        },
      }),
    );
    await expectFkViolation(
      prisma.organizationMember.update({
        where: { organizationId_id: { organizationId: orgA.id, id: orgA.otherMemberId } },
        data: { invitedByMemberId: orgB.memberId },
      }),
    );
    await expectFkViolation(
      prisma.rolePermission.create({
        data: {
          organizationId: orgA.id,
          roleId: orgB.roleIds.EMPLOYEE ?? '',
          permissionKey: 'employee.view',
          scope: 'SELF',
        },
      }),
    );
    await expectFkViolation(
      prisma.auditLog.create({
        data: {
          organizationId: orgA.id,
          actorType: 'USER',
          actorMemberId: orgB.memberId,
          action: 'probe.test',
          entityType: 'probe',
        },
      }),
    );
  });
});

describe('tenant-scoped client and repositories', () => {
  it('Org A cannot fetch Org B data: foreign ids behave as non-existent', async () => {
    const members = new MemberRepository(tenantDb, tenant);
    await asOrg(orgA, async () => {
      expect(await members.findById(orgB.memberId)).toBeNull();
      expect(await members.findById(orgA.otherMemberId)).not.toBeNull();
      const listed = await members.list();
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.some((m) => m.id === orgB.memberId || m.id === orgB.otherMemberId)).toBe(false);
    });
  });

  it('Org A cannot update or delete Org B data', async () => {
    await asOrg(orgA, async () => {
      await expect(
        tenantDb.organizationMember.update({
          where: { organizationId_id: { organizationId: orgA.id, id: orgB.otherMemberId } },
          data: { status: MemberStatus.DISABLED },
        }),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025',
      );
      const updated = await tenantDb.organizationMember.updateMany({
        where: { organizationId: orgA.id, id: orgB.otherMemberId },
        data: { status: MemberStatus.DISABLED },
      });
      expect(updated.count).toBe(0);
      const deleted = await tenantDb.memberRole.deleteMany({
        where: { organizationId: orgA.id, memberId: orgB.memberId },
      });
      expect(deleted.count).toBe(0);
    });
    const untouched = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: orgB.id, id: orgB.otherMemberId } },
    });
    expect(untouched.status).toBe(MemberStatus.ACTIVE);
  });

  it('Org A cannot create a relation to Org B data (service returns 404 and writes nothing)', async () => {
    const grants = new RoleGrantService(tenantDb, tenant);
    const action = await adminAction(orgA);
    await asOrg(orgA, async () => {
      await expect(grants.grant(action, orgA.otherMemberId, orgB.roleIds.EMPLOYEE ?? '')).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(grants.grant(action, orgB.otherMemberId, orgA.roleIds.EMPLOYEE ?? '')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
    expect(
      await prisma.memberRole.count({ where: { roleId: orgB.roleIds.EMPLOYEE ?? '', organizationId: orgA.id } }),
    ).toBe(0);
  });

  it('a valid grant succeeds, bumps the authorization version and writes an audit row', async () => {
    const grants = new RoleGrantService(tenantDb, tenant);
    const before = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: orgA.id, id: orgA.otherMemberId } },
    });
    const action = await adminAction(orgA, 'req-1');
    const result = await asOrg(orgA, () => grants.grant(action, orgA.otherMemberId, orgA.roleIds.SUPPORT_AGENT ?? ''));
    expect(result.created).toBe(true);
    const after = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: orgA.id, id: orgA.otherMemberId } },
    });
    expect(after.authzVersion).toBe(before.authzVersion + 1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: orgA.id, action: 'role.granted', requestId: 'req-1' },
    });
    expect(audit).toMatchObject({ actorMemberId: orgA.memberId, entityId: orgA.otherMemberId, actorType: 'USER' });
    const again = await asOrg(orgA, () => grants.grant(action, orgA.otherMemberId, orgA.roleIds.SUPPORT_AGENT ?? ''));
    expect(again.created).toBe(false);
    const outbox = await prisma.outboxEvent.findMany({
      where: { organizationId: orgA.id, aggregateId: orgA.otherMemberId, eventType: 'notification.requested' },
    });
    expect(outbox).toHaveLength(1);
  });

  it('a forged organizationId never changes scope', async () => {
    await asOrg(orgA, async () => {
      await expect(tenantDb.organizationMember.findMany({ where: { organizationId: orgB.id } })).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
      await expect(
        tenantDb.role.create({ data: { organizationId: orgB.id, key: 'FORGED', name: 'Forged' } }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(
        tenantDb.role.updateMany({ where: { organizationId: orgA.id }, data: { organizationId: orgB.id } }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(tenantDb.organization.findUnique({ where: { id: orgB.id } })).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
      await expect(tenantDb.user.findMany()).rejects.toBeInstanceOf(TenantIsolationError);
    });
    expect(await prisma.role.count({ where: { key: 'FORGED' } })).toBe(0);
  });

  it('rejects nested relation writes and unbound upserts', async () => {
    await asOrg(orgA, async () => {
      await expect(
        tenantDb.organizationMember.update({
          where: { organizationId_id: { organizationId: orgA.id, id: orgA.otherMemberId } },
          data: { roles: { create: { roleId: orgB.roleIds.EMPLOYEE ?? '' } } },
        }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(
        tenantDb.role.upsert({
          where: { organizationId_key: { organizationId: orgB.id, key: 'EMPLOYEE' } },
          create: { organizationId: orgA.id, key: 'EMPLOYEE', name: 'x' },
          update: { name: 'hijacked' },
        }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { organizationId_key: { organizationId: orgB.id, key: 'EMPLOYEE' } },
    });
    expect(role.name).not.toBe('hijacked');
  });

  it('guards operations inside interactive and batch transactions', async () => {
    await asOrg(orgA, async () => {
      await expect(
        tenantDb.$transaction(async (tx) => {
          await tx.role.findMany({ where: { organizationId: orgA.id } });
          return tx.role.findMany({ where: { organizationId: orgB.id } });
        }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(
        tenantDb.$transaction([
          tenantDb.role.count({ where: { organizationId: orgA.id } }),
          tenantDb.role.count({ where: { organizationId: orgB.id } }),
        ]),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      const [count] = await tenantDb.$transaction([tenantDb.role.count({ where: { organizationId: orgA.id } })]);
      expect(count).toBe(10);
    });
  });

  it('fails closed outside a tenant context', async () => {
    await expect(tenantDb.role.findMany({ where: { organizationId: orgA.id } })).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('relation reads from a bound row stay within the organization', async () => {
    const member = await asOrg(orgA, () =>
      tenantDb.organizationMember.findFirstOrThrow({
        where: { organizationId: orgA.id, id: orgA.memberId },
        select: { user: { select: { id: true } }, roles: { select: { role: { select: { organizationId: true } } } } },
      }),
    );
    expect(member.user?.id).toBe(orgA.userId);
    expect(member.roles.every((r) => r.role.organizationId === orgA.id)).toBe(true);
  });

  it('the raw-SQL policy cannot be bypassed through the tenant-scoped client', async () => {
    await asOrg(orgA, async () => {
      await expect(tenantDb.$queryRawUnsafe('SELECT id FROM organization_members')).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
      await expect(tenantDb.$executeRawUnsafe('DELETE FROM member_roles')).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(tenantDb.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 1'))).rejects.toBeInstanceOf(
        TenantIsolationError,
      );
    });
    expect(await prisma.memberRole.count()).toBeGreaterThan(0);
  });
});

describe('development seed', () => {
  it('is idempotent and records seed actions in the audit log', async () => {
    const counts = async () => ({
      orgs: await prisma.organization.count(),
      users: await prisma.user.count(),
      members: await prisma.organizationMember.count(),
      grants: await prisma.memberRole.count(),
      roles: await prisma.role.count({ where: { organizationId: orgA.id } }),
    });
    const before = await counts();
    const report = await seedDemoData(prisma, ISSUER);
    expect(report).toMatchObject({ organizationCreated: false, membershipsCreated: 0, roleGrantsCreated: 0 });
    expect(await counts()).toEqual(before);

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: orgA.id } });
    expect(organization).toMatchObject({ slug: 'demo', timeZone: 'Africa/Cairo', workWeek: [7, 1, 2, 3, 4] });
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.id, action: 'member.created' } })).toBe(
      DEMO_EMPLOYEES.length,
    );
    expect(await prisma.employeeProfile.count({ where: { organizationId: orgA.id } })).toBe(DEMO_EMPLOYEES.length);
    expect(await prisma.employeeProfile.count({ where: { organizationId: report.secondOrganizationId } })).toBe(3);
    // demo, northwind (seed) and other-co (this test).
    expect(await prisma.platformAuditLog.count({ where: { action: 'platform.organization.created' } })).toBe(3);
    const disabled = await prisma.organizationMember.count({
      where: { organizationId: orgA.id, status: MemberStatus.DISABLED },
    });
    expect(disabled).toBe(1);
  });
});
