import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RoleGrantService } from '../../src/modules/access/role-grant.service.js';
import type { ActionContext } from '../../src/modules/action-context.js';
import { OrganizationSettingsService } from '../../src/modules/organizations/organization-settings.service.js';
import { DepartmentService } from '../../src/modules/people/department.service.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { InvitationRedemptionService } from '../../src/modules/people/invitation-redemption.service.js';
import { INVITATION_TTL_MS } from '../../src/modules/people/invitation-token.js';
import { JobTitleService } from '../../src/modules/people/job-title.service.js';
import { TeamService } from '../../src/modules/people/team.service.js';
import { MemberStatus, Prisma } from '../../src/platform/db/prisma.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../src/platform/errors.js';
import { startSeededDatabase, TEST_ISSUER } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';
import { DEMO_EMPLOYEES } from '../../src/dev-seed/demo-people.js';

/**
 * Organization/people services and RBAC scopes against a real PostgreSQL with the development
 * seed (SECURITY §2). Principals carry real role grants and the database-resolved reach.
 */
let s: SeededDatabase;
let employees: EmployeeService;
let departments: DepartmentService;
let teams: TeamService;
let jobTitles: JobTitleService;
let grants: RoleGrantService;
let settings: OrganizationSettingsService;

const ids = async (numbers: readonly string[]): Promise<Set<string>> =>
  new Set(await Promise.all(numbers.map(async (n) => (await s.employee(n)).memberId)));

async function departmentId(code: string, organizationId = s.demoId): Promise<string> {
  const row = await s.prisma.department.findFirstOrThrow({ where: { organizationId, code }, select: { id: true } });
  return row.id;
}

async function roleId(key: string, organizationId = s.demoId): Promise<string> {
  const row = await s.prisma.role.findFirstOrThrow({ where: { organizationId, key }, select: { id: true } });
  return row.id;
}

/** A custom organization role (DB-level; V1 has no role editor) granted directly for scope tests. */
async function grantCustomRole(
  employeeNumber: string,
  key: string,
  permissions: readonly { permissionKey: string; scope: 'SELF' | 'TEAM' | 'DEPARTMENT' | 'PROJECT' | 'ORG' }[],
): Promise<string> {
  const subject = await s.employee(employeeNumber);
  const role = await s.prisma.role.create({
    data: { organizationId: s.demoId, key, name: key },
    select: { id: true },
  });
  await s.prisma.rolePermission.createMany({
    data: permissions.map((p) => ({ organizationId: s.demoId, roleId: role.id, ...p })),
  });
  await s.prisma.memberRole.create({ data: { organizationId: s.demoId, memberId: subject.memberId, roleId: role.id } });
  return role.id;
}

const expectFkViolation = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
  );
};

beforeAll(async () => {
  s = await startSeededDatabase();
  employees = new EmployeeService(s.tenantDb, s.tenant);
  departments = new DepartmentService(s.tenantDb, s.tenant);
  teams = new TeamService(s.tenantDb, s.tenant);
  jobTitles = new JobTitleService(s.tenantDb, s.tenant);
  grants = new RoleGrantService(s.tenantDb, s.tenant);
  settings = new OrganizationSettingsService(s.tenantDb, s.tenant);
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('scope reach (TEAM / DEPARTMENT, resolved from the hierarchy)', () => {
  it('a team lead reaches their reports and the members of the team they lead', async () => {
    const lead = await s.actionFor('EMP-00008');
    expect(lead.principal.reach?.teamMemberIds).toEqual(
      await ids(['EMP-00009', 'EMP-00010', 'EMP-00011', 'EMP-00028']),
    );
    expect(lead.principal.reach?.departmentIds.size).toBe(0);
  });

  it('reporting lines are followed recursively; team membership adds non-reports', async () => {
    const manager = await s.actionFor('EMP-00007');
    expect(manager.principal.reach?.teamMemberIds).toEqual(
      await ids(['EMP-00008', 'EMP-00009', 'EMP-00010', 'EMP-00011', 'EMP-00028']),
    );
    const appsLead = await s.actionFor('EMP-00013');
    // EMP-00004 reports to EMP-00012 but is a member of the team EMP-00013 leads.
    expect(appsLead.principal.reach?.teamMemberIds.has((await s.employee('EMP-00004')).memberId)).toBe(true);
  });

  it('a department manager reaches the managed department and its descendants only', async () => {
    const platform = await s.actionFor('EMP-00007');
    expect([...(platform.principal.reach?.departmentIds ?? [])]).toEqual([await departmentId('ENG-PLT')]);
    const engineering = await s.actionFor('EMP-00006');
    expect(engineering.principal.reach?.departmentIds).toEqual(
      new Set([await departmentId('ENG'), await departmentId('ENG-PLT'), await departmentId('ENG-APP')]),
    );
  });

  it('members without TEAM/DEPARTMENT reach get empty sets; PROJECT reach is empty without project staffing', async () => {
    const employee = await s.actionFor('EMP-00004');
    expect(employee.principal.reach?.teamMemberIds.size).toBe(0);
    expect(employee.principal.reach?.departmentIds.size).toBe(0);
    const manager = await s.actionFor('EMP-00007');
    expect(manager.principal.reach?.projectIds.size).toBe(0);
  });
});

describe('employee list and contact visibility', () => {
  it('everyone sees the directory (employee.view ORG), contact fields only within the contact scope', async () => {
    const lead = await s.actionFor('EMP-00008');
    const page = await s.as(lead, () => employees.list(lead, { limit: 100 }));
    expect(page.items).toHaveLength(DEMO_EMPLOYEES.length);
    const byNumber = new Map(page.items.map((e) => [e.employeeNumber, e]));
    expect(byNumber.get('EMP-00009')?.phone).not.toBeNull();
    expect(byNumber.get('EMP-00014')).toMatchObject({ phone: null, contactVisible: false });
    expect(byNumber.get('EMP-00008')?.contactVisible).toBe(true);
  });

  it('DEPARTMENT contact scope follows the managed department', async () => {
    const manager = await s.actionFor('EMP-00012');
    const inScope = await s.as(manager, async () => employees.get(manager, (await s.employee('EMP-00014')).profileId));
    const outOfScope = await s.as(manager, async () =>
      employees.get(manager, (await s.employee('EMP-00009')).profileId),
    );
    expect(inScope.contactVisible).toBe(true);
    expect(outOfScope).toMatchObject({ contactVisible: false, phone: null });
  });

  it('a plain employee sees only their own contact fields', async () => {
    const employee = await s.actionFor('EMP-00004');
    const own = await s.as(employee, () => employees.getOwn(employee));
    const other = await s.as(employee, async () => employees.get(employee, (await s.employee('EMP-00009')).profileId));
    expect(own?.phone).not.toBeNull();
    expect(other.phone).toBeNull();
  });

  it('paginates with an opaque cursor without gaps or duplicates and applies filters', async () => {
    const hr = await s.actionFor('EMP-00003');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.as(hr, () => employees.list(hr, { limit: 7, cursor }));
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(DEMO_EMPLOYEES.length);
    expect(new Set(seen).size).toBe(DEMO_EMPLOYEES.length);
    const field = await s.as(hr, async () => employees.list(hr, { departmentId: await departmentId('FIELD') }));
    expect(field.items.map((e) => e.employeeNumber).sort()).toEqual([
      'EMP-00023',
      'EMP-00024',
      'EMP-00025',
      'EMP-00026',
      'EMP-00027',
      'EMP-00031',
    ]);
    const disabled = await s.as(hr, () => employees.list(hr, { memberStatus: MemberStatus.DISABLED }));
    expect(disabled.items.map((e) => e.employeeNumber)).toEqual(['EMP-00005']);
  });
});

describe('TEAM- and DEPARTMENT-scoped management (custom roles)', () => {
  beforeAll(async () => {
    await grantCustomRole('EMP-00008', 'SCOPED_TEAM_EDITOR', [{ permissionKey: 'employee.manage', scope: 'TEAM' }]);
    await grantCustomRole('EMP-00007', 'SCOPED_DEPARTMENT_EDITOR', [
      { permissionKey: 'employee.manage', scope: 'DEPARTMENT' },
      { permissionKey: 'department.manage', scope: 'DEPARTMENT' },
    ]);
  });

  it('a team lead manages employees in their team reach and nobody else (403 when visible)', async () => {
    const lead = await s.actionFor('EMP-00008');
    const report = await s.employee('EMP-00009');
    const updated = await s.as(lead, () => employees.update(lead, report.profileId, { fullName: 'Salma Adel R.' }));
    expect(updated.fullName).toBe('Salma Adel R.');
    await expect(
      s.as(lead, async () => employees.update(lead, (await s.employee('EMP-00014')).profileId, { fullName: 'x' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(lead, async () => employees.update(lead, (await s.employee('EMP-00008')).profileId, { fullName: 'x' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a department manager cannot manage outside the department or move people out of it', async () => {
    const manager = await s.actionFor('EMP-00007');
    const platformEngineer = await s.employee('EMP-00010');
    await s.as(manager, () => employees.update(manager, platformEngineer.profileId, { phone: '+20 100 000 9999' }));
    await expect(
      s.as(manager, async () => employees.update(manager, (await s.employee('EMP-00014')).profileId, { phone: null })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(manager, async () =>
        employees.update(manager, platformEngineer.profileId, { departmentId: await departmentId('ENG-APP') }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const unchanged = await s.prisma.employeeProfile.findUniqueOrThrow({ where: { id: platformEngineer.profileId } });
    expect(unchanged.departmentId).toBe(await departmentId('ENG-PLT'));
  });

  it('department-scoped structure changes stay inside the managed subtree', async () => {
    const manager = await s.actionFor('EMP-00007');
    const child = await s.as(manager, async () =>
      departments.create(manager, {
        name: 'Platform SRE',
        code: 'ENG-PLT-SRE',
        parentDepartmentId: await departmentId('ENG-PLT'),
      }),
    );
    expect(child.parentDepartmentId).toBe(await departmentId('ENG-PLT'));
    await expect(
      s.as(manager, async () =>
        departments.create(manager, { name: 'Rogue', code: 'ROGUE', parentDepartmentId: await departmentId('ENG') }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(manager, () => departments.create(manager, { name: 'Top', code: 'TOP' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.as(manager, () => jobTitles.create(manager, 'Chief Everything'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('team membership changes need department.manage for the team department', async () => {
    const manager = await s.actionFor('EMP-00007');
    const platformTeam = await s.prisma.team.findFirstOrThrow({
      where: { organizationId: s.demoId, name: 'Platform Core' },
    });
    const appsTeam = await s.prisma.team.findFirstOrThrow({
      where: { organizationId: s.demoId, name: 'Customer Apps' },
    });
    const result = await s.as(manager, async () =>
      teams.addMember(manager, platformTeam.id, (await s.employee('EMP-00014')).profileId),
    );
    expect(result.created).toBe(true);
    await expect(
      s.as(manager, async () => teams.addMember(manager, appsTeam.id, (await s.employee('EMP-00009')).profileId)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reach is recomputed from the hierarchy: a new report becomes manageable on the next request', async () => {
    const hr = await s.actionFor('EMP-00003');
    const moved = await s.employee('EMP-00015');
    const before = await s.actionFor('EMP-00008');
    expect(before.principal.reach?.teamMemberIds.has(moved.memberId)).toBe(false);
    await s.as(hr, async () =>
      employees.update(hr, moved.profileId, { managerId: (await s.employee('EMP-00008')).profileId }),
    );
    const after = await s.actionFor('EMP-00008');
    expect(after.principal.reach?.teamMemberIds.has(moved.memberId)).toBe(true);
    await s.as(after, () => employees.update(after, moved.profileId, { fullName: 'Rana Magdy' }));
  });
});

describe('forged hierarchy ids and cross-organization references', () => {
  it('foreign department, job title and manager ids are 404 and nothing is linked', async () => {
    const hr = await s.actionFor('EMP-00003');
    const target = await s.employee('EMP-00021');
    const foreignDepartment = await departmentId('OPS', s.northwindId);
    const foreignManager = await s.employee('NW-002', s.northwindId);
    const foreignTitle = await s.prisma.jobTitle.findFirstOrThrow({ where: { organizationId: s.northwindId } });
    await expect(
      s.as(hr, () => employees.update(hr, target.profileId, { departmentId: foreignDepartment })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(hr, () => employees.update(hr, target.profileId, { managerId: foreignManager.profileId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(hr, () => employees.update(hr, target.profileId, { jobTitleId: foreignTitle.id })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(hr, () => employees.get(hr, foreignManager.profileId))).rejects.toBeInstanceOf(NotFoundError);
    const row = await s.prisma.employeeProfile.findUniqueOrThrow({ where: { id: target.profileId } });
    expect(row.departmentId).toBe(await departmentId('HR'));
    expect(row.managerProfileId).toBe((await s.employee('EMP-00003')).profileId);
  });

  it('cross-organization team membership and department parents are rejected', async () => {
    const hr = await s.actionFor('EMP-00003');
    const team = await s.prisma.team.findFirstOrThrow({ where: { organizationId: s.demoId, name: 'Support Tier 1' } });
    const foreign = await s.employee('NW-003', s.northwindId);
    await expect(s.as(hr, () => teams.addMember(hr, team.id, foreign.profileId))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(hr, async () =>
        departments.create(hr, {
          name: 'X',
          code: 'XDEP',
          parentDepartmentId: await departmentId('OPS', s.northwindId),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const before = await s.prisma.employeeProfile.count({ where: { organizationId: s.demoId } });
    await expect(
      s.as(hr, async () =>
        employees.create(hr, { fullName: 'Cross Org', departmentId: await departmentId('OPS', s.northwindId) }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await s.prisma.employeeProfile.count({ where: { organizationId: s.demoId } })).toBe(before);
    expect(await s.prisma.teamMember.count({ where: { organizationId: s.demoId, profileId: foreign.profileId } })).toBe(
      0,
    );
  });

  it('reporting-line and department cycles are refused', async () => {
    const hr = await s.actionFor('EMP-00003');
    const gm = await s.employee('EMP-00002');
    const deepReport = await s.employee('EMP-00009');
    await expect(
      s.as(hr, () => employees.update(hr, gm.profileId, { managerId: deepReport.profileId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(hr, () => employees.update(hr, deepReport.profileId, { managerId: deepReport.profileId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(hr, async () =>
        departments.update(hr, await departmentId('ENG'), { parentDepartmentId: await departmentId('ENG-PLT') }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('composite tenant foreign keys reject cross-organization links in the new tables', async () => {
    const demoEmployee = await s.employee('EMP-00021');
    const foreign = await s.employee('NW-002', s.northwindId);
    const demoTeam = await s.prisma.team.findFirstOrThrow({ where: { organizationId: s.demoId } });
    await expectFkViolation(
      s.prisma.employeeProfile.update({
        where: { id: demoEmployee.profileId },
        data: { departmentId: await departmentId('OPS', s.northwindId) },
      }),
    );
    await expectFkViolation(
      s.prisma.employeeProfile.update({
        where: { id: demoEmployee.profileId },
        data: { managerProfileId: foreign.profileId },
      }),
    );
    await expectFkViolation(
      s.prisma.teamMember.create({
        data: { organizationId: s.demoId, teamId: demoTeam.id, profileId: foreign.profileId },
      }),
    );
    await expectFkViolation(
      s.prisma.notification.create({
        data: { organizationId: s.demoId, recipientMemberId: foreign.memberId, type: 'X_TEST', dedupeKey: 'fk' },
      }),
    );
    await expectFkViolation(
      s.prisma.memberInvitation.create({
        data: {
          organizationId: s.demoId,
          memberId: foreign.memberId,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    );
    await expectFkViolation(
      s.prisma.attachment.create({
        data: {
          organizationId: s.demoId,
          ownerType: 'EMPLOYEE_AVATAR',
          ownerId: demoEmployee.profileId,
          storageKey: `org/${s.demoId}/employee-avatar/fk-test`,
          originalFilename: 'a.png',
          declaredContentType: 'image/png',
          declaredSizeBytes: 10,
          uploadedByMemberId: foreign.memberId,
          uploadExpiresAt: new Date(),
        },
      }),
    );
  });

  it('attachment storage keys must live under the owning organization prefix (CHECK)', async () => {
    const uploader = await s.employee('EMP-00021');
    const result = await s.db.psql(
      'ops_app',
      `INSERT INTO attachments (id, organization_id, owner_type, owner_id, storage_key, original_filename,
         declared_content_type, declared_size_bytes, uploaded_by_member_id, upload_expires_at, updated_at)
       VALUES (gen_random_uuid(), '${s.demoId}', 'EMPLOYEE_AVATAR', '${uploader.profileId}',
         'org/${s.northwindId}/employee-avatar/x', 'a.png', 'image/png', 10, '${uploader.memberId}', now(), now())`,
    );
    expect(result.output).toMatch(/attachments_storage_key_check/);
  });
});

describe('last administrator protection and self-changes', () => {
  it('the only active ORG_ADMIN cannot be disabled; a second admin makes it possible', async () => {
    const hr = await s.actionFor('EMP-00003');
    const admin = await s.employee('EMP-00001');
    await expect(s.as(hr, () => employees.setMemberStatus(hr, admin.profileId, 'DISABLED'))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect((await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: admin.memberId } })).status).toBe(
      'ACTIVE',
    );

    const adminAction = await s.actionFor('EMP-00001');
    const gm = await s.employee('EMP-00002');
    await s.as(adminAction, async () => grants.grant(adminAction, gm.memberId, await roleId('ORG_ADMIN')));

    const before = await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: admin.memberId } });
    await s.as(hr, () => employees.setMemberStatus(hr, admin.profileId, 'DISABLED'));
    const after = await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: admin.memberId } });
    expect(after.status).toBe('DISABLED');
    expect(after.authzVersion).toBe(before.authzVersion + 1);
    await expect(s.as(hr, () => employees.setMemberStatus(hr, gm.profileId, 'DISABLED'))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await s.as(hr, () => employees.setMemberStatus(hr, admin.profileId, 'ACTIVE'));
    expect(
      await s.prisma.auditLog.count({
        where: { organizationId: s.demoId, action: 'member.disabled', entityId: admin.memberId },
      }),
    ).toBe(1);
  });

  it('nobody changes their own membership status', async () => {
    const hr = await s.actionFor('EMP-00003');
    await expect(
      s.as(hr, async () => employees.setMemberStatus(hr, (await s.employee('EMP-00003')).profileId, 'DISABLED')),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('role grants: privilege escalation rules', () => {
  it('role.manage is required, at ORG scope', async () => {
    const hr = await s.actionFor('EMP-00003');
    const target = await s.employee('EMP-00022');
    await expect(
      s.as(hr, async () => grants.grant(hr, target.memberId, await roleId('SUPPORT_AGENT'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await grantCustomRole('EMP-00012', 'DEPARTMENT_ROLE_ADMIN', [
      { permissionKey: 'role.manage', scope: 'DEPARTMENT' },
    ]);
    const departmentAdmin = await s.actionFor('EMP-00012');
    await expect(
      s.as(departmentAdmin, async () => grants.grant(departmentAdmin, target.memberId, await roleId('SUPPORT_AGENT'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a delegated role manager cannot grant or revoke administrator-equivalent roles or change their own', async () => {
    const delegatedRole = await grantCustomRole('EMP-00006', 'DELEGATED_ROLE_ADMIN', [
      { permissionKey: 'role.manage', scope: 'ORG' },
    ]);
    const delegate = await s.actionFor('EMP-00006');
    const target = await s.employee('EMP-00022');
    const result = await s.as(delegate, async () =>
      grants.grant(delegate, target.memberId, await roleId('SUPPORT_AGENT')),
    );
    expect(result.created).toBe(true);
    await expect(
      s.as(delegate, async () => grants.grant(delegate, target.memberId, await roleId('ORG_ADMIN'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.as(delegate, () => grants.grant(delegate, target.memberId, delegatedRole))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      s.as(delegate, async () =>
        grants.revoke(delegate, (await s.employee('EMP-00001')).memberId, await roleId('ORG_ADMIN')),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(delegate, async () => grants.grant(delegate, delegate.principal.memberId, await roleId('HR_ADMIN'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await s.prisma.memberRole.count({
        where: { organizationId: s.demoId, memberId: target.memberId, role: { key: 'ORG_ADMIN' } },
      }),
    ).toBe(0);
  });

  it('an admin cannot change their own roles; grant/revoke bump authz, audit and notify', async () => {
    const admin = await s.actionFor('EMP-00001');
    await expect(
      s.as(admin, async () => grants.revoke(admin, admin.principal.memberId, await roleId('ORG_ADMIN'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const target = await s.employee('EMP-00024');
    const before = await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: target.memberId } });
    const support = await roleId('SUPPORT_AGENT');
    await s.as(admin, () => grants.grant(admin, target.memberId, support));
    await s.as(admin, () => grants.revoke(admin, target.memberId, support));
    await expect(s.as(admin, () => grants.revoke(admin, target.memberId, support))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const after = await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: target.memberId } });
    expect(after.authzVersion).toBe(before.authzVersion + 2);
    const audit = await s.prisma.auditLog.findMany({
      where: {
        organizationId: s.demoId,
        entityId: target.memberId,
        action: { in: ['role.granted', 'role.revoked'] },
        actorType: 'USER',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['role.granted', 'role.revoked']);
    const events = await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, aggregateId: target.memberId },
    });
    expect(events.map((e) => (e.payload as { type: string }).type).sort()).toEqual(['ROLE_GRANTED', 'ROLE_REVOKED']);
  });

  it('foreign role and member ids are 404 and nothing is written', async () => {
    const admin = await s.actionFor('EMP-00001');
    const foreignMember = await s.employee('NW-002', s.northwindId);
    await expect(
      s.as(admin, async () =>
        grants.grant(admin, (await s.employee('EMP-00025')).memberId, await roleId('EMPLOYEE', s.northwindId)),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(admin, async () => grants.grant(admin, foreignMember.memberId, await roleId('EMPLOYEE'))),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(admin, () => grants.listMemberRoles(admin, foreignMember.memberId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('employee creation and invitations', () => {
  const redemption = () => new InvitationRedemptionService(s.prisma);
  const outsiderUser = () =>
    s.prisma.user.findFirstOrThrow({
      where: { idpIssuer: TEST_ISSUER, idpSubject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f06' },
    });

  it('creates an INVITED member with a profile, the baseline role and a single-use invitation', async () => {
    const hr = await s.actionFor('EMP-00003');
    const manager = await s.employee('EMP-00012');
    const created = await s.as(hr, async () =>
      employees.create(hr, {
        fullName: 'New Hire',
        workEmail: 'new.hire@demo.company-ops.test',
        departmentId: await departmentId('ENG-APP'),
        managerId: manager.profileId,
        joinDate: '2026-10-01',
      }),
    );
    expect(created.employee).toMatchObject({
      employeeNumber: 'EMP-00042',
      memberStatus: 'INVITED',
      joinDate: '2026-10-01',
    });
    expect(created.invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const member = await s.prisma.organizationMember.findUniqueOrThrow({
      where: { id: created.employee.memberId },
      include: { roles: { include: { role: true } }, invitations: true },
    });
    expect(member.userId).toBeNull();
    expect(member.roles.map((r) => r.role.key)).toEqual(['EMPLOYEE']);
    expect(member.invitations).toHaveLength(1);
    expect(member.invitations[0]?.tokenHash).not.toContain(created.invitation.token);

    await expect(
      s.as(hr, () => employees.create(hr, { fullName: 'Dup', employeeNumber: 'emp-00031' })),
    ).rejects.toBeInstanceOf(ConflictError);

    const outsider = await outsiderUser();
    const accepted = await redemption().redeem(created.invitation.token, outsider.id, { requestId: 'redeem-1' });
    expect(accepted).toEqual({ kind: 'accepted', organizationId: s.demoId, memberId: created.employee.memberId });
    const linked = await s.prisma.organizationMember.findUniqueOrThrow({ where: { id: created.employee.memberId } });
    expect(linked).toMatchObject({ userId: outsider.id, status: 'ACTIVE' });
    expect(await redemption().redeem(created.invitation.token, outsider.id, {})).toEqual({ kind: 'invalid' });
    const notice = await s.prisma.outboxEvent.findFirstOrThrow({
      where: { organizationId: s.demoId, aggregateId: created.employee.memberId },
    });
    expect(notice.payload).toMatchObject({ type: 'INVITATION_ACCEPTED', recipientMemberId: hr.principal.memberId });
    await expect(s.as(hr, () => employees.reissueInvitation(hr, created.employee.id))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it('reissue invalidates the old token; revoke and expiry invalidate the new one', async () => {
    const hr = await s.actionFor('EMP-00003');
    const created = await s.as(hr, () => employees.create(hr, { fullName: 'Second Hire' }));
    const reissued = await s.as(hr, () => employees.reissueInvitation(hr, created.employee.id));
    const outsider = await s.prisma.user.create({
      data: { idpIssuer: TEST_ISSUER, idpSubject: 'newcomer-subject', displayName: 'Newcomer' },
    });
    const admin = await s.employee('EMP-00001');
    expect(await redemption().redeem(created.invitation.token, admin.userId ?? '', {})).toEqual({ kind: 'invalid' });
    // A user who already belongs to the organization cannot take a second membership.
    expect(await redemption().redeem(reissued.token, admin.userId ?? '', {})).toEqual({ kind: 'invalid' });
    const later = new Date(Date.now() + INVITATION_TTL_MS + 60_000);
    expect(await redemption().redeem(reissued.token, outsider.id, {}, later)).toEqual({ kind: 'invalid' });
    await s.as(hr, () => employees.revokeInvitation(hr, created.employee.id));
    expect(await redemption().redeem(reissued.token, outsider.id, {})).toEqual({ kind: 'invalid' });
    expect(await redemption().redeem('not-a-token', outsider.id, {})).toEqual({ kind: 'invalid' });
  });

  it('employee.manage is required to create employees', async () => {
    const employee = await s.actionFor('EMP-00004');
    await expect(s.as(employee, () => employees.create(employee, { fullName: 'Nope' }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('members update their own contact preferences without employee.manage', async () => {
    const employee = await s.actionFor('EMP-00004');
    const updated = await s.as(employee, () =>
      employees.updateOwn(employee, { phone: '+20 111 222 3333', locale: 'ar' }),
    );
    expect(updated).toMatchObject({ phone: '+20 111 222 3333', locale: 'ar' });
    await expect(
      s.as(employee, async () =>
        employees.update(employee, (await s.employee('EMP-00004')).profileId, { fullName: 'x' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('organization settings', () => {
  it('only org.settings.manage holders change settings; values are validated and audited', async () => {
    const hr: ActionContext = await s.actionFor('EMP-00003');
    await expect(s.as(hr, () => settings.update(hr, { name: 'Hijacked' }))).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await s.actionFor('EMP-00001');
    await expect(s.as(admin, () => settings.update(admin, { timeZone: 'Mars/Olympus' }))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(s.as(admin, () => settings.update(admin, { workWeek: [0, 8] }))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    const updated = await s.as(admin, () => settings.update(admin, { name: 'Demo Company Ltd', defaultLocale: 'ar' }));
    expect(updated).toMatchObject({ name: 'Demo Company Ltd', defaultLocale: 'ar', timeZone: 'Africa/Cairo' });
    expect(
      await s.prisma.auditLog.count({ where: { organizationId: s.demoId, action: 'organization.settings.updated' } }),
    ).toBe(1);
    const northwind = await s.prisma.organization.findUniqueOrThrow({ where: { id: s.northwindId } });
    expect(northwind.name).toBe('Northwind Trading');
  });
});
