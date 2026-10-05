import { MemberStatus } from '@company-ops/db';
import type { Prisma } from '@company-ops/db';
import type { SystemRoleKey } from '@company-ops/shared';

import { recordAudit } from '../platform/audit/audit-writer.js';
import type { DemoDepartment, DemoEmployee, DemoTeam } from './demo-people.js';

export interface PeopleSeed {
  readonly slug: string;
  readonly jobTitles: readonly string[];
  readonly departments: readonly DemoDepartment[];
  readonly employees: readonly DemoEmployee[];
  readonly teams: readonly DemoTeam[];
}

/**
 * Idempotently creates the organization structure and employee profiles (dev seed only). Existing
 * rows are matched by their natural keys (job title name, department code, employee number, team
 * name) and left unchanged, so re-running never resets edits made in the running application.
 */
export async function seedPeople(
  tx: Prisma.TransactionClient,
  organizationId: string,
  issuer: string,
  roleIds: Readonly<Record<SystemRoleKey, string>>,
  seed: PeopleSeed,
): Promise<{ profilesCreated: number; membershipsCreated: number }> {
  const jobTitleIds = new Map<string, string>();
  for (const name of seed.jobTitles) {
    const row =
      (await tx.jobTitle.findFirst({ where: { organizationId, name }, select: { id: true } })) ??
      (await tx.jobTitle.create({ data: { organizationId, name }, select: { id: true } }));
    jobTitleIds.set(name, row.id);
  }

  const departmentIds = new Map<string, string>();
  for (const department of seed.departments) {
    const parentId = department.parentCode === null ? null : (departmentIds.get(department.parentCode) ?? null);
    const row =
      (await tx.department.findFirst({ where: { organizationId, code: department.code }, select: { id: true } })) ??
      (await tx.department.create({
        data: { organizationId, code: department.code, name: department.name, parentDepartmentId: parentId },
        select: { id: true },
      }));
    departmentIds.set(department.code, row.id);
  }

  let profilesCreated = 0;
  let membershipsCreated = 0;
  const profileIds = new Map<string, string>();
  for (const employee of seed.employees) {
    const subject = employee.demoSubject ?? `seed-${seed.slug}-${employee.employeeNumber.toLowerCase()}`;
    const user = await tx.user.upsert({
      where: { idpIssuer_idpSubject: { idpIssuer: issuer, idpSubject: subject } },
      create: { idpIssuer: issuer, idpSubject: subject, email: employee.workEmail, displayName: employee.fullName },
      update: {},
      select: { id: true },
    });
    let member = await tx.organizationMember.findFirst({
      where: { organizationId, userId: user.id },
      select: { id: true },
    });
    if (member === null) {
      member = await tx.organizationMember.create({
        data: { organizationId, userId: user.id, status: MemberStatus.ACTIVE },
        select: { id: true },
      });
      membershipsCreated += 1;
      await recordAudit(tx, organizationId, {
        action: 'member.created',
        entityType: 'member',
        entityId: member.id,
        actor: { type: 'SYSTEM' },
        metadata: { source: 'dev-seed', status: MemberStatus.ACTIVE },
      });
    }
    for (const roleKey of employee.roles) {
      const roleId = roleIds[roleKey];
      const existing = await tx.memberRole.findFirst({
        where: { organizationId, memberId: member.id, roleId },
        select: { id: true },
      });
      if (existing === null) {
        await tx.memberRole.create({ data: { organizationId, memberId: member.id, roleId } });
        await recordAudit(tx, organizationId, {
          action: 'role.granted',
          entityType: 'member',
          entityId: member.id,
          actor: { type: 'SYSTEM' },
          metadata: { source: 'dev-seed', roleId, roleKey },
        });
      }
    }
    let profile = await tx.employeeProfile.findFirst({
      where: { organizationId, memberId: member.id },
      select: { id: true },
    });
    if (profile === null) {
      profile = await tx.employeeProfile.create({
        data: {
          organizationId,
          memberId: member.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.fullName,
          workEmail: employee.workEmail,
          phone: employee.phone,
          departmentId: departmentIds.get(employee.departmentCode) ?? null,
          jobTitleId: jobTitleIds.get(employee.jobTitle) ?? null,
          joinDate: new Date('2024-01-01T00:00:00.000Z'),
        },
        select: { id: true },
      });
      profilesCreated += 1;
    }
    profileIds.set(employee.employeeNumber, profile.id);
  }

  const highestNumber = Math.max(
    0,
    ...seed.employees.map((employee) => Number(/^EMP-(\d+)$/.exec(employee.employeeNumber)?.[1] ?? 0)),
  );
  if (highestNumber > 0) {
    const counter = await tx.organizationCounter.findFirst({ where: { organizationId, key: 'EMP' } });
    if (counter === null) {
      await tx.organizationCounter.create({ data: { organizationId, key: 'EMP', value: BigInt(highestNumber) } });
    } else if (counter.value < BigInt(highestNumber)) {
      await tx.organizationCounter.updateMany({
        where: { organizationId, key: 'EMP' },
        data: { value: BigInt(highestNumber) },
      });
    }
  }

  for (const employee of seed.employees) {
    const profileId = profileIds.get(employee.employeeNumber);
    const managerId = employee.managerNumber === null ? undefined : profileIds.get(employee.managerNumber);
    if (profileId !== undefined && managerId !== undefined) {
      await tx.employeeProfile.updateMany({
        where: { organizationId, id: profileId, managerProfileId: null },
        data: { managerProfileId: managerId },
      });
    }
  }
  for (const department of seed.departments) {
    const departmentId = departmentIds.get(department.code);
    const managerId = department.managerNumber === null ? undefined : profileIds.get(department.managerNumber);
    if (departmentId !== undefined && managerId !== undefined) {
      await tx.department.updateMany({
        where: { organizationId, id: departmentId, managerProfileId: null },
        data: { managerProfileId: managerId },
      });
    }
  }
  for (const team of seed.teams) {
    const row =
      (await tx.team.findFirst({ where: { organizationId, name: team.name }, select: { id: true } })) ??
      (await tx.team.create({
        data: {
          organizationId,
          name: team.name,
          departmentId: departmentIds.get(team.departmentCode) ?? null,
          leadProfileId: profileIds.get(team.leadNumber) ?? null,
        },
        select: { id: true },
      }));
    for (const number of team.memberNumbers) {
      const profileId = profileIds.get(number);
      if (profileId === undefined) {
        continue;
      }
      const existing = await tx.teamMember.findFirst({
        where: { organizationId, teamId: row.id, profileId },
        select: { id: true },
      });
      if (existing === null) {
        await tx.teamMember.create({ data: { organizationId, teamId: row.id, profileId } });
      }
    }
  }
  return { profilesCreated, membershipsCreated };
}
