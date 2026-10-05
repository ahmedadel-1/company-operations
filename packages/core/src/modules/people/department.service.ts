import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockOrganizationHierarchy } from '../../platform/db/sql/locks.js';
import { isInDepartmentSubtree } from '../../platform/db/sql/org-hierarchy.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';

/** Bounded organization-structure lists (departments, teams, job titles) are capped at this size. */
export const MAX_STRUCTURE_LIST = 500;

export interface DepartmentView {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly parentDepartmentId: string | null;
  readonly manager: { readonly id: string; readonly fullName: string } | null;
  readonly archived: boolean;
  readonly employeeCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DepartmentInput {
  readonly name?: string | undefined;
  readonly code?: string | undefined;
  readonly parentDepartmentId?: string | null | undefined;
  readonly managerId?: string | null | undefined;
}

const departmentSelect = {
  id: true,
  name: true,
  code: true,
  parentDepartmentId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  manager: { select: { id: true, fullName: true } },
  _count: { select: { profiles: true } },
} satisfies Prisma.DepartmentSelect;

type DepartmentRow = Prisma.DepartmentGetPayload<{ select: typeof departmentSelect }>;

const toView = (row: DepartmentRow): DepartmentView => ({
  id: row.id,
  name: row.name,
  code: row.code,
  parentDepartmentId: row.parentDepartmentId,
  manager: row.manager,
  archived: row.archivedAt !== null,
  employeeCount: row._count.profiles,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Departments (P1-12). Every member with `employee.view` may read the tree; changes need
 * `department.manage` in scope (ORG, or DEPARTMENT for departments in the member's reach; a new
 * department is in scope when its parent is). Parent changes are cycle-checked under the
 * organization's hierarchy lock. Departments are archived, never deleted.
 */
export class DepartmentService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(
    action: ActionContext,
    options: { includeArchived?: boolean | undefined } = {},
  ): Promise<DepartmentView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const rows = await this.db.department.findMany({
      where: { organizationId, ...(options.includeArchived === true ? {} : { archivedAt: null }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_STRUCTURE_LIST,
      select: departmentSelect,
    });
    return rows.map(toView);
  }

  async get(action: ActionContext, departmentId: string): Promise<DepartmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.load(this.db, organizationId, departmentId);
  }

  async create(
    action: ActionContext,
    input: DepartmentInput & { readonly name: string; readonly code: string },
  ): Promise<DepartmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const parentId = input.parentDepartmentId ?? null;
    this.assertManageable(action, organizationId, parentId === null ? [] : [parentId]);
    return this.write(async (tx) => {
      if (parentId !== null) {
        await this.load(tx, organizationId, parentId, { activeOnly: true });
      }
      await this.assertManager(tx, organizationId, input.managerId ?? null);
      const row = await tx.department.create({
        data: {
          organizationId,
          name: input.name,
          code: input.code,
          parentDepartmentId: parentId,
          managerProfileId: input.managerId ?? null,
        },
        select: { id: true, code: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'department.created',
        entityType: 'department',
        entityId: row.id,
        actor: userActor(action),
        metadata: { code: row.code, parentDepartmentId: parentId, managerId: input.managerId ?? null },
        context: action.request,
      });
      return this.load(tx, organizationId, row.id);
    });
  }

  async update(action: ActionContext, departmentId: string, input: DepartmentInput): Promise<DepartmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      if (input.parentDepartmentId !== undefined || input.managerId !== undefined) {
        await lockOrganizationHierarchy(tx, organizationId);
      }
      const current = await this.load(tx, organizationId, departmentId);
      this.assertManageable(action, organizationId, [current.id]);
      if (input.parentDepartmentId !== undefined && input.parentDepartmentId !== current.parentDepartmentId) {
        const parentId = input.parentDepartmentId;
        if (parentId !== null) {
          this.assertManageable(action, organizationId, [parentId]);
          await this.load(tx, organizationId, parentId, { activeOnly: true });
          if (await isInDepartmentSubtree(tx, organizationId, current.id, parentId)) {
            throw new InvalidInputError('parentDepartmentId', 'A department cannot be moved under itself.');
          }
        }
      }
      if (input.managerId !== undefined && input.managerId !== (current.manager?.id ?? null)) {
        await this.assertManager(tx, organizationId, input.managerId);
      }
      const data: Prisma.DepartmentUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code;
      if (input.parentDepartmentId !== undefined) data.parentDepartmentId = input.parentDepartmentId;
      if (input.managerId !== undefined) data.managerProfileId = input.managerId;
      const row = await tx.department.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data,
        select: departmentSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'department.updated',
        entityType: 'department',
        entityId: current.id,
        actor: userActor(action),
        metadata: {
          fields: Object.keys(data).sort(),
          ...(input.parentDepartmentId === undefined ? {} : { parentDepartmentId: input.parentDepartmentId }),
          ...(input.managerId === undefined ? {} : { managerId: input.managerId }),
        },
        context: action.request,
      });
      return toView(row);
    });
  }

  /** Archiving requires that no active child department remains; employees keep their link. */
  async setArchived(action: ActionContext, departmentId: string, archived: boolean): Promise<DepartmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      await lockOrganizationHierarchy(tx, organizationId);
      const current = await this.load(tx, organizationId, departmentId);
      this.assertManageable(action, organizationId, [current.id]);
      if (archived === current.archived) {
        return current;
      }
      if (archived) {
        const activeChildren = await tx.department.count({
          where: { organizationId, parentDepartmentId: current.id, archivedAt: null },
        });
        if (activeChildren > 0) {
          throw new InvalidTransitionError('Archive or move the child departments first.');
        }
      } else if (current.parentDepartmentId !== null) {
        await this.load(tx, organizationId, current.parentDepartmentId, { activeOnly: true });
      }
      const row = await tx.department.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data: { archivedAt: archived ? new Date() : null },
        select: departmentSelect,
      });
      await recordAudit(tx, organizationId, {
        action: archived ? 'department.archived' : 'department.unarchived',
        entityType: 'department',
        entityId: current.id,
        actor: userActor(action),
        context: action.request,
      });
      return toView(row);
    });
  }

  private assertManageable(action: ActionContext, organizationId: string, departmentIds: string[]): void {
    if (!canAccessResource(action.principal, 'department.manage', { organizationId, departmentIds })) {
      throw new ForbiddenError();
    }
  }

  private async load(
    db: TenantDb,
    organizationId: string,
    departmentId: string,
    options: { activeOnly?: boolean } = {},
  ): Promise<DepartmentView> {
    const row = await db.department.findFirst({
      where: { organizationId, id: departmentId, ...(options.activeOnly === true ? { archivedAt: null } : {}) },
      select: departmentSelect,
    });
    if (row === null) {
      throw new NotFoundError('Department');
    }
    return toView(row);
  }

  private async assertManager(db: TenantDb, organizationId: string, managerId: string | null): Promise<void> {
    if (managerId === null) {
      return;
    }
    const profile = await db.employeeProfile.findFirst({
      where: { organizationId, id: managerId },
      select: { id: true },
    });
    if (profile === null) {
      throw new NotFoundError('Manager');
    }
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A department with this code already exists.');
      }
      throw error;
    }
  }
}
