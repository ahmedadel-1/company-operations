import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPrismaClient } from '@company-ops/db';
import type { EmploymentStatus, MemberStatus, Prisma } from '@company-ops/db';

/**
 * The seeded state that decides what a demo user may see and do: organization settings (time zone and
 * work week drive business dates), membership status, role grants, reporting lines and team membership.
 * Captured once after seeding and restored before every spec file, so no spec depends on what an
 * earlier spec granted, revoked or reconfigured.
 */
interface Baseline {
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly timeZone: string;
    readonly workWeek: readonly number[];
    readonly defaultLocale: string;
  }[];
  readonly members: readonly { readonly id: string; readonly organizationId: string; readonly status: MemberStatus }[];
  readonly memberRoles: readonly {
    readonly organizationId: string;
    readonly memberId: string;
    readonly roleId: string;
  }[];
  readonly profiles: readonly {
    readonly id: string;
    readonly organizationId: string;
    readonly departmentId: string | null;
    readonly managerProfileId: string | null;
    readonly employmentStatus: EmploymentStatus;
  }[];
  readonly teamMembers: readonly {
    readonly organizationId: string;
    readonly teamId: string;
    readonly profileId: string;
  }[];
}

export interface BaselineDrift {
  readonly organizations: number;
  readonly members: number;
  readonly memberRoles: number;
  readonly profiles: number;
  readonly teamMembers: number;
}

const baselineFile = (runDir: string): string => join(runDir, 'baseline.json');

function databaseUrl(): string {
  const value = process.env.E2E_DATABASE_URL;
  if (value === undefined || value === '') {
    throw new Error('E2E_DATABASE_URL is not set; run the suite through playwright.config.ts (global setup).');
  }
  return value;
}

async function read(prisma: Prisma.TransactionClient): Promise<Baseline> {
  const [organizations, members, memberRoles, profiles, teamMembers] = await Promise.all([
    prisma.organization.findMany({
      select: { id: true, name: true, timeZone: true, workWeek: true, defaultLocale: true },
      orderBy: { id: 'asc' },
    }),
    prisma.organizationMember.findMany({
      select: { id: true, organizationId: true, status: true },
      orderBy: { id: 'asc' },
    }),
    prisma.memberRole.findMany({
      select: { organizationId: true, memberId: true, roleId: true },
      orderBy: { id: 'asc' },
    }),
    prisma.employeeProfile.findMany({
      select: { id: true, organizationId: true, departmentId: true, managerProfileId: true, employmentStatus: true },
      orderBy: { id: 'asc' },
    }),
    prisma.teamMember.findMany({
      select: { organizationId: true, teamId: true, profileId: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  return { organizations, members, memberRoles, profiles, teamMembers };
}

/** Global setup: records the seeded state for this run. */
export async function captureBaseline(url: string, runDir: string): Promise<void> {
  const prisma = createPrismaClient(url);
  try {
    writeFileSync(baselineFile(runDir), JSON.stringify(await read(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

const roleKey = (row: { memberId: string; roleId: string }): string => `${row.memberId}|${row.roleId}`;
const teamKey = (row: { teamId: string; profileId: string }): string => `${row.teamId}|${row.profileId}`;

/**
 * Puts every baseline row back. Members whose grants, status or reach inputs changed get their
 * `authz_version` bumped, so existing sessions recompute permissions on the next request exactly as
 * they do after a real role change. Rows created by tests that are not part of the baseline (projects,
 * tickets, new departments) are left alone: specs create uniquely named data.
 */
export async function restoreBaseline(runDir: string): Promise<BaselineDrift> {
  const baseline = JSON.parse(readFileSync(baselineFile(runDir), 'utf8')) as Baseline;
  const prisma = createPrismaClient(databaseUrl());
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await read(tx);
      const touchedMembers = new Set<string>();
      const profileMember = new Map(
        (await tx.employeeProfile.findMany({ select: { id: true, memberId: true } })).map((p) => [p.id, p.memberId]),
      );
      let organizations = 0;
      for (const wanted of baseline.organizations) {
        const now = current.organizations.find((o) => o.id === wanted.id);
        if (
          now !== undefined &&
          (now.name !== wanted.name ||
            now.timeZone !== wanted.timeZone ||
            now.defaultLocale !== wanted.defaultLocale ||
            now.workWeek.join(',') !== wanted.workWeek.join(','))
        ) {
          await tx.organization.update({
            where: { id: wanted.id },
            data: {
              name: wanted.name,
              timeZone: wanted.timeZone,
              defaultLocale: wanted.defaultLocale,
              workWeek: [...wanted.workWeek],
            },
          });
          organizations += 1;
        }
      }
      let members = 0;
      for (const wanted of baseline.members) {
        const now = current.members.find((m) => m.id === wanted.id);
        if (now !== undefined && now.status !== wanted.status) {
          await tx.organizationMember.update({
            where: { id: wanted.id },
            data: { status: wanted.status },
          });
          touchedMembers.add(wanted.id);
          members += 1;
        }
      }
      const wantedRoles = new Set(baseline.memberRoles.map(roleKey));
      const currentRoles = new Set(current.memberRoles.map(roleKey));
      let memberRoles = 0;
      for (const row of current.memberRoles) {
        if (!wantedRoles.has(roleKey(row))) {
          await tx.memberRole.deleteMany({
            where: { organizationId: row.organizationId, memberId: row.memberId, roleId: row.roleId },
          });
          touchedMembers.add(row.memberId);
          memberRoles += 1;
        }
      }
      for (const row of baseline.memberRoles) {
        if (!currentRoles.has(roleKey(row))) {
          await tx.memberRole.create({ data: { ...row } });
          touchedMembers.add(row.memberId);
          memberRoles += 1;
        }
      }
      let profiles = 0;
      for (const wanted of baseline.profiles) {
        const now = current.profiles.find((p) => p.id === wanted.id);
        if (
          now !== undefined &&
          (now.departmentId !== wanted.departmentId ||
            now.managerProfileId !== wanted.managerProfileId ||
            now.employmentStatus !== wanted.employmentStatus)
        ) {
          await tx.employeeProfile.update({
            where: { id: wanted.id },
            data: {
              departmentId: wanted.departmentId,
              managerProfileId: wanted.managerProfileId,
              employmentStatus: wanted.employmentStatus,
            },
          });
          const memberId = profileMember.get(wanted.id);
          if (memberId !== undefined) touchedMembers.add(memberId);
          profiles += 1;
        }
      }
      const wantedTeams = new Set(baseline.teamMembers.map(teamKey));
      const currentTeams = new Set(current.teamMembers.map(teamKey));
      let teamMembers = 0;
      for (const row of current.teamMembers) {
        if (!wantedTeams.has(teamKey(row))) {
          await tx.teamMember.deleteMany({
            where: { organizationId: row.organizationId, teamId: row.teamId, profileId: row.profileId },
          });
          const memberId = profileMember.get(row.profileId);
          if (memberId !== undefined) touchedMembers.add(memberId);
          teamMembers += 1;
        }
      }
      for (const row of baseline.teamMembers) {
        if (!currentTeams.has(teamKey(row))) {
          await tx.teamMember.create({ data: { ...row } });
          const memberId = profileMember.get(row.profileId);
          if (memberId !== undefined) touchedMembers.add(memberId);
          teamMembers += 1;
        }
      }
      if (touchedMembers.size > 0) {
        await tx.organizationMember.updateMany({
          where: { id: { in: [...touchedMembers] } },
          data: { authzVersion: { increment: 1 } },
        });
      }
      return { organizations, members, memberRoles, profiles, teamMembers };
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Moves a ticket's SLA clock origin into the past, as if it had been reported `minutes` ago (used by
 * the SLA scenario only). The worker's next sweep recomputes the due dates, states and escalations
 * from it exactly as it does for a genuinely old ticket.
 */
export async function backdateTicketSlaForTest(ticketId: string, minutes: number): Promise<void> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const updated = await prisma.supportTicket.updateMany({
      where: { id: ticketId },
      data: { slaStartedAt: new Date(Date.now() - minutes * 60_000) },
    });
    if (updated.count !== 1) {
      throw new Error(`Ticket ${ticketId} not found.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Points an employee's reporting line at another employee (by employee number) and returns the previous
 * manager's number so the test can restore it. Team reach is resolved per request, so the change applies
 * to the next request; approval routing reads the line at submission. The baseline restore also puts
 * reporting lines back before the next spec file.
 */
export async function setManagerForTest(
  organizationSlug: string,
  employeeNumber: string,
  managerNumber: string | null,
): Promise<string | null> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    const profile = await prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId: organization.id, employeeNumber },
      select: { id: true, manager: { select: { employeeNumber: true } } },
    });
    const manager =
      managerNumber === null
        ? null
        : await prisma.employeeProfile.findFirstOrThrow({
            where: { organizationId: organization.id, employeeNumber: managerNumber },
            select: { id: true },
          });
    await prisma.employeeProfile.update({
      where: { id: profile.id },
      data: { managerProfileId: manager?.id ?? null },
    });
    return profile.manager?.employeeNumber ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Moves the start of an employee's open-ended shift assignment `days` into the past, as if it had been
 * assigned earlier (the dev seed assigns from the seeding day). Ending it "yesterday" through the admin
 * screen and assigning another shift from today then works exactly as for a long-standing assignment.
 */
export async function backdateShiftAssignmentForTest(
  organizationSlug: string,
  employeeNumber: string,
  days: number,
): Promise<void> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    const assignment = await prisma.employeeShiftAssignment.findFirstOrThrow({
      where: { organizationId: organization.id, effectiveTo: null, profile: { employeeNumber } },
      select: { id: true, effectiveFrom: true },
    });
    await prisma.employeeShiftAssignment.update({
      where: { id: assignment.id },
      data: { effectiveFrom: new Date(assignment.effectiveFrom.getTime() - days * 86_400_000) },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Moves the due time of a request's pending approvals an hour into the past, as if the step had been
 * waiting longer than its target (dashboard scenarios only). Overdue is derived from `dueAt` on read.
 */
export async function makeApprovalOverdueForTest(requestId: string): Promise<void> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const updated = await prisma.requestApproval.updateMany({
      where: { requestId, status: 'PENDING' },
      data: { dueAt: new Date(Date.now() - 3_600_000) },
    });
    if (updated.count === 0) {
      throw new Error(`Request ${requestId} has no pending approval.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A tender and a contract owned by another organization (`organizationSlug`), created directly in the
 * database: the cross-tenant scenarios must prove they stay invisible, so no API of the demo
 * organization may be used to make them. Returns their ids.
 */
export async function createForeignCommercialForTest(
  organizationSlug: string,
  title: string,
): Promise<{ tenderId: string; contractId: string }> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    const owner = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: organization.id, status: 'ACTIVE' },
      select: { id: true },
    });
    const number = 9000 + Math.floor(Math.random() * 900_000);
    const tender = await prisma.tender.create({
      data: {
        organizationId: organization.id,
        number,
        year: 2026,
        title,
        tenderType: 'RFQ',
        ownerMemberId: owner.id,
        createdByMemberId: owner.id,
      },
      select: { id: true },
    });
    const contract = await prisma.contract.create({
      data: {
        organizationId: organization.id,
        number,
        year: 2026,
        title,
        contractType: 'SERVICES',
        currency: 'GBP',
        originalValue: '1000.00',
        currentValue: '1000.00',
        ownerMemberId: owner.id,
        createdByMemberId: owner.id,
      },
      select: { id: true },
    });
    return { tenderId: tender.id, contractId: contract.id };
  } finally {
    await prisma.$disconnect();
  }
}

/** Grants a system role to a demo member directly (isolation and approval-routing tests only). */
export async function grantSystemRoleForTest(
  organizationSlug: string,
  email: string,
  roleKeyName: string,
): Promise<void> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    const member = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: organization.id, user: { email } },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { organizationId: organization.id, key: roleKeyName },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.memberRole.create({ data: { organizationId: organization.id, memberId: member.id, roleId: role.id } }),
      prisma.organizationMember.update({ where: { id: member.id }, data: { authzVersion: { increment: 1 } } }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

/** Removes a system role granted by `grantSystemRoleForTest`. */
export async function revokeSystemRoleForTest(
  organizationSlug: string,
  email: string,
  roleKeyName: string,
): Promise<void> {
  const prisma = createPrismaClient(databaseUrl());
  try {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    const member = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: organization.id, user: { email } },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { organizationId: organization.id, key: roleKeyName },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.memberRole.deleteMany({
        where: { organizationId: organization.id, memberId: member.id, roleId: role.id },
      }),
      prisma.organizationMember.update({ where: { id: member.id }, data: { authzVersion: { increment: 1 } } }),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}
