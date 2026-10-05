import type { PrismaClient } from '@company-ops/db';

import { recordAudit } from '../platform/audit/audit-writer.js';
import { materializeSystemRoles, provisionOrganization } from '../modules/organizations/provision-organization.js';
import type { NewOrganization } from '../modules/organizations/provision-organization.js';
import { DEMO_ORGANIZATION, DEMO_USERS } from './demo-data.js';
import {
  DEMO_DEPARTMENTS,
  DEMO_EMPLOYEES,
  DEMO_JOB_TITLES,
  DEMO_TEAMS,
  SECOND_ORG_DEPARTMENTS,
  SECOND_ORG_EMPLOYEES,
  SECOND_ORG_JOB_TITLES,
  SECOND_ORGANIZATION,
} from './demo-people.js';
import { seedAttendance } from './seed-attendance.js';
import { seedPeople } from './seed-people.js';
import { seedProjects } from './seed-projects.js';
import { seedRequests } from './seed-requests.js';
import { seedSupport } from './seed-support.js';

export interface SeedReport {
  readonly organizationId: string;
  readonly secondOrganizationId: string;
  readonly organizationCreated: boolean;
  readonly usersUpserted: number;
  readonly membershipsCreated: number;
  readonly roleGrantsCreated: number;
  readonly profilesCreated: number;
  readonly projectsCreated: number;
  readonly ticketsCreated: number;
  readonly requestTypesCreated: number;
  readonly shiftAssignmentsCreated: number;
}

export class SeedRefusedError extends Error {
  constructor(reason: string) {
    super(`Development seed refused: ${reason}`);
    this.name = 'SeedRefusedError';
  }
}

/** Both conditions are required (ROADMAP P1-4); checked again here so callers cannot skip them. */
export function assertSeedAllowed(nodeEnv: string, allowDemoSeed: boolean): void {
  if (nodeEnv === 'production') {
    throw new SeedRefusedError('NODE_ENV is production.');
  }
  if (!allowDemoSeed) {
    throw new SeedRefusedError('ALLOW_DEMO_SEED is not true.');
  }
}

const SEED_TRANSACTION = { timeout: 120_000, maxWait: 10_000 } as const;

async function ensureOrganization(
  prisma: PrismaClient,
  input: NewOrganization,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.organization.findUnique({ where: { slug: input.slug }, select: { id: true } });
  if (existing !== null) {
    return { id: existing.id, created: false };
  }
  const provisioned = await provisionOrganization(prisma, input, { type: 'SYSTEM' });
  return { id: provisioned.organizationId, created: true };
}

/**
 * Idempotent development data: the demo organization (system roles, the Keycloak demo users with
 * their memberships and role grants, departments, job titles, teams, ~30 employee profiles, and
 * demo customers, work locations, projects, support configuration, request types and attendance
 * configuration) and a second organization in which `gm` is also a member. Re-running creates only what is missing
 * and never resets existing grants, statuses or edits.
 */
export async function seedDemoData(prisma: PrismaClient, issuer: string): Promise<SeedReport> {
  const demo = await ensureOrganization(prisma, {
    ...DEMO_ORGANIZATION,
    workWeek: [...DEMO_ORGANIZATION.workWeek],
  });
  const second = await ensureOrganization(prisma, {
    ...SECOND_ORGANIZATION,
    workWeek: [...SECOND_ORGANIZATION.workWeek],
  });
  const organizationId = demo.id;

  const demoResult = await prisma.$transaction(async (tx) => {
    const { roleIds } = await materializeSystemRoles(tx, organizationId);
    let membershipsCreated = 0;
    let roleGrantsCreated = 0;

    for (const demoUser of DEMO_USERS) {
      const user = await tx.user.upsert({
        where: { idpIssuer_idpSubject: { idpIssuer: issuer, idpSubject: demoUser.subject } },
        create: {
          idpIssuer: issuer,
          idpSubject: demoUser.subject,
          email: demoUser.email,
          displayName: demoUser.displayName,
        },
        update: {},
        select: { id: true },
      });
      if (demoUser.membership === null) {
        continue;
      }
      let member = await tx.organizationMember.findFirst({
        where: { organizationId, userId: user.id },
        select: { id: true },
      });
      if (member === null) {
        member = await tx.organizationMember.create({
          data: { organizationId, userId: user.id, status: demoUser.membership.status },
          select: { id: true },
        });
        membershipsCreated += 1;
        await recordAudit(tx, organizationId, {
          action: 'member.created',
          entityType: 'member',
          entityId: member.id,
          actor: { type: 'SYSTEM' },
          metadata: { source: 'dev-seed', status: demoUser.membership.status },
        });
      }
      for (const roleKey of demoUser.membership.roles) {
        const roleId = roleIds[roleKey];
        const existing = await tx.memberRole.findFirst({
          where: { organizationId, memberId: member.id, roleId },
          select: { id: true },
        });
        if (existing !== null) {
          continue;
        }
        await tx.memberRole.create({ data: { organizationId, memberId: member.id, roleId } });
        roleGrantsCreated += 1;
        await recordAudit(tx, organizationId, {
          action: 'role.granted',
          entityType: 'member',
          entityId: member.id,
          actor: { type: 'SYSTEM' },
          metadata: { source: 'dev-seed', roleId, roleKey },
        });
      }
    }
    const people = await seedPeople(tx, organizationId, issuer, roleIds, {
      slug: DEMO_ORGANIZATION.slug,
      jobTitles: DEMO_JOB_TITLES,
      departments: DEMO_DEPARTMENTS,
      employees: DEMO_EMPLOYEES,
      teams: DEMO_TEAMS,
    });
    const projects = await seedProjects(tx, organizationId);
    const support = await seedSupport(tx, organizationId);
    const requests = await seedRequests(tx, organizationId, roleIds);
    const attendance = await seedAttendance(tx, organizationId);
    return {
      shiftAssignmentsCreated: attendance.assignmentsCreated,
      ticketsCreated: support.ticketsCreated,
      requestTypesCreated: requests.requestTypesCreated,
      membershipsCreated: membershipsCreated + people.membershipsCreated,
      roleGrantsCreated,
      profilesCreated: people.profilesCreated,
      projectsCreated: projects.projectsCreated,
    };
  }, SEED_TRANSACTION);

  const secondResult = await prisma.$transaction(async (tx) => {
    const { roleIds } = await materializeSystemRoles(tx, second.id);
    return seedPeople(tx, second.id, issuer, roleIds, {
      slug: SECOND_ORGANIZATION.slug,
      jobTitles: SECOND_ORG_JOB_TITLES,
      departments: SECOND_ORG_DEPARTMENTS,
      employees: SECOND_ORG_EMPLOYEES,
      teams: [],
    });
  }, SEED_TRANSACTION);

  return {
    organizationId,
    secondOrganizationId: second.id,
    organizationCreated: demo.created,
    usersUpserted: DEMO_USERS.length,
    membershipsCreated: demoResult.membershipsCreated + secondResult.membershipsCreated,
    roleGrantsCreated: demoResult.roleGrantsCreated,
    profilesCreated: demoResult.profilesCreated + secondResult.profilesCreated,
    projectsCreated: demoResult.projectsCreated,
    ticketsCreated: demoResult.ticketsCreated,
    requestTypesCreated: demoResult.requestTypesCreated,
    shiftAssignmentsCreated: demoResult.shiftAssignmentsCreated,
  };
}
