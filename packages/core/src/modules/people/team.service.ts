import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { MAX_STRUCTURE_LIST } from './department.service.js';

export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly department: { readonly id: string; readonly name: string } | null;
  readonly lead: { readonly id: string; readonly fullName: string } | null;
  readonly archived: boolean;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamMemberView {
  readonly employeeId: string;
  readonly fullName: string;
  readonly employeeNumber: string;
  readonly addedAt: string;
}

export interface TeamInput {
  readonly name?: string | undefined;
  readonly departmentId?: string | null | undefined;
  readonly leadId?: string | null | undefined;
}

const teamSelect = {
  id: true,
  name: true,
  departmentId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { id: true, name: true } },
  lead: { select: { id: true, fullName: true } },
  _count: { select: { members: true } },
} satisfies Prisma.TeamSelect;

type TeamRow = Prisma.TeamGetPayload<{ select: typeof teamSelect }>;

const toView = (row: TeamRow): TeamView => ({
  id: row.id,
  name: row.name,
  department: row.department,
  lead: row.lead,
  archived: row.archivedAt !== null,
  memberCount: row._count.members,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Teams and team membership (P1-12). Readable by every member with `employee.view`; changes need
 * `department.manage` in scope for the team's department (both the current and the new one).
 * Team leads gain TEAM scope over the team's members (SECURITY §2.1). Membership changes are
 * audited; foreign or unknown employee ids are 404 and nothing is linked.
 */
export class TeamService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, options: { includeArchived?: boolean | undefined } = {}): Promise<TeamView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const rows = await this.db.team.findMany({
      where: { organizationId, ...(options.includeArchived === true ? {} : { archivedAt: null }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_STRUCTURE_LIST,
      select: teamSelect,
    });
    return rows.map(toView);
  }

  async get(action: ActionContext, teamId: string): Promise<TeamView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return toView(await this.load(this.db, organizationId, teamId));
  }

  async listMembers(action: ActionContext, teamId: string): Promise<TeamMemberView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.load(this.db, organizationId, teamId);
    const rows = await this.db.teamMember.findMany({
      where: { organizationId, teamId },
      orderBy: [{ profile: { fullName: 'asc' } }, { id: 'asc' }],
      take: MAX_STRUCTURE_LIST,
      select: { createdAt: true, profile: { select: { id: true, fullName: true, employeeNumber: true } } },
    });
    return rows.map((row) => ({
      employeeId: row.profile.id,
      fullName: row.profile.fullName,
      employeeNumber: row.profile.employeeNumber,
      addedAt: row.createdAt.toISOString(),
    }));
  }

  async create(action: ActionContext, input: TeamInput & { name: string }): Promise<TeamView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const departmentId = input.departmentId ?? null;
    this.assertManageable(action, organizationId, departmentId);
    return this.write(async (tx) => {
      await this.assertReferences(tx, organizationId, departmentId, input.leadId ?? null);
      const row = await tx.team.create({
        data: { organizationId, name: input.name, departmentId, leadProfileId: input.leadId ?? null },
        select: teamSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'team.created',
        entityType: 'team',
        entityId: row.id,
        actor: userActor(action),
        metadata: { departmentId, leadId: input.leadId ?? null },
        context: action.request,
      });
      return toView(row);
    });
  }

  async update(action: ActionContext, teamId: string, input: TeamInput): Promise<TeamView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const current = await this.load(tx, organizationId, teamId);
      this.assertManageable(action, organizationId, current.departmentId);
      if (input.departmentId !== undefined && input.departmentId !== current.departmentId) {
        this.assertManageable(action, organizationId, input.departmentId);
        await this.assertReferences(tx, organizationId, input.departmentId, null);
      }
      if (input.leadId !== undefined && input.leadId !== (current.lead?.id ?? null)) {
        await this.assertReferences(tx, organizationId, null, input.leadId);
      }
      const data: Prisma.TeamUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.departmentId !== undefined) data.departmentId = input.departmentId;
      if (input.leadId !== undefined) data.leadProfileId = input.leadId;
      const row = await tx.team.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data,
        select: teamSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'team.updated',
        entityType: 'team',
        entityId: current.id,
        actor: userActor(action),
        metadata: {
          fields: Object.keys(data).sort(),
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
          ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
        },
        context: action.request,
      });
      return toView(row);
    });
  }

  async setArchived(action: ActionContext, teamId: string, archived: boolean): Promise<TeamView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const current = await this.load(tx, organizationId, teamId);
      this.assertManageable(action, organizationId, current.departmentId);
      if ((current.archivedAt !== null) === archived) {
        return toView(current);
      }
      const row = await tx.team.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data: { archivedAt: archived ? new Date() : null },
        select: teamSelect,
      });
      await recordAudit(tx, organizationId, {
        action: archived ? 'team.archived' : 'team.unarchived',
        entityType: 'team',
        entityId: current.id,
        actor: userActor(action),
        context: action.request,
      });
      return toView(row);
    });
  }

  async addMember(action: ActionContext, teamId: string, employeeId: string): Promise<{ created: boolean }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.write(async (tx) => {
      const team = await this.load(tx, organizationId, teamId);
      this.assertManageable(action, organizationId, team.departmentId);
      const profile = await tx.employeeProfile.findFirst({
        where: { organizationId, id: employeeId },
        select: { id: true },
      });
      if (profile === null) {
        throw new NotFoundError('Employee');
      }
      const existing = await tx.teamMember.findFirst({
        where: { organizationId, teamId: team.id, profileId: profile.id },
        select: { id: true },
      });
      if (existing !== null) {
        return { created: false };
      }
      await tx.teamMember.create({
        data: { organizationId, teamId: team.id, profileId: profile.id },
        select: { id: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'team.member_added',
        entityType: 'team',
        entityId: team.id,
        actor: userActor(action),
        metadata: { employeeId: profile.id },
        context: action.request,
      });
      return { created: true };
    });
  }

  async removeMember(action: ActionContext, teamId: string, employeeId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.write(async (tx) => {
      const team = await this.load(tx, organizationId, teamId);
      this.assertManageable(action, organizationId, team.departmentId);
      const removed = await tx.teamMember.deleteMany({
        where: { organizationId, teamId: team.id, profileId: employeeId },
      });
      if (removed.count === 0) {
        throw new NotFoundError('Team member');
      }
      await recordAudit(tx, organizationId, {
        action: 'team.member_removed',
        entityType: 'team',
        entityId: team.id,
        actor: userActor(action),
        metadata: { employeeId },
        context: action.request,
      });
    });
  }

  private assertManageable(action: ActionContext, organizationId: string, departmentId: string | null): void {
    if (
      !canAccessResource(action.principal, 'department.manage', {
        organizationId,
        departmentIds: departmentId === null ? [] : [departmentId],
      })
    ) {
      throw new ForbiddenError();
    }
  }

  private async load(db: TenantDb, organizationId: string, teamId: string): Promise<TeamRow> {
    const row = await db.team.findFirst({ where: { organizationId, id: teamId }, select: teamSelect });
    if (row === null) {
      throw new NotFoundError('Team');
    }
    return row;
  }

  private async assertReferences(
    db: TenantDb,
    organizationId: string,
    departmentId: string | null,
    leadId: string | null,
  ): Promise<void> {
    if (departmentId !== null) {
      const department = await db.department.findFirst({
        where: { organizationId, id: departmentId, archivedAt: null },
        select: { id: true },
      });
      if (department === null) {
        throw new NotFoundError('Department');
      }
    }
    if (leadId !== null) {
      const lead = await db.employeeProfile.findFirst({ where: { organizationId, id: leadId }, select: { id: true } });
      if (lead === null) {
        throw new NotFoundError('Team lead');
      }
    }
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A team with this name already exists.');
      }
      throw error;
    }
  }
}
