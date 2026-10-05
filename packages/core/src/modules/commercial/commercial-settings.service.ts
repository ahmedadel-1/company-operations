import type { UpdateCommercialSettingsRequest } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, VersionConflictError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { DEFAULT_REMINDER_DAYS } from './engine/dates.js';
import type { ReminderSetting } from './engine/dates.js';

export type ReminderSettings = Readonly<Record<ReminderSetting, readonly number[]>>;

export interface CommercialSettingsView extends ReminderSettings {
  /** 0 while the organization uses the code defaults (no row yet). */
  readonly version: number;
}

const SETTINGS: readonly ReminderSetting[] = [
  'documentReminderDays',
  'contractReminderDays',
  'guaranteeReminderDays',
  'obligationReminderDays',
  'tenderReminderDays',
];

const normalized = (days: readonly number[]): number[] => [...new Set(days)].sort((a, b) => b - a);

/** Reminder thresholds of an organization (the defaults until it saves its own). */
export async function loadReminderSettings(db: TenantDb, organizationId: string): Promise<CommercialSettingsView> {
  const row = await db.commercialSettings.findFirst({ where: { organizationId } });
  if (row === null) return { ...DEFAULT_REMINDER_DAYS, version: 0 };
  return {
    documentReminderDays: row.documentReminderDays,
    contractReminderDays: row.contractReminderDays,
    guaranteeReminderDays: row.guaranteeReminderDays,
    obligationReminderDays: row.obligationReminderDays,
    tenderReminderDays: row.tenderReminderDays,
    version: row.version,
  };
}

/**
 * Commercial reminder thresholds (spec §54, ADR-0026). Readable by anyone working with commercial
 * records; changed with `org.settings.manage` at organization scope, optimistic on `version`
 * (0 = still on the defaults), audited with before/after values.
 */
export class CommercialSettingsService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async get(action: ActionContext): Promise<CommercialSettingsView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const permissions = action.principal.permissions;
    if (
      !hasPermission(permissions, 'tender.view') &&
      !hasPermission(permissions, 'contract.view') &&
      !hasPermission(permissions, 'corporate_document.manage') &&
      !holdsOrgWide(action.principal, 'org.settings.manage')
    ) {
      throw new ForbiddenError();
    }
    return loadReminderSettings(this.db, organizationId);
  }

  async update(action: ActionContext, input: UpdateCommercialSettingsRequest): Promise<CommercialSettingsView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'org.settings.manage')) throw new ForbiddenError();
    await this.db.$transaction(async (tx) => {
      const before = await loadReminderSettings(tx, organizationId);
      if (before.version !== input.version) throw new VersionConflictError('Commercial settings');
      const after: Record<ReminderSetting, number[]> = {
        documentReminderDays: normalized(input.documentReminderDays ?? before.documentReminderDays),
        contractReminderDays: normalized(input.contractReminderDays ?? before.contractReminderDays),
        guaranteeReminderDays: normalized(input.guaranteeReminderDays ?? before.guaranteeReminderDays),
        obligationReminderDays: normalized(input.obligationReminderDays ?? before.obligationReminderDays),
        tenderReminderDays: normalized(input.tenderReminderDays ?? before.tenderReminderDays),
      };
      if (before.version === 0) {
        try {
          await tx.commercialSettings.create({
            data: { organizationId, ...after, updatedByMemberId: action.principal.memberId },
            select: { id: true },
          });
        } catch (error) {
          if (isUniqueViolation(error))
            throw new ConflictError('The settings were saved at the same time. Reload and try again.');
          throw error;
        }
      } else {
        const updated = await tx.commercialSettings.updateMany({
          where: { organizationId, version: input.version },
          data: { ...after, updatedByMemberId: action.principal.memberId, version: { increment: 1 } },
        });
        if (updated.count === 0) throw new VersionConflictError('Commercial settings');
      }
      await recordAudit(tx, organizationId, {
        action: 'commercial.settings_updated',
        entityType: 'commercial_settings',
        entityId: null,
        actor: userActor(action),
        metadata: {
          before: Object.fromEntries(SETTINGS.map((key) => [key, [...before[key]]])),
          after,
        },
        context: action.request,
      });
    });
    return loadReminderSettings(this.db, organizationId);
  }
}
