import { recordAudit } from '../../platform/audit/audit-writer.js';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { isValidTimeZone } from './provision-organization.js';

export interface OrganizationView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timeZone: string;
  readonly workWeek: readonly number[];
  readonly defaultLocale: 'en' | 'ar';
  readonly status: 'ACTIVE' | 'SUSPENDED';
}

export interface OrganizationChanges {
  readonly name?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly workWeek?: readonly number[] | undefined;
  readonly defaultLocale?: 'en' | 'ar' | undefined;
}

const select = {
  id: true,
  slug: true,
  name: true,
  timeZone: true,
  workWeek: true,
  defaultLocale: true,
  status: true,
} as const;

const toView = (row: {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  workWeek: number[];
  defaultLocale: string;
  status: 'ACTIVE' | 'SUSPENDED';
}): OrganizationView => ({
  ...row,
  defaultLocale: row.defaultLocale === 'ar' ? 'ar' : 'en',
  workWeek: [...row.workWeek],
});

/**
 * The active organization's settings (P1-12). Every member may read them (time zone and work week
 * drive the UI); changes need `org.settings.manage` (privileged, MFA via the route guard). Time
 * zone and work week stay required: they can be changed but never cleared (DATA_MODEL §3).
 */
export class OrganizationSettingsService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async get(action: ActionContext): Promise<OrganizationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.organization.findUnique({ where: { id: organizationId }, select });
    if (row === null) {
      throw new NotFoundError('Organization');
    }
    return toView(row);
  }

  async update(action: ActionContext, changes: OrganizationChanges): Promise<OrganizationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!canAccessResource(action.principal, 'org.settings.manage', { organizationId })) {
      throw new ForbiddenError();
    }
    if (changes.timeZone !== undefined && !isValidTimeZone(changes.timeZone)) {
      throw new InvalidInputError('timeZone', 'The time zone is not a valid IANA time zone.');
    }
    if (
      changes.workWeek !== undefined &&
      (changes.workWeek.length === 0 || changes.workWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7))
    ) {
      throw new InvalidInputError('workWeek', 'The work week must list ISO weekdays (1-7).');
    }
    return this.db.$transaction(async (tx) => {
      const row = await tx.organization.update({
        where: { id: organizationId },
        data: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.timeZone === undefined ? {} : { timeZone: changes.timeZone }),
          ...(changes.workWeek === undefined ? {} : { workWeek: [...new Set(changes.workWeek)].sort() }),
          ...(changes.defaultLocale === undefined ? {} : { defaultLocale: changes.defaultLocale }),
        },
        select,
      });
      await recordAudit(tx, organizationId, {
        action: 'organization.settings.updated',
        entityType: 'organization',
        entityId: organizationId,
        actor: userActor(action),
        metadata: { ...changes, fields: Object.keys(changes).sort() },
        context: action.request,
      });
      return toView(row);
    });
  }
}
