import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, ForbiddenError, VersionConflictError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { loadPolicy } from './attendance-store.js';

export interface AttendancePolicyView {
  readonly configured: boolean;
  readonly maxAccuracyMeters: number | null;
  readonly lowAccuracyAction: 'FLAG_FOR_REVIEW' | 'REJECT' | null;
  readonly missingLocationAction: 'FLAG_FOR_REVIEW' | 'REJECT' | null;
  readonly missingCheckoutAfterMinutes: number | null;
  readonly version: number | null;
  readonly updatedAt: string | null;
}

export interface SetAttendancePolicyInput {
  readonly maxAccuracyMeters: number;
  readonly lowAccuracyAction: 'FLAG_FOR_REVIEW' | 'REJECT';
  readonly missingLocationAction: 'FLAG_FOR_REVIEW' | 'REJECT';
  readonly missingCheckoutAfterMinutes: number;
  readonly version: number | null;
}

/**
 * The organization's location accuracy policy (ADR-0022, SECURITY §9). There is no code default: until
 * it is saved, location check-ins are refused. Read with `attendance.config` or `org.settings.manage`;
 * changed with `org.settings.manage` (privileged, fresh MFA at the controller); every change is audited.
 */
export class AttendancePolicyService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async get(action: ActionContext): Promise<AttendancePolicyView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (
      !holdsOrgWide(action.principal, 'attendance.config') &&
      !holdsOrgWide(action.principal, 'org.settings.manage')
    ) {
      throw new ForbiddenError();
    }
    return this.view(organizationId);
  }

  async set(action: ActionContext, input: SetAttendancePolicyInput): Promise<AttendancePolicyView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'org.settings.manage')) {
      throw new ForbiddenError();
    }
    await this.db.$transaction(async (tx) => {
      const existing = await loadPolicy(tx, organizationId);
      const values = {
        maxAccuracyMeters: input.maxAccuracyMeters,
        lowAccuracyAction: input.lowAccuracyAction,
        missingLocationAction: input.missingLocationAction,
        missingCheckoutAfterMinutes: input.missingCheckoutAfterMinutes,
        configuredByMemberId: action.principal.memberId,
      };
      if (existing === null) {
        if (input.version !== null) throw new VersionConflictError('Attendance policy');
        try {
          await tx.attendancePolicy.create({ data: { organizationId, ...values }, select: { id: true } });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictError('The policy was created at the same time. Reload and try again.');
          }
          throw error;
        }
      } else {
        const updated = await tx.attendancePolicy.updateMany({
          where: { organizationId, id: existing.id, version: input.version ?? -1 },
          data: { ...values, version: { increment: 1 } },
        });
        if (updated.count === 0) throw new VersionConflictError('Attendance policy');
      }
      await recordAudit(tx, organizationId, {
        action: existing === null ? 'attendance.policy.created' : 'attendance.policy.updated',
        entityType: 'attendance_policy',
        entityId: existing?.id ?? null,
        actor: userActor(action),
        metadata: {
          after: {
            maxAccuracyMeters: input.maxAccuracyMeters,
            lowAccuracyAction: input.lowAccuracyAction,
            missingLocationAction: input.missingLocationAction,
            missingCheckoutAfterMinutes: input.missingCheckoutAfterMinutes,
          },
          before:
            existing === null
              ? null
              : {
                  maxAccuracyMeters: existing.maxAccuracyMeters,
                  lowAccuracyAction: existing.lowAccuracyAction,
                  missingLocationAction: existing.missingLocationAction,
                  missingCheckoutAfterMinutes: existing.missingCheckoutAfterMinutes,
                },
        },
        context: action.request,
      });
    });
    return this.view(organizationId);
  }

  private async view(organizationId: string): Promise<AttendancePolicyView> {
    const policy = await loadPolicy(this.db, organizationId);
    if (policy === null) {
      return {
        configured: false,
        maxAccuracyMeters: null,
        lowAccuracyAction: null,
        missingLocationAction: null,
        missingCheckoutAfterMinutes: null,
        version: null,
        updatedAt: null,
      };
    }
    return {
      configured: true,
      maxAccuracyMeters: policy.maxAccuracyMeters,
      lowAccuracyAction: policy.lowAccuracyAction,
      missingLocationAction: policy.missingLocationAction,
      missingCheckoutAfterMinutes: policy.missingCheckoutAfterMinutes,
      version: policy.version,
      updatedAt: policy.updatedAt.toISOString(),
    };
  }
}
