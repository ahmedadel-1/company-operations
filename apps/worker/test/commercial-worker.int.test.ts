import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AsyncLocalTenantContext,
  ContractService,
  createPrismaClient,
  createTenantScopedClient,
  loadMemberAccess,
  seedDemoData,
} from '@company-ops/core';
import type { ActionContext, DashboardDomain, PrismaClient, TenantScopedClient } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';

import { runCommercialMonitor } from '../src/processors/commercial/commercial-jobs.js';

/**
 * The commercial monitor job (ADR-0026) against PostgreSQL 18 with the real migrations and seed:
 * only organizations holding commercial records are visited, each in its own system tenant context;
 * a live contract past its expiry is expired once and the commercial dashboard is invalidated;
 * re-runs change nothing.
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

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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

describe('commercial monitor job', () => {
  it('visits only organizations with commercial records, expires once and invalidates the dashboard', async () => {
    const invalidated: { organizationId: string; domains: readonly DashboardDomain[] }[] = [];
    const errors: unknown[] = [];
    const deps = {
      prisma,
      db: tenantDb,
      tenant,
      onOrganizationError: (_id: string, error: unknown) => errors.push(error),
      invalidate: (organizationId: string, domains: readonly DashboardDomain[]) => {
        invalidated.push({ organizationId, domains });
        return Promise.resolve();
      },
    };
    const idle = await runCommercialMonitor(deps, new Date());
    expect(idle).toMatchObject({ organizations: 0, contractsExpired: 0, failedOrganizations: 0 });

    const gm = await actionFor('EMP-00002');
    const contracts = new ContractService(tenantDb, tenant);
    const actor = { organizationId: orgId, memberId: gm.principal.memberId, userId: gm.principal.userId };
    const draft = await tenant.run(actor, () =>
      contracts.create(gm, {
        title: 'Expired maintenance',
        contractType: 'MAINTENANCE',
        currency: 'EGP',
        originalValue: '5000.00',
        startDate: isoDate(-400),
        expiryDate: isoDate(100),
        ownerMemberId: gm.principal.memberId,
      }),
    );
    let version = draft.version;
    for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
      version = (await tenant.run(actor, () => contracts.transition(gm, draft.id, { version, to }))).version;
    }
    const lapsed = new Date(`${isoDate(-3)}T00:00:00Z`);
    await prisma.contract.update({
      where: { id: draft.id },
      data: { originalExpiryDate: lapsed, currentExpiryDate: lapsed },
    });

    const first = await runCommercialMonitor(deps, new Date());
    expect(errors).toEqual([]);
    expect(first).toMatchObject({ organizations: 1, contractsExpired: 1, failedOrganizations: 0 });
    expect(invalidated).toEqual([{ organizationId: orgId, domains: ['commercial'] }]);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('EXPIRED');
    const notifications = await prisma.notification.count({ where: { organizationId: orgId, entityId: draft.id } });

    const second = await runCommercialMonitor(deps, new Date());
    expect(second).toMatchObject({ organizations: 1, reminders: 0, contractsExpired: 0, failedOrganizations: 0 });
    expect(await prisma.notification.count({ where: { organizationId: orgId, entityId: draft.id } })).toBe(
      notifications,
    );
  });
});
