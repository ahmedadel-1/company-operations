import type { AuditActorType, Prisma } from '@company-ops/db';

import { ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';

export interface AuditEventView {
  readonly id: string;
  readonly createdAt: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorType: AuditActorType;
  readonly actor: {
    readonly memberId: string | null;
    readonly userId: string | null;
    readonly displayName: string | null;
  };
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Redacted at write time (SECURITY §7); never contains secrets. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventFilter {
  readonly action?: string | undefined;
  readonly actionPrefix?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly actorMemberId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const select = {
  id: true,
  createdAt: true,
  action: true,
  entityType: true,
  entityId: true,
  actorType: true,
  actorMemberId: true,
  actorUserId: true,
  requestId: true,
  ip: true,
  userAgent: true,
  metadata: true,
  actorUser: { select: { displayName: true } },
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof select }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toView = (row: AuditRow): AuditEventView => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  actorType: row.actorType,
  actor: { memberId: row.actorMemberId, userId: row.actorUserId, displayName: row.actorUser?.displayName ?? null },
  requestId: row.requestId,
  ip: row.ip,
  userAgent: row.userAgent,
  metadata: isRecord(row.metadata) ? row.metadata : {},
});

/**
 * Read side of the organization audit log (P1-13, SECURITY §4.4): tenant-scoped, `audit.view` at
 * ORG scope (audit rows are organization-wide), newest first with keyset pagination on
 * (created_at, id). There is no write, update or delete path here; platform audit logs are not
 * reachable (the tenant guard rejects them).
 */
export class AuditQueryService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, filter: AuditEventFilter): Promise<Page<AuditEventView>> {
    const organizationId = this.authorize(action);
    const size = pageSize(filter.limit);
    const and: Prisma.AuditLogWhereInput[] = [];
    if (filter.action !== undefined) and.push({ action: filter.action });
    if (filter.actionPrefix !== undefined) and.push({ action: { startsWith: filter.actionPrefix } });
    if (filter.entityType !== undefined) and.push({ entityType: filter.entityType });
    if (filter.entityId !== undefined) and.push({ entityId: filter.entityId });
    if (filter.actorMemberId !== undefined) and.push({ actorMemberId: filter.actorMemberId });
    if (filter.from !== undefined) and.push({ createdAt: { gte: new Date(filter.from) } });
    if (filter.to !== undefined) and.push({ createdAt: { lt: new Date(filter.to) } });
    if (filter.cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(filter.cursor, 2);
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.auditLog.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, auditEventId: string): Promise<AuditEventView> {
    const organizationId = this.authorize(action);
    const row = await this.db.auditLog.findFirst({ where: { organizationId, id: auditEventId }, select });
    if (row === null) {
      throw new NotFoundError('Audit event');
    }
    return toView(row);
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!canAccessResource(action.principal, 'audit.view', { organizationId })) {
      throw new ForbiddenError();
    }
    return organizationId;
  }
}
