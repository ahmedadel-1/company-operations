import { withOperationGuard } from '@company-ops/db';
import type { GuardedPrismaClient, PrismaClient } from '@company-ops/db';

import { TenantIsolationError } from '../errors.js';
import { requireTenantContext } from './tenant-context.js';
import type { TenantContextAccessor } from './tenant-context.js';
import { isModelName, MODEL_TENANCY, SCALAR_FIELDS } from './tenant-models.js';

/**
 * Prisma guard extension (ADR-0003 enforcement layer 2). Fails closed: an operation on a tenant
 * model must be explicitly bound to the active organization, otherwise it throws before reaching
 * the database.
 *
 * Rules (checked on the arguments exactly as passed by the caller):
 * - Filters: the top-level `where` must contain `organizationId` equal to the active organization,
 *   either directly (`organizationId: id` or `{ equals: id }`) or inside a compound unique key
 *   (`organizationId_id: { organizationId, id }`). Top-level `where` keys are AND-ed, so additional
 *   `OR`/`NOT` clauses cannot widen the scope. `in`, `not` and other operators on organizationId are
 *   rejected.
 * - Writes: `data` must contain only scalar fields (nested relation writes are rejected) and its
 *   `organizationId`, when present, must equal the active organization; creates must set it.
 * - Relation reads (`include`/`select`) are allowed: composite foreign keys guarantee that related
 *   tenant rows belong to the same organization as the bound root row.
 * - `organizations` (tenant root) is reachable only for the active organization's id. `users` is
 *   global identity: it cannot be queried directly (that would span tenants), only read through a
 *   relation of a bound tenant row (e.g. a member's `user`). Identity resolution uses the base
 *   client in `IdentityService`. Platform tables are not reachable at all.
 * - `$queryRawUnsafe` / `$executeRawUnsafe` always throw. Tagged `$queryRaw` / `$executeRaw` are
 *   allowed only in `platform/db/sql/` (lint rule) and must bind organization_id explicitly.
 *
 * Limitations: the guard cannot see inside tagged raw SQL, and it relies on composite foreign keys
 * for the organization of rows reached through relations.
 */

const FILTER_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const DELETE_OPERATIONS = new Set(['delete', 'deleteMany']);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const TENANT_ROOT_OPERATIONS = new Set(['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'update']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function violation(model: string, operation: string, reason: string): TenantIsolationError {
  return new TenantIsolationError(`Tenant guard rejected ${model}.${operation}: ${reason}`);
}

/** Organization ids the filter is bound to through top-level equality (direct or compound unique key). */
function organizationBindings(where: Record<string, unknown>): { values: unknown[]; unsupported: boolean } {
  const values: unknown[] = [];
  let unsupported = false;
  const direct = where.organizationId;
  if (direct !== undefined) {
    if (typeof direct === 'string') {
      values.push(direct);
    } else if (isRecord(direct) && Object.keys(direct).length === 1 && typeof direct.equals === 'string') {
      values.push(direct.equals);
    } else {
      unsupported = true;
    }
  }
  for (const [key, value] of Object.entries(where)) {
    if (key.startsWith('organizationId_') && isRecord(value)) {
      values.push(value.organizationId);
    }
  }
  return { values, unsupported };
}

function assertBoundFilter(model: string, operation: string, args: unknown, organizationId: string): void {
  const where = isRecord(args) ? args.where : undefined;
  if (!isRecord(where)) {
    throw violation(model, operation, 'missing where clause bound to the active organization');
  }
  const { values, unsupported } = organizationBindings(where);
  if (unsupported) {
    throw violation(model, operation, 'organizationId must be matched by equality');
  }
  if (values.length === 0) {
    throw violation(model, operation, 'where clause is not bound to the active organization');
  }
  if (values.some((value) => value !== organizationId)) {
    throw violation(model, operation, 'where clause targets a different organization');
  }
}

function assertScalarData(
  model: keyof typeof SCALAR_FIELDS,
  operation: string,
  data: unknown,
  organizationId: string,
  mode: 'create' | 'update',
): void {
  if (!isRecord(data)) {
    throw violation(model, operation, 'data must be an object');
  }
  const scalars = SCALAR_FIELDS[model];
  for (const key of Object.keys(data)) {
    if (!scalars.has(key)) {
      throw violation(model, operation, `nested relation writes are not allowed (field "${key}")`);
    }
  }
  if (mode === 'create' && data.organizationId !== organizationId) {
    throw violation(model, operation, 'created rows must set organizationId to the active organization');
  }
  if (mode === 'update' && data.organizationId !== undefined && data.organizationId !== organizationId) {
    throw violation(model, operation, 'organizationId cannot be changed');
  }
}

/**
 * Validates one model operation against the active organization. Exported for unit tests; runtime
 * code uses {@link createTenantScopedClient}.
 */
export function assertTenantSafeOperation(
  model: string,
  operation: string,
  args: unknown,
  organizationId: string | undefined,
): void {
  if (!isModelName(model)) {
    throw violation(model, operation, 'unknown model');
  }
  const tenancy = MODEL_TENANCY[model];
  if (tenancy === 'global') {
    throw violation(model, operation, 'global identity is reachable only through relations of bound tenant rows');
  }
  if (tenancy === 'platform') {
    throw violation(model, operation, 'platform data is not reachable through the tenant-scoped client');
  }
  if (organizationId === undefined) {
    throw violation(model, operation, 'no active tenant context');
  }

  if (tenancy === 'tenant-root') {
    if (!TENANT_ROOT_OPERATIONS.has(operation)) {
      throw violation(model, operation, 'operation not allowed on the tenant root');
    }
    const where = isRecord(args) ? args.where : undefined;
    if (!isRecord(where) || where.id !== organizationId) {
      throw violation(model, operation, 'only the active organization is reachable');
    }
    if (operation === 'update') {
      const data = isRecord(args) ? args.data : undefined;
      assertScalarData(model, operation, data, organizationId, 'update');
      if (isRecord(data) && data.id !== undefined) {
        throw violation(model, operation, 'id cannot be changed');
      }
    }
    return;
  }

  if (FILTER_OPERATIONS.has(operation) || DELETE_OPERATIONS.has(operation)) {
    assertBoundFilter(model, operation, args, organizationId);
    return;
  }
  if (UPDATE_OPERATIONS.has(operation)) {
    assertBoundFilter(model, operation, args, organizationId);
    assertScalarData(model, operation, isRecord(args) ? args.data : undefined, organizationId, 'update');
    return;
  }
  if (CREATE_OPERATIONS.has(operation)) {
    const data = isRecord(args) ? args.data : undefined;
    const rows = Array.isArray(data) ? (data as unknown[]) : [data];
    if (rows.length === 0) {
      throw violation(model, operation, 'no rows to create');
    }
    for (const row of rows) {
      assertScalarData(model, operation, row, organizationId, 'create');
    }
    return;
  }
  if (operation === 'upsert') {
    assertBoundFilter(model, operation, args, organizationId);
    assertScalarData(model, operation, isRecord(args) ? args.create : undefined, organizationId, 'create');
    assertScalarData(model, operation, isRecord(args) ? args.update : undefined, organizationId, 'update');
    return;
  }
  throw violation(model, operation, 'operation is not supported by the tenant guard');
}

function rejectUnsafeRaw(operation: string): never {
  throw new TenantIsolationError(`${operation} is forbidden (ADR-0003). Use tagged SQL in platform/db/sql/.`);
}

/**
 * Wraps a Prisma client with the tenant guard. Applies to every operation issued through the
 * returned client, including inside interactive and batch transactions.
 */
export function createTenantScopedClient(prisma: PrismaClient, tenant: TenantContextAccessor): TenantScopedClient {
  return withOperationGuard(prisma, 'tenant-guard', {
    checkModelOperation: (model, operation, args) => {
      assertTenantSafeOperation(model, operation, args, tenant.get()?.organizationId);
    },
    rejectUnsafeRaw,
  });
}

export type TenantScopedClient = GuardedPrismaClient;

/** Client or interactive-transaction client of the tenant-scoped client. */
export type TenantDb = Omit<TenantScopedClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$extends'>;

/** Organization id of the active tenant; throws when no tenant context is active. */
export function activeOrganizationId(tenant: TenantContextAccessor): string {
  return requireTenantContext(tenant).organizationId;
}
