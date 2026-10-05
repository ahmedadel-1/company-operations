import type { PrismaClient, RetentionCategory } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { purgeAttendanceCoordinates } from '../../platform/db/sql/attendance.js';
import { organizationsWithRetentionPolicies, purgeIntegrationRecords } from '../../platform/db/sql/github-scan.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { AsyncLocalTenantContext, TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide } from '../projects/project-access.js';

export const RETENTION_CATEGORIES = [
  'WEBHOOK_DELIVERIES',
  'SYNC_FAILURES',
  'ATTENDANCE_COORDINATES',
] as const satisfies readonly RetentionCategory[];
export const MIN_RETAIN_DAYS = 7;
/** Coordinates stay available for reviews and corrections for at least a month (ADR-0022). */
export const MIN_ATTENDANCE_COORDINATE_DAYS = 30;
export const MAX_RETAIN_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPreview {
  readonly category: RetentionCategory;
  readonly retainDays: number;
  readonly eligible: number;
}

export interface RetentionPolicyView {
  readonly category: RetentionCategory;
  /** Null = no policy: nothing in this category is ever deleted. */
  readonly retainDays: number | null;
  readonly configuredAt: string | null;
  readonly configuredBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly lastPurgedAt: string | null;
  readonly lastPurgedCount: number | null;
  readonly version: number | null;
}

const policySelect = {
  category: true,
  retainDays: true,
  configuredAt: true,
  lastPurgedAt: true,
  lastPurgedCount: true,
  version: true,
  configuredBy: { select: { id: true, profile: { select: { fullName: true } } } },
} as const;

/**
 * Retention of technical integration records (ADR-0020): processed webhook delivery records (Jira
 * and GitHub) and per-record sync failures; and attendance coordinates (ADR-0022), which are nulled
 * while the evidence row itself is kept. Without a policy nothing is deleted. Audit history,
 * ticket ↔ Jira links, pull-request ↔ Jira links, cached business records and sync runs are never
 * in scope. `org.settings.manage` at organization scope; controllers add fresh MFA. Every change
 * is audited.
 */
export class RetentionPolicyService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext): Promise<RetentionPolicyView[]> {
    const organizationId = this.authorize(action);
    const rows = await this.db.retentionPolicy.findMany({ where: { organizationId }, select: policySelect });
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    return RETENTION_CATEGORIES.map((category) => {
      const row = byCategory.get(category);
      return row === undefined
        ? {
            category,
            retainDays: null,
            configuredAt: null,
            configuredBy: null,
            lastPurgedAt: null,
            lastPurgedCount: null,
            version: null,
          }
        : {
            category,
            retainDays: row.retainDays,
            configuredAt: row.configuredAt.toISOString(),
            configuredBy:
              row.configuredBy === null
                ? null
                : { memberId: row.configuredBy.id, fullName: row.configuredBy.profile?.fullName ?? null },
            lastPurgedAt: row.lastPurgedAt?.toISOString() ?? null,
            lastPurgedCount: row.lastPurgedCount,
            version: row.version,
          };
    });
  }

  /**
   * Dry run shown before a policy is saved: the records `purge_integration_records` would remove
   * now under `retainDays` (same predicates; nothing is deleted).
   */
  async preview(action: ActionContext, category: RetentionCategory, retainDays: number): Promise<RetentionPreview> {
    const organizationId = this.authorize(action);
    const cutoff = new Date(this.now().getTime() - retainDays * DAY_MS);
    let eligible: number;
    if (category === 'WEBHOOK_DELIVERIES') {
      const delivered = { organizationId, status: { not: 'RECEIVED' as const }, receivedAt: { lt: cutoff } };
      eligible =
        (await this.db.jiraWebhookDelivery.count({ where: delivered })) +
        (await this.db.githubWebhookDelivery.count({ where: delivered }));
    } else if (category === 'ATTENDANCE_COORDINATES') {
      eligible = await this.db.attendanceEvent.count({
        where: {
          organizationId,
          latitude: { not: null },
          recordedAt: { lt: cutoff },
          reviewStatus: { not: 'PENDING_REVIEW' },
        },
      });
    } else {
      const failed = { organizationId, createdAt: { lt: cutoff } };
      eligible =
        (await this.db.jiraSyncFailure.count({ where: failed })) +
        (await this.db.githubSyncFailure.count({ where: failed }));
    }
    return { category, retainDays, eligible };
  }

  /** Creates (version null) or updates (matching version) a category's policy. */
  async set(
    action: ActionContext,
    category: RetentionCategory,
    input: { retainDays: number; version: number | null },
  ): Promise<RetentionPolicyView[]> {
    const organizationId = this.authorize(action);
    if (category === 'ATTENDANCE_COORDINATES' && input.retainDays < MIN_ATTENDANCE_COORDINATE_DAYS) {
      throw new InvalidInputError(
        'retainDays',
        `Attendance coordinates must be kept for at least ${String(MIN_ATTENDANCE_COORDINATE_DAYS)} days.`,
      );
    }
    await this.db.$transaction(async (tx) => {
      const existing = await tx.retentionPolicy.findFirst({
        where: { organizationId, category },
        select: { id: true, retainDays: true },
      });
      if (existing === null) {
        if (input.version !== null) {
          throw new VersionConflictError('Retention policy');
        }
        try {
          await tx.retentionPolicy.create({
            data: {
              organizationId,
              category,
              action: category === 'ATTENDANCE_COORDINATES' ? 'NULL_COORDINATES' : 'DELETE_ROWS',
              retainDays: input.retainDays,
              configuredByMemberId: action.principal.memberId,
              configuredAt: this.now(),
            },
            select: { id: true },
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictError('The policy was created at the same time. Reload and try again.');
          }
          throw error;
        }
      } else {
        const updated = await tx.retentionPolicy.updateMany({
          where: { organizationId, id: existing.id, version: input.version ?? -1 },
          data: {
            retainDays: input.retainDays,
            configuredByMemberId: action.principal.memberId,
            configuredAt: this.now(),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) {
          throw new VersionConflictError('Retention policy');
        }
      }
      await recordAudit(tx, organizationId, {
        action: existing === null ? 'retention.policy.created' : 'retention.policy.updated',
        entityType: 'retention_policy',
        entityId: category,
        actor: userActor(action),
        metadata: { category, retainDays: input.retainDays, previousRetainDays: existing?.retainDays ?? null },
        context: action.request,
      });
    });
    return this.list(action);
  }

  /** Removes a policy: records of that category are kept indefinitely again. */
  async remove(action: ActionContext, category: RetentionCategory, version: number): Promise<RetentionPolicyView[]> {
    const organizationId = this.authorize(action);
    await this.db.$transaction(async (tx) => {
      const existing = await tx.retentionPolicy.findFirst({
        where: { organizationId, category },
        select: { id: true, retainDays: true },
      });
      if (existing === null) {
        throw new NotFoundError('Retention policy');
      }
      const deleted = await tx.retentionPolicy.deleteMany({ where: { organizationId, id: existing.id, version } });
      if (deleted.count === 0) {
        throw new VersionConflictError('Retention policy');
      }
      await recordAudit(tx, organizationId, {
        action: 'retention.policy.removed',
        entityType: 'retention_policy',
        entityId: category,
        actor: userActor(action),
        metadata: { category, previousRetainDays: existing.retainDays },
        context: action.request,
      });
    });
    return this.list(action);
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'org.settings.manage')) {
      throw new ForbiddenError();
    }
    return organizationId;
  }
}

export interface PurgeTotals {
  readonly organizations: number;
  readonly purged: number;
  readonly failedOrganizations: number;
}

/** Batches per category and pass; the rest is picked up by the next pass. */
const MAX_BATCHES_PER_PASS = 20;

/**
 * Worker side: applies each organization's policies through `purge_integration_records`, a bounded
 * SECURITY DEFINER function (the application role has no DELETE on these tables). The function
 * re-reads the policy itself, never touches records still awaiting processing, and deletes at most
 * `batchSize` rows per call, oldest first.
 */
export class RetentionPurger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: AsyncLocalTenantContext,
    private readonly onOrganizationError: (organizationId: string, error: unknown) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async purgeAll(batchSize: number): Promise<PurgeTotals> {
    const organizations = await organizationsWithRetentionPolicies(this.prisma);
    let purged = 0;
    let failedOrganizations = 0;
    for (const organizationId of organizations) {
      try {
        purged += await this.tenant.run({ organizationId, memberId: null, userId: null }, () =>
          this.purgeOrganization(batchSize),
        );
      } catch (error) {
        failedOrganizations += 1;
        this.onOrganizationError(organizationId, error);
      }
    }
    return { organizations: organizations.length, purged, failedOrganizations };
  }

  /** Purges the organization of the active (system) tenant context only; it never takes an id from callers. */
  private async purgeOrganization(batchSize: number): Promise<number> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const policies = await this.db.retentionPolicy.findMany({
      where: { organizationId },
      select: { id: true, category: true },
    });
    let total = 0;
    for (const policy of policies) {
      let count = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
        const purged =
          policy.category === 'ATTENDANCE_COORDINATES'
            ? await purgeAttendanceCoordinates(this.prisma, organizationId, batchSize)
            : await purgeIntegrationRecords(this.prisma, organizationId, policy.category, batchSize);
        count += purged;
        if (purged < batchSize) {
          break;
        }
      }
      await this.db.retentionPolicy.updateMany({
        where: { organizationId, id: policy.id },
        data: { lastPurgedAt: this.now(), lastPurgedCount: count },
      });
      if (count > 0) {
        await recordAudit(this.db, organizationId, {
          action: 'retention.records_purged',
          entityType: 'retention_policy',
          entityId: policy.category,
          actor: { type: 'SYSTEM' },
          metadata: { category: policy.category, count },
        });
      }
      total += count;
    }
    return total;
  }
}
