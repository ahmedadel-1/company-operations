import type { MemberStatus } from '@company-ops/db';

import { activeOrganizationId } from '../../platform/tenancy/tenant-guard.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';

export interface MemberView {
  readonly id: string;
  readonly status: MemberStatus;
  readonly roleKeys: readonly string[];
}

export interface MemberListFilter {
  readonly status?: MemberStatus | undefined;
}

/**
 * Tenant-scoped repository (ADR-0003 layer 1): every query is bound to the active organization;
 * single-row reads use (id, organizationId) so foreign ids behave as non-existent.
 */
export class MemberRepository {
  constructor(
    private readonly db: TenantDb,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async findById(memberId: string): Promise<MemberView | null> {
    const organizationId = activeOrganizationId(this.tenant);
    const row = await this.db.organizationMember.findFirst({
      where: { id: memberId, organizationId },
      select: { id: true, status: true, roles: { select: { role: { select: { key: true } } } } },
    });
    return row === null ? null : { id: row.id, status: row.status, roleKeys: row.roles.map((r) => r.role.key).sort() };
  }

  /** The filter type has no organization field; the active organization is always applied last. */
  async list(filter: MemberListFilter = {}): Promise<{ id: string; status: MemberStatus }[]> {
    const organizationId = activeOrganizationId(this.tenant);
    return this.db.organizationMember.findMany({
      where: { ...(filter.status === undefined ? {} : { status: filter.status }), organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true },
      take: 100,
    });
  }
}
