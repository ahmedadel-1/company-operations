import type { CustomerType, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission, scopesFor } from '../authorization/effective-permissions.js';
import { holdsOrgWide } from './project-access.js';

export interface CustomerView {
  readonly id: string;
  readonly name: string;
  readonly type: CustomerType;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly notes: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerInput {
  readonly name?: string | undefined;
  readonly type?: CustomerType | undefined;
  readonly contactName?: string | null | undefined;
  readonly contactEmail?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly archived?: boolean | undefined;
}

export interface CustomerListFilter {
  readonly q?: string | undefined;
  readonly type?: CustomerType | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const customerSelect = {
  id: true,
  name: true,
  type: true,
  contactName: true,
  contactEmail: true,
  notes: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerSelect }>;

const toView = (row: CustomerRow): CustomerView => ({
  id: row.id,
  name: row.name,
  type: row.type,
  contactName: row.contactName,
  contactEmail: row.contactEmail,
  notes: row.notes,
  archived: row.archivedAt !== null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Customers (P2-1): a lightweight directory of who projects are delivered for, not a CRM. Readable
 * by project administrators (`project.create` or `project.manage` at any scope, or `project.view` at
 * ORG) so they can pick a customer; created, edited and archived with `project.create` at ORG scope
 * (SECURITY §2.4). Customers are archived, never deleted; archived customers cannot be assigned to
 * projects but stay on the projects that already reference them.
 */
export class CustomerService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, filter: CustomerListFilter): Promise<Page<CustomerView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanRead(action);
    const size = pageSize(filter.limit);
    const and: Prisma.CustomerWhereInput[] = [];
    if (filter.includeArchived !== true) {
      and.push({ archivedAt: null });
    }
    if (filter.type !== undefined) {
      and.push({ type: filter.type });
    }
    if (filter.q !== undefined && filter.q.trim() !== '') {
      and.push({ name: { contains: filter.q.trim(), mode: 'insensitive' } });
    }
    if (filter.cursor !== undefined) {
      const [name = '', id = ''] = decodeCursor(filter.cursor, 2);
      and.push({ OR: [{ name: { gt: name } }, { name, id: { gt: id } }] });
    }
    const rows = await this.db.customer.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: customerSelect,
    });
    const page = toPage(rows, size, (row) => [row.name, row.id]);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, customerId: string): Promise<CustomerView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanRead(action);
    return toView(await this.load(this.db, organizationId, customerId));
  }

  async create(
    action: ActionContext,
    input: CustomerInput & { name: string; type: CustomerType },
  ): Promise<CustomerView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanManage(action);
    return this.write(async (tx) => {
      const row = await tx.customer.create({
        data: {
          organizationId,
          name: input.name,
          type: input.type,
          contactName: input.contactName ?? null,
          contactEmail: input.contactEmail ?? null,
          notes: input.notes ?? null,
        },
        select: customerSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'customer.created',
        entityType: 'customer',
        entityId: row.id,
        actor: userActor(action),
        metadata: { type: row.type },
        context: action.request,
      });
      return toView(row);
    });
  }

  async update(action: ActionContext, customerId: string, input: CustomerInput): Promise<CustomerView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanManage(action);
    return this.write(async (tx) => {
      const current = await this.load(tx, organizationId, customerId);
      const data: Prisma.CustomerUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.type !== undefined) data.type = input.type;
      if (input.contactName !== undefined) data.contactName = input.contactName;
      if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail;
      if (input.notes !== undefined) data.notes = input.notes;
      const archive = input.archived ?? current.archivedAt !== null;
      const archiving = archive !== (current.archivedAt !== null);
      if (archiving) data.archivedAt = archive ? new Date() : null;
      if (Object.keys(data).length === 0) {
        return toView(current);
      }
      const row = await tx.customer.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data,
        select: customerSelect,
      });
      await recordAudit(tx, organizationId, {
        action: archiving ? (archive ? 'customer.archived' : 'customer.unarchived') : 'customer.updated',
        entityType: 'customer',
        entityId: current.id,
        actor: userActor(action),
        metadata: { fields: Object.keys(data).sort() },
        context: action.request,
      });
      return toView(row);
    });
  }

  private assertCanRead(action: ActionContext): void {
    const permissions = action.principal.permissions;
    const allowed =
      hasPermission(permissions, 'project.create') ||
      hasPermission(permissions, 'project.manage') ||
      scopesFor(permissions, 'project.view').includes('ORG');
    if (!allowed) {
      throw new ForbiddenError();
    }
  }

  private assertCanManage(action: ActionContext): void {
    if (!holdsOrgWide(action.principal, 'project.create')) {
      throw new ForbiddenError();
    }
  }

  private async load(db: TenantDb, organizationId: string, customerId: string): Promise<CustomerRow> {
    const row = await db.customer.findFirst({ where: { organizationId, id: customerId }, select: customerSelect });
    if (row === null) {
      throw new NotFoundError('Customer');
    }
    return row;
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A customer with this name already exists.');
      }
      throw error;
    }
  }
}
