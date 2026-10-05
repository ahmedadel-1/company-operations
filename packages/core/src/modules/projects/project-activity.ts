import type { Prisma, ProjectActivitySource } from '@company-ops/db';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { InvalidInputError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { OutboxStore, ProjectActivityRecordedPayload } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import { loadVisibleProject } from './project-access.js';

export interface ProjectActivityView {
  readonly id: string;
  readonly occurredAt: string;
  readonly source: ProjectActivitySource;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly summaryParams: Readonly<Record<string, unknown>>;
  readonly actor: { readonly memberId: string; readonly fullName: string | null } | null;
}

/** Fields a producer supplies; the project, time and actor are bound by {@link recordProjectActivity}. */
export interface ActivityEntry {
  readonly source: ProjectActivitySource;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly summaryParams: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Producer side (ARCHITECTURE §3): called with the transaction client of the business change, so
 * the timeline entry exists exactly when the change committed. The entry itself is written by the
 * `project-activity.record` consumer.
 */
export async function recordProjectActivity(
  store: OutboxStore,
  organizationId: string,
  projectId: string,
  actorMemberId: string | null,
  entry: ActivityEntry,
): Promise<void> {
  await enqueueOutboxEvent(store, organizationId, {
    eventType: 'project.activity.recorded',
    aggregateType: 'project',
    aggregateId: projectId,
    payload: {
      projectId,
      occurredAt: new Date().toISOString(),
      source: entry.source,
      type: entry.type,
      entityType: entry.entityType,
      entityId: entry.entityId,
      summaryParams: entry.summaryParams,
      actorMemberId,
    },
  });
}

export type ActivityWriteResult =
  | { readonly kind: 'created'; readonly activityId: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'project_not_found' };

/**
 * Consumer side: appends one timeline entry in the active (system) tenant context. Idempotent by
 * the outbox event id; a project that does not exist in the event's organization is reported, never
 * linked (the composite foreign key would reject it as well). An actor that is not a member of the
 * organization is dropped rather than failing the entry.
 */
export class ProjectActivityWriter {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async record(eventId: string, payload: ProjectActivityRecordedPayload): Promise<ActivityWriteResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const existing = await this.db.projectActivity.findFirst({
      where: { organizationId, sourceEventId: eventId },
      select: { id: true },
    });
    if (existing !== null) {
      return { kind: 'duplicate' };
    }
    const project = await this.db.project.findFirst({
      where: { organizationId, id: payload.projectId },
      select: { id: true },
    });
    if (project === null) {
      return { kind: 'project_not_found' };
    }
    const actor =
      payload.actorMemberId === null
        ? null
        : await this.db.organizationMember.findFirst({
            where: { organizationId, id: payload.actorMemberId },
            select: { id: true },
          });
    try {
      const row = await this.db.projectActivity.create({
        data: {
          organizationId,
          projectId: project.id,
          occurredAt: new Date(payload.occurredAt),
          source: payload.source,
          type: payload.type,
          entityType: payload.entityType,
          entityId: payload.entityId,
          summaryParams: { ...payload.summaryParams },
          actorMemberId: actor?.id ?? null,
          sourceEventId: eventId,
        },
        select: { id: true },
      });
      return { kind: 'created', activityId: row.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { kind: 'duplicate' };
      }
      throw error;
    }
  }

  /**
   * Rebuilds the timeline of one project (or every project) of the active organization from the
   * retained `project.activity.recorded` outbox events: existing entries are deleted and re-derived
   * in event order. Used for recovery; entries are a read model, not audit.
   */
  async rebuild(projectId?: string): Promise<{ deleted: number; created: number }> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const deleted = await this.db.projectActivity.deleteMany({
      where: { organizationId, ...(projectId === undefined ? {} : { projectId }) },
    });
    let created = 0;
    let cursor: string | undefined;
    for (;;) {
      const events = await this.db.outboxEvent.findMany({
        where: {
          organizationId,
          eventType: 'project.activity.recorded',
          ...(projectId === undefined ? {} : { aggregateId: projectId }),
          ...(cursor === undefined ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: 'asc' },
        take: 500,
        select: { id: true, payload: true },
      });
      for (const event of events) {
        const payload = parseActivityPayload(event.payload);
        if (payload !== null && (await this.record(event.id, payload)).kind === 'created') {
          created += 1;
        }
      }
      const last = events.at(-1);
      if (last === undefined || events.length < 500) {
        break;
      }
      cursor = last.id;
    }
    return { deleted: deleted.count, created };
  }
}

const ACTIVITY_SOURCES = new Set(['SUPPORT', 'JIRA', 'GITHUB', 'DAILY_REPORT', 'PROJECT', 'REQUEST']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural check of a stored activity payload (the worker validates job data with Zod first). */
export function parseActivityPayload(value: unknown): ProjectActivityRecordedPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const { projectId, occurredAt, source, type, entityType, entityId, summaryParams, actorMemberId } = value;
  if (
    typeof projectId !== 'string' ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(Date.parse(occurredAt)) ||
    typeof source !== 'string' ||
    !ACTIVITY_SOURCES.has(source) ||
    typeof type !== 'string' ||
    typeof entityType !== 'string' ||
    !(entityId === null || typeof entityId === 'string') ||
    !isRecord(summaryParams) ||
    !(actorMemberId === null || typeof actorMemberId === 'string')
  ) {
    return null;
  }
  const params: Record<string, string | number | boolean | null> = {};
  for (const [key, param] of Object.entries(summaryParams)) {
    if (param === null || typeof param === 'string' || typeof param === 'number' || typeof param === 'boolean') {
      params[key] = param;
    }
  }
  return {
    projectId,
    occurredAt,
    source: source as ProjectActivityRecordedPayload['source'],
    type,
    entityType,
    entityId,
    summaryParams: params,
    actorMemberId,
  };
}

const activitySelect = {
  id: true,
  occurredAt: true,
  source: true,
  type: true,
  entityType: true,
  entityId: true,
  summaryParams: true,
  actorMember: { select: { id: true, profile: { select: { fullName: true } } } },
} satisfies Prisma.ProjectActivitySelect;

/**
 * Reads a project's timeline for callers who can view the project. Daily-report entries are shown
 * only to callers who may also view the project's daily reports, so the timeline never reveals more
 * than the underlying records would.
 */
export class ProjectActivityService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(
    action: ActionContext,
    projectId: string,
    options: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<ProjectActivityView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    const showReports = canAccessResource(action.principal, 'daily_report.view', project.facts);
    const size = pageSize(options.limit);
    const and: Prisma.ProjectActivityWhereInput[] = [];
    if (!showReports) {
      and.push({ source: { not: 'DAILY_REPORT' } });
    }
    if (options.cursor !== undefined) {
      const [occurredAt = '', id = ''] = decodeCursor(options.cursor, 2);
      const at = new Date(occurredAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.projectActivity.findMany({
      where: { organizationId, projectId: project.id, AND: and },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: activitySelect,
    });
    const page = toPage(rows, size, (row) => [row.occurredAt.toISOString(), row.id]);
    return {
      items: page.items.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        source: row.source,
        type: row.type,
        entityType: row.entityType,
        entityId: row.entityId,
        summaryParams: isRecord(row.summaryParams) ? row.summaryParams : {},
        actor:
          row.actorMember === null
            ? null
            : { memberId: row.actorMember.id, fullName: row.actorMember.profile?.fullName ?? null },
      })),
      nextCursor: page.nextCursor,
    };
  }
}
