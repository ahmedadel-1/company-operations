import type { Prisma, WorkLocationType } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { isValidTimeZone } from '../organizations/provision-organization.js';
import { assertNotArchived, assertProjectPermission, holdsOrgWide, loadVisibleProject } from './project-access.js';
import { recordProjectActivity } from './project-activity.js';

/** Geofence facts recorded on every location change (ADR-0022): attendance evidence depends on them. */
function geofenceAudit(row: {
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  allowedRadiusMeters: number;
  active: boolean;
}): Record<string, number | boolean> {
  return {
    latitude: row.latitude.toNumber(),
    longitude: row.longitude.toNumber(),
    allowedRadiusMeters: row.allowedRadiusMeters,
    active: row.active,
  };
}

export interface WorkLocationView {
  readonly id: string;
  readonly name: string;
  readonly type: WorkLocationType;
  readonly latitude: number;
  readonly longitude: number;
  readonly allowedRadiusMeters: number;
  readonly address: string | null;
  readonly timeZone: string | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkLocationInput {
  readonly name?: string | undefined;
  readonly type?: WorkLocationType | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly allowedRadiusMeters?: number | undefined;
  readonly address?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  readonly active?: boolean | undefined;
}

export interface ProjectLocationView {
  readonly location: WorkLocationView;
  readonly linkedAt: string;
}

const MAX_LOCATIONS = 500;

const locationSelect = {
  id: true,
  name: true,
  type: true,
  latitude: true,
  longitude: true,
  allowedRadiusMeters: true,
  address: true,
  timeZone: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkLocationSelect;

type LocationRow = Prisma.WorkLocationGetPayload<{ select: typeof locationSelect }>;

const toView = (row: LocationRow): WorkLocationView => ({
  id: row.id,
  name: row.name,
  type: row.type,
  latitude: row.latitude.toNumber(),
  longitude: row.longitude.toNumber(),
  allowedRadiusMeters: row.allowedRadiusMeters,
  address: row.address,
  timeZone: row.timeZone,
  active: row.active,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Work locations (P2-5): named places with a geofence (center + radius) that projects link to and
 * that attendance (Phase 7) reuses unchanged. Managed with `attendance.config` at ORG scope;
 * readable by location administrators and project administrators so they can link them. Locations
 * are deactivated, never deleted; inactive locations stay on the projects that already link them.
 */
export class WorkLocationService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(
    action: ActionContext,
    filter: { includeInactive?: boolean | undefined; q?: string | undefined },
  ): Promise<WorkLocationView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const permissions = action.principal.permissions;
    if (
      !hasPermission(permissions, 'attendance.config') &&
      !hasPermission(permissions, 'project.manage') &&
      !hasPermission(permissions, 'project.create')
    ) {
      throw new ForbiddenError();
    }
    const rows = await this.db.workLocation.findMany({
      where: {
        organizationId,
        ...(filter.includeInactive === true ? {} : { active: true }),
        ...(filter.q === undefined || filter.q.trim() === ''
          ? {}
          : { name: { contains: filter.q.trim(), mode: 'insensitive' } }),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_LOCATIONS,
      select: locationSelect,
    });
    return rows.map(toView);
  }

  async create(
    action: ActionContext,
    input: WorkLocationInput & {
      name: string;
      type: WorkLocationType;
      latitude: number;
      longitude: number;
      allowedRadiusMeters: number;
    },
  ): Promise<WorkLocationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanManage(action);
    assertTimeZone(input.timeZone ?? null);
    return this.write(async (tx) => {
      const row = await tx.workLocation.create({
        data: {
          organizationId,
          name: input.name,
          type: input.type,
          latitude: input.latitude,
          longitude: input.longitude,
          allowedRadiusMeters: input.allowedRadiusMeters,
          address: input.address ?? null,
          timeZone: input.timeZone ?? null,
          active: input.active ?? true,
        },
        select: locationSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'work_location.created',
        entityType: 'work_location',
        entityId: row.id,
        actor: userActor(action),
        metadata: { type: row.type, allowedRadiusMeters: row.allowedRadiusMeters, after: geofenceAudit(row) },
        context: action.request,
      });
      return toView(row);
    });
  }

  async update(action: ActionContext, locationId: string, input: WorkLocationInput): Promise<WorkLocationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    this.assertCanManage(action);
    assertTimeZone(input.timeZone ?? null);
    return this.write(async (tx) => {
      const current = await loadLocation(tx, organizationId, locationId);
      const data: Prisma.WorkLocationUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.type !== undefined) data.type = input.type;
      if (input.latitude !== undefined) data.latitude = input.latitude;
      if (input.longitude !== undefined) data.longitude = input.longitude;
      if (input.allowedRadiusMeters !== undefined) data.allowedRadiusMeters = input.allowedRadiusMeters;
      if (input.address !== undefined) data.address = input.address;
      if (input.timeZone !== undefined) data.timeZone = input.timeZone;
      if (input.active !== undefined) data.active = input.active;
      if (Object.keys(data).length === 0) {
        return toView(current);
      }
      const row = await tx.workLocation.update({
        where: { organizationId_id: { organizationId, id: current.id } },
        data,
        select: locationSelect,
      });
      const active = input.active ?? current.active;
      await recordAudit(tx, organizationId, {
        action:
          active !== current.active
            ? active
              ? 'work_location.activated'
              : 'work_location.deactivated'
            : 'work_location.updated',
        entityType: 'work_location',
        entityId: current.id,
        actor: userActor(action),
        metadata: { fields: Object.keys(data).sort(), before: geofenceAudit(current), after: geofenceAudit(row) },
        context: action.request,
      });
      return toView(row);
    });
  }

  private assertCanManage(action: ActionContext): void {
    if (!holdsOrgWide(action.principal, 'attendance.config')) {
      throw new ForbiddenError();
    }
  }

  private async write<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A work location with this name already exists.');
      }
      throw error;
    }
  }
}

/**
 * Locations linked to a project. Listing needs the project to be visible; linking and unlinking
 * need `project.manage` on the project. Only active locations can be newly linked.
 */
export class ProjectLocationService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, projectId: string): Promise<ProjectLocationView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    const rows = await this.db.projectLocation.findMany({
      where: { organizationId, projectId: project.id },
      orderBy: [{ workLocation: { name: 'asc' } }, { id: 'asc' }],
      take: MAX_LOCATIONS,
      select: { createdAt: true, workLocation: { select: locationSelect } },
    });
    return rows.map((row) => ({ location: toView(row.workLocation), linkedAt: row.createdAt.toISOString() }));
  }

  async link(action: ActionContext, projectId: string, locationId: string): Promise<ProjectLocationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    try {
      return await this.db.$transaction(async (tx) => {
        const project = await loadVisibleProject(tx, action, organizationId, projectId);
        assertProjectPermission(action, 'project.manage', project);
        assertNotArchived(project);
        const location = await loadLocation(tx, organizationId, locationId);
        if (!location.active) {
          throw new InvalidInputError('workLocationId', 'Inactive locations cannot be linked to projects.');
        }
        const row = await tx.projectLocation.create({
          data: {
            organizationId,
            projectId: project.id,
            workLocationId: location.id,
            addedByMemberId: action.principal.memberId,
          },
          select: { createdAt: true },
        });
        await recordAudit(tx, organizationId, {
          action: 'project.location_linked',
          entityType: 'project',
          entityId: project.id,
          actor: userActor(action),
          metadata: { workLocationId: location.id },
          context: action.request,
        });
        await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
          source: 'PROJECT',
          type: 'project.location_linked',
          entityType: 'work_location',
          entityId: location.id,
          summaryParams: { locationName: location.name },
        });
        return { location: toView(location), linkedAt: row.createdAt.toISOString() };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('The location is already linked to this project.');
      }
      throw error;
    }
  }

  async unlink(action: ActionContext, projectId: string, locationId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      assertProjectPermission(action, 'project.manage', project);
      assertNotArchived(project);
      const link = await tx.projectLocation.findFirst({
        where: { organizationId, projectId: project.id, workLocationId: locationId },
        select: { id: true, workLocation: { select: { name: true } } },
      });
      if (link === null) {
        throw new NotFoundError('Project location');
      }
      await tx.projectLocation.deleteMany({ where: { organizationId, id: link.id } });
      await recordAudit(tx, organizationId, {
        action: 'project.location_unlinked',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { workLocationId: locationId },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.location_unlinked',
        entityType: 'work_location',
        entityId: locationId,
        summaryParams: { locationName: link.workLocation.name },
      });
    });
  }
}

async function loadLocation(db: TenantDb, organizationId: string, locationId: string): Promise<LocationRow> {
  const row = await db.workLocation.findFirst({ where: { organizationId, id: locationId }, select: locationSelect });
  if (row === null) {
    throw new NotFoundError('Work location');
  }
  return row;
}

function assertTimeZone(timeZone: string | null): void {
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    throw new InvalidInputError('timeZone', 'Unknown time zone.');
  }
}
