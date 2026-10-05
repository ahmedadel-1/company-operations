import type { Prisma } from '@company-ops/db';
import { ATTENDANCE_CORRECTION_TYPE_KEY } from '@company-ops/validation';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { NormalizedData } from './engine/conditions.js';
import { requestTypeRefSelect } from './request-views.js';

export const catalogTypeSelect = {
  ...requestTypeRefSelect,
  description: true,
  requesterRoles: { select: { roleId: true } },
  definition: { select: { versions: { where: { status: 'PUBLISHED' }, select: { id: true, number: true }, take: 1 } } },
} satisfies Prisma.RequestTypeSelect;

export type CatalogTypeRow = Prisma.RequestTypeGetPayload<{ select: typeof catalogTypeSelect }>;

export interface AvailableType {
  readonly row: CatalogTypeRow;
  readonly publishedVersionId: string;
}

async function memberRoleIds(db: TenantDb, organizationId: string, memberId: string): Promise<Set<string>> {
  const rows = await db.memberRole.findMany({
    where: { organizationId, memberId },
    select: { roleId: true },
    take: 100,
  });
  return new Set(rows.map((row) => row.roleId));
}

function availability(row: CatalogTypeRow, roles: ReadonlySet<string>): AvailableType | null {
  const published = row.definition?.versions[0];
  if (published === undefined) return null;
  if (row.requesterRoles.length > 0 && !row.requesterRoles.some((item) => roles.has(item.roleId))) return null;
  return { row, publishedVersionId: published.id };
}

/**
 * A type the member may submit now: active, with a published workflow version, and (when the type
 * restricts requesters) holding one of its roles. Anything else is reported as absent. The reserved
 * attendance correction type (ADR-0022) is only reachable through the attendance module (
eserved).
 */
export async function loadAvailableType(
  db: TenantDb,
  organizationId: string,
  memberId: string,
  requestTypeId: string,
  options: { readonly reserved?: boolean } = {},
): Promise<AvailableType | null> {
  const row = await db.requestType.findFirst({
    where: {
      organizationId,
      id: requestTypeId,
      active: true,
      key: options.reserved === true ? ATTENDANCE_CORRECTION_TYPE_KEY : { not: ATTENDANCE_CORRECTION_TYPE_KEY },
    },
    select: catalogTypeSelect,
  });
  if (row === null) return null;
  return availability(row, await memberRoleIds(db, organizationId, memberId));
}

/** Every type the member may submit, by category and name. */
export async function availableTypes(db: TenantDb, organizationId: string, memberId: string): Promise<AvailableType[]> {
  const rows = await db.requestType.findMany({
    where: { organizationId, active: true, key: { not: ATTENDANCE_CORRECTION_TYPE_KEY } },
    orderBy: [{ category: 'asc' }, { key: 'asc' }],
    take: 200,
    select: catalogTypeSelect,
  });
  const roles = await memberRoleIds(db, organizationId, memberId);
  return rows.flatMap((row) => {
    const available = availability(row, roles);
    return available === null ? [] : [available];
  });
}

/** Normalized form data as a JSON column value. */
export function toFormJson(data: NormalizedData): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'object') out[key] = value;
    else if ('start' in value) out[key] = { start: value.start, end: value.end };
    else out[key] = [...value];
  }
  return out;
}
