import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RoleAdminService } from '../../src/modules/access/role-admin.service.js';
import { RoleGrantService } from '../../src/modules/access/role-grant.service.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../src/platform/errors.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Custom roles (P9-8) against PostgreSQL with the development seed: escalation rules, the immutable
 * ORG_ADMIN role, system-role limits, deletion guards, holder invalidation, audit and tenant isolation.
 */
let s: SeededDatabase;
let roles: RoleAdminService;
let grants: RoleGrantService;

async function roleId(key: string, organizationId = s.demoId): Promise<string> {
  const row = await s.prisma.role.findFirstOrThrow({ where: { organizationId, key }, select: { id: true } });
  return row.id;
}

async function authzVersion(memberId: string): Promise<number> {
  const row = await s.prisma.organizationMember.findUniqueOrThrow({
    where: { id: memberId },
    select: { authzVersion: true },
  });
  return row.authzVersion;
}

beforeAll(async () => {
  s = await startSeededDatabase();
  roles = new RoleAdminService(s.tenantDb, s.tenant);
  grants = new RoleGrantService(s.tenantDb, s.tenant);
}, 180_000);

afterAll(async () => {
  await s.stop();
});

describe('custom role lifecycle', () => {
  it('creates, edits and deletes a custom role with normalized, audited grants', async () => {
    const admin = await s.actionFor('EMP-00001');
    const created = await s.as(admin, () =>
      roles.create(admin, {
        name: '  Field   auditor ',
        permissions: [
          { key: 'support.view', scope: 'ORG' },
          { key: 'project.view', scope: 'ORG' },
          { key: 'support.view', scope: 'ORG' },
        ],
      }),
    );
    expect(created).toMatchObject({ name: 'Field auditor', isSystem: false, administratorEquivalent: false });
    expect(created.key).toMatch(/^CUSTOM_[0-9A-F]{10}$/);
    expect(created.permissions).toEqual([
      { key: 'project.view', scope: 'ORG' },
      { key: 'support.view', scope: 'ORG' },
    ]);

    const holder = await s.employee('EMP-00022');
    await s.as(admin, () => grants.grant(admin, holder.memberId, created.id));
    const before = await authzVersion(holder.memberId);
    const updated = await s.as(admin, () =>
      roles.update(admin, created.id, {
        name: 'Field reviewer',
        permissions: [
          { key: 'support.view', scope: 'ORG' },
          { key: 'daily_report.view', scope: 'PROJECT' },
        ],
      }),
    );
    expect(updated.name).toBe('Field reviewer');
    expect(updated.permissions).toEqual([
      { key: 'daily_report.view', scope: 'PROJECT' },
      { key: 'support.view', scope: 'ORG' },
    ]);
    expect(await authzVersion(holder.memberId)).toBe(before + 1);

    await expect(s.as(admin, () => roles.delete(admin, created.id))).rejects.toBeInstanceOf(ConflictError);
    await s.as(admin, () => grants.revoke(admin, holder.memberId, created.id));
    await s.as(admin, () => roles.delete(admin, created.id));
    expect(await s.prisma.role.findUnique({ where: { id: created.id } })).toBeNull();

    const audit = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, entityType: 'role', entityId: created.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, metadata: true },
    });
    expect(audit.map((row) => row.action)).toEqual(['role.created', 'role.updated', 'role.deleted']);
    expect(audit[1]?.metadata).toMatchObject({
      name: 'Field reviewer',
      added: ['daily_report.view:PROJECT'],
      removed: ['project.view:ORG'],
    });
  });

  it('rejects unknown permissions, unknown scopes, empty names and duplicate names', async () => {
    const admin = await s.actionFor('EMP-00001');
    await expect(
      s.as(admin, () => roles.create(admin, { name: 'Bad', permissions: [{ key: 'root.everything', scope: 'ORG' }] })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(admin, () => roles.create(admin, { name: 'Bad', permissions: [{ key: 'support.view', scope: 'GALAXY' }] })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(s.as(admin, () => roles.create(admin, { name: '   ', permissions: [] }))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      s.as(admin, () => roles.create(admin, { name: 'general manager', permissions: [] })),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('escalation rules', () => {
  it('keeps the ORG_ADMIN role immutable, even for organization admins', async () => {
    const admin = await s.actionFor('EMP-00001');
    const orgAdmin = await roleId('ORG_ADMIN');
    await expect(
      s.as(admin, () => roles.update(admin, orgAdmin, { permissions: [{ key: 'employee.view', scope: 'ORG' }] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(admin, () => roles.delete(admin, orgAdmin))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets system-role grants be edited but never renames or deletes system roles', async () => {
    const admin = await s.actionFor('EMP-00001');
    const agent = await roleId('SUPPORT_AGENT');
    const original = (await s.as(admin, () => grants.listRoles(admin))).find((role) => role.id === agent);
    const holders = await s.prisma.memberRole.findMany({ where: { roleId: agent }, select: { memberId: true } });
    const versions = await Promise.all(holders.map((holder) => authzVersion(holder.memberId)));

    const edited = await s.as(admin, () =>
      roles.update(admin, agent, {
        permissions: [...(original?.permissions ?? []), { key: 'dashboard.project', scope: 'PROJECT' }],
      }),
    );
    expect(edited.permissions).toContainEqual({ key: 'dashboard.project', scope: 'PROJECT' });
    expect(await Promise.all(holders.map((holder) => authzVersion(holder.memberId)))).toEqual(
      versions.map((version) => version + 1),
    );
    await s.as(admin, () => roles.update(admin, agent, { permissions: original?.permissions ?? [] }));

    await expect(s.as(admin, () => roles.update(admin, agent, { name: 'Renamed agent' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.as(admin, () => roles.delete(admin, agent))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses callers without role.manage at ORG scope', async () => {
    const hr = await s.actionFor('EMP-00003');
    await expect(
      s.as(hr, () => roles.create(hr, { name: 'HR helper', permissions: [{ key: 'employee.view', scope: 'ORG' }] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reserves administrator-equivalent roles for ORG_ADMIN holders and forbids editing a held role', async () => {
    const admin = await s.actionFor('EMP-00001');
    const delegateRole = await s.as(admin, () =>
      roles.create(admin, { name: 'Role delegate', permissions: [{ key: 'role.manage', scope: 'ORG' }] }),
    );
    expect(delegateRole.administratorEquivalent).toBe(true);
    const delegateEmployee = await s.employee('EMP-00010');
    await s.as(admin, () => grants.grant(admin, delegateEmployee.memberId, delegateRole.id));
    const delegate = await s.actionFor('EMP-00010');

    await expect(
      s.as(delegate, () =>
        roles.update(delegate, delegateRole.id, {
          permissions: [
            { key: 'role.manage', scope: 'ORG' },
            { key: 'audit.view', scope: 'ORG' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(delegate, () =>
        roles.create(delegate, { name: 'Shadow admin', permissions: [{ key: 'role.manage', scope: 'ORG' }] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const plain = await s.as(delegate, () =>
      roles.create(delegate, { name: 'Delegated viewer', permissions: [{ key: 'project.view', scope: 'ORG' }] }),
    );
    await expect(
      s.as(delegate, () => roles.update(delegate, plain.id, { permissions: [{ key: 'role.manage', scope: 'ORG' }] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await s.as(delegate, () => roles.delete(delegate, plain.id));
  });

  it('hands out commercial financial and restricted-document access only from ORG_ADMIN or an ORG-wide holder', async () => {
    const admin = await s.actionFor('EMP-00001');
    const managerRole = await s.as(admin, () =>
      roles.create(admin, { name: 'Commercial role manager', permissions: [{ key: 'role.manage', scope: 'ORG' }] }),
    );
    const managerEmployee = await s.employee('EMP-00020');
    await s.as(admin, () => grants.grant(admin, managerEmployee.memberId, managerRole.id));
    const manager = await s.actionFor('EMP-00020');

    await expect(
      s.as(manager, () =>
        roles.create(manager, {
          name: 'Money viewer',
          permissions: [{ key: 'contract.financial.view', scope: 'PROJECT' }],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const plain = await s.as(manager, () =>
      roles.create(manager, { name: 'Tender reader', permissions: [{ key: 'tender.view', scope: 'ORG' }] }),
    );
    await expect(
      s.as(manager, () =>
        roles.update(manager, plain.id, {
          permissions: [
            { key: 'tender.view', scope: 'ORG' },
            { key: 'commercial_document.view', scope: 'ORG' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const target = await s.employee('EMP-00022');
    const generalManager = await roleId('GENERAL_MANAGER');
    await expect(s.as(manager, () => grants.grant(manager, target.memberId, generalManager))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(
      await s.prisma.memberRole.count({ where: { memberId: target.memberId, role: { key: 'GENERAL_MANAGER' } } }),
    ).toBe(0);

    const money = await s.as(admin, () =>
      roles.create(admin, {
        name: 'Money viewer',
        permissions: [{ key: 'contract.financial.view', scope: 'PROJECT' }],
      }),
    );
    expect(money.permissions).toEqual([{ key: 'contract.financial.view', scope: 'PROJECT' }]);
    await s.as(admin, () => roles.delete(admin, money.id));
    await s.as(manager, () => roles.delete(manager, plain.id));
  });
});

describe('tenant isolation', () => {
  it('treats another organization’s role as not found', async () => {
    const admin = await s.actionFor('EMP-00001');
    const foreign = await roleId('SUPPORT_AGENT', s.northwindId);
    await expect(s.as(admin, () => roles.update(admin, foreign, { name: 'x' }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(admin, () => roles.delete(admin, foreign))).rejects.toBeInstanceOf(NotFoundError);
    const untouched = await s.prisma.role.findUniqueOrThrow({ where: { id: foreign }, select: { name: true } });
    expect(untouched.name).not.toBe('x');
  });
});
