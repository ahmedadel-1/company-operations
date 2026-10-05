import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AsyncLocalTenantContext,
  AttendanceService,
  createPrismaClient,
  createTenantScopedClient,
  loadMemberAccess,
  seedDemoData,
} from '@company-ops/core';
import type { ActionContext, PrismaClient, TenantScopedClient } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';

import { sweepAttendance } from '../src/processors/attendance/attendance-jobs.js';

/**
 * The attendance maintenance job (ADR-0022) against PostgreSQL 18 with the real migrations and seed:
 * only organizations with open days are visited, each in its own system tenant context; an open
 * record past its deadline is flagged once (no invented check-out, one notification); re-runs are
 * harmless.
 */
const ISSUER = 'http://127.0.0.1:9/realms/company-ops';

let db: TestDatabase;
let prisma: PrismaClient;
let tenantDb: TenantScopedClient;
let orgId: string;
const tenant = new AsyncLocalTenantContext();

async function actionFor(employeeNumber: string): Promise<ActionContext> {
  const profile = await prisma.employeeProfile.findFirstOrThrow({
    where: { organizationId: orgId, employeeNumber },
    select: { memberId: true },
  });
  const access = await tenant.run({ organizationId: orgId, memberId: null, userId: null }, () =>
    loadMemberAccess(tenantDb, orgId, [profile.memberId]),
  );
  const member = access.get(profile.memberId);
  if (member === undefined) throw new Error(`${employeeNumber} is not an active member`);
  return { principal: member.principal, request: { requestId: `test-${employeeNumber}` } };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await db.migrate();
  prisma = createPrismaClient(db.appUrl);
  tenantDb = createTenantScopedClient(prisma, tenant);
  orgId = (await seedDemoData(prisma, ISSUER)).organizationId;
}, 240_000);

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

describe('attendance sweep job', () => {
  it('flags overdue open records once, in the organization context', async () => {
    const employee = await actionFor('EMP-00016');
    const checkInAt = new Date('2030-03-04T07:00:00.000Z');
    const attendance = new AttendanceService(tenantDb, tenant, () => checkInAt);
    const started = await tenant.run(
      { organizationId: orgId, memberId: employee.principal.memberId, userId: employee.principal.userId },
      () =>
        attendance.check(
          employee,
          'CHECK_IN',
          { location: { status: 'OK', latitude: 30.045, longitude: 31.236, accuracy: 10 } },
          randomUUID(),
        ),
    );

    const errors: unknown[] = [];
    const deps = {
      prisma,
      db: tenantDb,
      tenant,
      onOrganizationError: (_id: string, error: unknown) => errors.push(error),
    };
    const early = await sweepAttendance(deps, new Date('2030-03-04T18:00:00.000Z'));
    expect(early).toMatchObject({ organizations: 1, flagged: 0, failedOrganizations: 0 });

    const late = new Date('2030-03-04T20:00:00.000Z');
    const first = await sweepAttendance(deps, late);
    expect(first).toMatchObject({ organizations: 1, flagged: 1, failedOrganizations: 0 });
    expect(errors).toEqual([]);
    const record = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: started.record.id } });
    expect(record).toMatchObject({ status: 'MISSING_CHECKOUT', checkOutAt: null });

    const second = await sweepAttendance(deps, late);
    expect(second).toMatchObject({ flagged: 0, failedOrganizations: 0 });
    const notices = await prisma.outboxEvent.findMany({
      where: { organizationId: orgId, aggregateId: started.record.id, eventType: 'notification.requested' },
      select: { payload: true },
    });
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]?.payload)).not.toMatch(/latitude|longitude/);

    // With nothing open any more, no organization is visited.
    expect(await sweepAttendance(deps, new Date('2030-03-06T20:00:00.000Z'))).toMatchObject({ organizations: 0 });
  });
});
