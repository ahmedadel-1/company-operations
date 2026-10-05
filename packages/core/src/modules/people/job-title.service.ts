import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { MAX_STRUCTURE_LIST } from './department.service.js';

export interface JobTitleView {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const select = { id: true, name: true, archivedAt: true, createdAt: true, updatedAt: true } as const;

const toView = (row: { id: string; name: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date }) => ({
  id: row.id,
  name: row.name,
  archived: row.archivedAt !== null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Job titles (P1-12): an organization-wide taxonomy, so changes need `department.manage` at ORG
 * scope (a resource without department facts matches only ORG). Archived, never deleted.
 */
export class JobTitleService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, options: { includeArchived?: boolean | undefined } = {}): Promise<JobTitleView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const rows = await this.db.jobTitle.findMany({
      where: { organizationId, ...(options.includeArchived === true ? {} : { archivedAt: null }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_STRUCTURE_LIST,
      select,
    });
    return rows.map(toView);
  }

  async create(action: ActionContext, name: string): Promise<JobTitleView> {
    const organizationId = this.assertManageable(action);
    return this.write(async (tx) => {
      const row = await tx.jobTitle.create({ data: { organizationId, name }, select });
      await recordAudit(tx, organizationId, {
        action: 'job_title.created',
        entityType: 'job_title',
        entityId: row.id,
        actor: userActor(action),
        context: action.request,
      });
      return toView(row);
    });
  }

  async update(
    action: ActionContext,
    jobTitleId: string,
    input: { name?: string | undefined; archived?: boolean | undefined },
  ): Promise<JobTitleView> {
    const organizationId = this.assertManageable(action);
    return this.write(async (tx) => {
      const current = await tx.jobTitle.findFirst({ where: { organizationId, id: jobTitleId }, select });
      if (current === null) {
        throw new NotFoundError('Job title');
      }
      const row = await tx.jobTitle.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.archived === undefined
            ? {}
            : { archivedAt: input.archived ? (current.archivedAt ?? new Date()) : null }),
        },
        select,
      });
      await recordAudit(tx, organizationId, {
        action: 'job_title.updated',
        entityType: 'job_title',
        entityId: current.id,
        actor: userActor(action),
        metadata: { fields: Object.keys(input).sort() },
        context: action.request,
      });
      return toView(row);
    });
  }

  private assertManageable(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!canAccessResource(action.principal, 'department.manage', { organizationId })) {
      throw new ForbiddenError();
    }
    return organizationId;
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A job title with this name already exists.');
      }
      throw error;
    }
  }
}
