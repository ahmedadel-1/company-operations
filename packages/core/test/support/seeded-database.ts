import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';

import { seedDemoData } from '../../src/dev-seed/seed.js';
import type { ActionContext } from '../../src/modules/action-context.js';
import { computeEffectivePermissions } from '../../src/modules/authorization/effective-permissions.js';
import { ScopeReachResolver } from '../../src/modules/authorization/scope-reach.js';
import { createPrismaClient } from '../../src/platform/db/prisma.js';
import type { PrismaClient } from '../../src/platform/db/prisma.js';
import { AsyncLocalTenantContext } from '../../src/platform/tenancy/tenant-context.js';
import { createTenantScopedClient } from '../../src/platform/tenancy/tenant-guard.js';
import type { TenantScopedClient } from '../../src/platform/tenancy/tenant-guard.js';

export const TEST_ISSUER = 'http://keycloak.test/realms/company-ops';

export interface Employee {
  readonly profileId: string;
  readonly memberId: string;
  readonly userId: string | null;
  readonly departmentId: string | null;
}

/**
 * A disposable PostgreSQL with the real migrations and the development seed (demo organization
 * plus `northwind`), connected as the runtime role. Principals are built exactly like the API
 * builds them: role grants from the database, TEAM/DEPARTMENT reach from the hierarchy SQL.
 */
export interface SeededDatabase {
  readonly db: TestDatabase;
  readonly prisma: PrismaClient;
  readonly tenantDb: TenantScopedClient;
  readonly tenant: AsyncLocalTenantContext;
  readonly demoId: string;
  readonly northwindId: string;
  employee(employeeNumber: string, organizationId?: string): Promise<Employee>;
  actionFor(employeeNumber: string, organizationId?: string): Promise<ActionContext>;
  /** Runs `fn` inside the acting member's tenant context (queries are awaited inside it). */
  as<T>(action: ActionContext, fn: () => PromiseLike<T>): Promise<T>;
  /** Runs `fn` inside a system tenant context of `organizationId` (worker-style). */
  asSystem<T>(organizationId: string, fn: () => PromiseLike<T>): Promise<T>;
  stop(): Promise<void>;
}

export async function startSeededDatabase(): Promise<SeededDatabase> {
  const db = await startTestDatabase();
  await db.migrate();
  const prisma = createPrismaClient(db.appUrl);
  const tenant = new AsyncLocalTenantContext();
  const tenantDb = createTenantScopedClient(prisma, tenant);
  const report = await seedDemoData(prisma, TEST_ISSUER);
  const reach = new ScopeReachResolver(prisma);

  const employee = async (employeeNumber: string, organizationId = report.organizationId): Promise<Employee> => {
    const row = await prisma.employeeProfile.findFirstOrThrow({
      where: { organizationId, employeeNumber },
      select: { id: true, departmentId: true, member: { select: { id: true, userId: true } } },
    });
    return { profileId: row.id, memberId: row.member.id, userId: row.member.userId, departmentId: row.departmentId };
  };

  return {
    db,
    prisma,
    tenantDb,
    tenant,
    demoId: report.organizationId,
    northwindId: report.secondOrganizationId,
    employee,
    actionFor: async (employeeNumber, organizationId = report.organizationId) => {
      const subject = await employee(employeeNumber, organizationId);
      if (subject.userId === null) {
        throw new Error(`${employeeNumber} has no linked user`);
      }
      const grants = await prisma.rolePermission.findMany({
        where: { organizationId, role: { memberRoles: { some: { memberId: subject.memberId } } } },
        select: { permissionKey: true, scope: true },
      });
      const principal = await reach.principal({
        organizationId,
        memberId: subject.memberId,
        userId: subject.userId,
        permissions: computeEffectivePermissions(grants),
      });
      return { principal, request: { requestId: `test-${employeeNumber}` } };
    },
    as: (action, fn) =>
      tenant.run(
        {
          organizationId: action.principal.organizationId,
          memberId: action.principal.memberId,
          userId: action.principal.userId,
        },
        async () => await fn(),
      ),
    asSystem: (organizationId, fn) =>
      tenant.run({ organizationId, memberId: null, userId: null }, async () => await fn()),
    stop: async () => {
      await prisma.$disconnect();
      await db.stop();
    },
  };
}
