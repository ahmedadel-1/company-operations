import type { JiraImportState, JiraSyncRunStatus, JiraSyncRunType, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide, loadProjectForAccess } from '../projects/project-access.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import { cancelActiveRuns } from './jira-connection.service.js';
import {
  JiraApiError,
  JiraNotConfiguredError,
  JiraNotConnectedError,
  JiraReauthRequiredError,
  JiraSyncInProgressError,
  toJiraDomainError,
} from './jira-errors.js';
import { recomputeBlocked } from './jira-issue-store.js';
import type { JiraRuntime } from './jira-runtime.js';
import { enqueueRun, queueSyncRun } from './jira-scheduler.js';

export interface JiraRunView {
  readonly id: string;
  readonly mappingId: string;
  readonly project: { readonly id: string; readonly code: string; readonly name: string };
  readonly jiraProjectKey: string;
  readonly type: JiraSyncRunType;
  readonly status: JiraSyncRunStatus;
  readonly cancelRequested: boolean;
  readonly requestedBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly recordsEstimated: number | null;
  readonly recordsProcessed: number;
  readonly recordsCreated: number;
  readonly recordsUpdated: number;
  readonly recordsUnchanged: number;
  readonly recordsFailed: number;
  readonly pages: number;
  /** processed Ã· estimate, capped at 99 while the run is active; null without an estimate. */
  readonly progressPercent: number | null;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly resumedFromRunId: string | null;
  readonly createdAt: string;
}

export interface JiraRunFailureView {
  readonly id: string;
  readonly jiraIssueId: string | null;
  readonly errorCode: string;
  readonly classification: 'RETRYABLE' | 'PERMANENT';
  readonly message: string;
  readonly createdAt: string;
}

export interface JiraMappingView {
  readonly id: string;
  readonly connectionId: string;
  readonly project: { readonly id: string; readonly code: string; readonly name: string };
  readonly jiraProject: { readonly id: string; readonly key: string; readonly name: string };
  readonly syncEnabled: boolean;
  readonly importState: JiraImportState;
  readonly blockedStatuses: readonly string[];
  readonly lastFullSyncAt: string | null;
  readonly lastReconciledAt: string | null;
  readonly lastDeepReconciledAt: string | null;
  readonly issueCount: number;
  readonly lastRun: JiraRunView | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface JiraProjectOption {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly mappedToProjectId: string | null;
}

export interface JiraDeliveryFailureView {
  readonly id: string;
  readonly eventType: string;
  readonly jiraIssueId: string | null;
  readonly errorCode: string | null;
  readonly retryCount: number;
  readonly receivedAt: string;
}

const personSelect = { select: { id: true, profile: { select: { fullName: true } } } } as const;

export const runSelect = {
  id: true,
  mappingId: true,
  type: true,
  status: true,
  cancelRequested: true,
  startedAt: true,
  finishedAt: true,
  recordsEstimated: true,
  recordsProcessed: true,
  recordsCreated: true,
  recordsUpdated: true,
  recordsUnchanged: true,
  recordsFailed: true,
  pages: true,
  errorCode: true,
  errorSummary: true,
  resumedFromRunId: true,
  createdAt: true,
  requestedBy: personSelect,
  mapping: { select: { jiraProjectKey: true, project: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.JiraSyncRunSelect;

type RunRow = Prisma.JiraSyncRunGetPayload<{ select: typeof runSelect }>;

export function toRunView(row: RunRow): JiraRunView {
  const active = row.status === 'QUEUED' || row.status === 'RUNNING';
  let progressPercent: number | null = null;
  if (row.status === 'SUCCEEDED' || row.status === 'PARTIALLY_FAILED') {
    progressPercent = 100;
  } else if (row.recordsEstimated !== null && row.recordsEstimated > 0) {
    const raw = Math.floor((row.recordsProcessed / row.recordsEstimated) * 100);
    progressPercent = active ? Math.min(99, raw) : Math.min(100, raw);
  }
  return {
    id: row.id,
    mappingId: row.mappingId,
    project: row.mapping.project,
    jiraProjectKey: row.mapping.jiraProjectKey,
    type: row.type,
    status: row.status,
    cancelRequested: row.cancelRequested,
    requestedBy:
      row.requestedBy === null
        ? null
        : { memberId: row.requestedBy.id, fullName: row.requestedBy.profile?.fullName ?? null },
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    recordsEstimated: row.recordsEstimated,
    recordsProcessed: row.recordsProcessed,
    recordsCreated: row.recordsCreated,
    recordsUpdated: row.recordsUpdated,
    recordsUnchanged: row.recordsUnchanged,
    recordsFailed: row.recordsFailed,
    pages: row.pages,
    progressPercent,
    errorCode: row.errorCode,
    errorSummary: row.errorSummary,
    resumedFromRunId: row.resumedFromRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

export const mappingSelect = {
  id: true,
  connectionId: true,
  jiraProjectId: true,
  jiraProjectKey: true,
  jiraProjectName: true,
  syncEnabled: true,
  importState: true,
  blockedStatuses: true,
  lastFullSyncAt: true,
  lastReconciledAt: true,
  lastDeepReconciledAt: true,
  version: true,
  createdAt: true,
  project: { select: { id: true, code: true, name: true } },
  syncRuns: { select: runSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
  _count: { select: { issues: { where: { deletedInJiraAt: null } } } },
} satisfies Prisma.JiraProjectMappingSelect;

type MappingRow = Prisma.JiraProjectMappingGetPayload<{ select: typeof mappingSelect }>;

export function toMappingView(row: MappingRow): JiraMappingView {
  const lastRun = row.syncRuns[0];
  return {
    id: row.id,
    connectionId: row.connectionId,
    project: row.project,
    jiraProject: { id: row.jiraProjectId, key: row.jiraProjectKey, name: row.jiraProjectName },
    syncEnabled: row.syncEnabled,
    importState: row.importState,
    blockedStatuses: row.blockedStatuses,
    lastFullSyncAt: row.lastFullSyncAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    lastDeepReconciledAt: row.lastDeepReconciledAt?.toISOString() ?? null,
    issueCount: row._count.issues,
    lastRun: lastRun === undefined ? null : toRunView(lastRun),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

const MAX_BLOCKED = 20;

function normalizeStatuses(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== '' && !seen.has(trimmed.toLowerCase())) {
      seen.set(trimmed.toLowerCase(), trimmed.slice(0, 255));
    }
  }
  if (seen.size > MAX_BLOCKED) {
    throw new InvalidInputError('blockedStatuses', `At most ${String(MAX_BLOCKED)} blocked statuses.`);
  }
  return [...seen.values()];
}

/**
 * Jira administration (`integration.manage` at organization scope): project mappings, sync runs
 * and failure review. Mappings join one internal project to one or more Jira projects of the live
 * connection; a Jira project maps to one internal project. Jira project ids are validated live and
 * immutable; key and name are display copies. Removal is soft so cached issues and ticket links
 * stay intact. Every change is audited; mapping changes also appear on the project timeline.
 */
export class JiraAdminService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: JiraRuntime | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listMappings(action: ActionContext): Promise<JiraMappingView[]> {
    const organizationId = this.authorize(action);
    const rows = await this.db.jiraProjectMapping.findMany({
      where: { organizationId, removedAt: null, connection: { status: { not: 'DISCONNECTED' } } },
      select: mappingSelect,
      orderBy: [{ jiraProjectKey: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map(toMappingView);
  }

  /** Jira projects visible to the connected account (live), with their current mapping. */
  async searchJiraProjects(
    action: ActionContext,
    query: string,
    startAt: number,
  ): Promise<{ items: JiraProjectOption[]; isLast: boolean }> {
    const organizationId = this.authorize(action);
    const connection = await this.liveConnection(organizationId);
    const client = this.requireRuntime().clients.forConnection({
      organizationId,
      connectionId: connection.id,
      cloudId: connection.cloudId,
    });
    let page;
    try {
      page = await client.searchProjects(query, startAt);
    } catch (error) {
      throw error instanceof JiraApiError ? toJiraDomainError(error, 'Jira project') : error;
    }
    const mapped = await this.db.jiraProjectMapping.findMany({
      where: {
        organizationId,
        connectionId: connection.id,
        removedAt: null,
        jiraProjectId: { in: page.values.map((p) => p.id) },
      },
      select: { jiraProjectId: true, projectId: true },
    });
    const byJiraId = new Map(mapped.map((row) => [row.jiraProjectId, row.projectId]));
    return {
      items: page.values.map((project) => ({ ...project, mappedToProjectId: byJiraId.get(project.id) ?? null })),
      isLast: page.isLast,
    };
  }

  async createMapping(
    action: ActionContext,
    input: { projectId: string; jiraProjectId: string; blockedStatuses?: readonly string[] | undefined },
  ): Promise<JiraMappingView> {
    const organizationId = this.authorize(action);
    const connection = await this.liveConnection(organizationId);
    const project = await loadProjectForAccess(this.db, organizationId, input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    if (project.row.status === 'ARCHIVED') {
      throw new InvalidTransitionError('The project is archived; restore it before mapping Jira projects.');
    }
    const blockedStatuses = normalizeStatuses(input.blockedStatuses);
    const client = this.requireRuntime().clients.forConnection({
      organizationId,
      connectionId: connection.id,
      cloudId: connection.cloudId,
    });
    let jiraProject;
    try {
      jiraProject = await client.getProject(input.jiraProjectId);
    } catch (error) {
      throw error instanceof JiraApiError ? toJiraDomainError(error, 'Jira project') : error;
    }
    if (jiraProject.id !== input.jiraProjectId) {
      throw new InvalidInputError('jiraProjectId', 'Use the numeric Jira project id.');
    }
    let mappingId: string;
    try {
      mappingId = await this.db.$transaction(async (tx) => {
        const existing = await tx.jiraProjectMapping.findFirst({
          where: { organizationId, connectionId: connection.id, jiraProjectId: jiraProject.id },
          select: { id: true, removedAt: true, project: { select: { code: true } } },
        });
        if (existing !== null && existing.removedAt === null) {
          throw new ConflictError(`This Jira project is already mapped to ${existing.project.code}.`);
        }
        const fields = {
          projectId: project.id,
          jiraProjectKey: jiraProject.key,
          jiraProjectName: jiraProject.name,
          blockedStatuses,
          syncEnabled: true,
          removedAt: null,
        };
        let id: string;
        if (existing === null) {
          const created = await tx.jiraProjectMapping.create({
            data: {
              organizationId,
              connectionId: connection.id,
              jiraProjectId: jiraProject.id,
              createdByMemberId: action.principal.memberId,
              ...fields,
            },
            select: { id: true },
          });
          id = created.id;
        } else {
          await tx.jiraProjectMapping.updateMany({
            where: { organizationId, id: existing.id },
            data: { ...fields, version: { increment: 1 } },
          });
          id = existing.id;
        }
        await this.queueRunIn(
          tx,
          organizationId,
          connection.id,
          id,
          existing === null ? 'INITIAL_IMPORT' : 'MANUAL_RESYNC',
          action,
        );
        await this.syncWebhooksIn(tx, organizationId, connection.id);
        await recordAudit(tx, organizationId, {
          action: existing === null ? 'jira.mapping.created' : 'jira.mapping.restored',
          entityType: 'jira_project_mapping',
          entityId: id,
          actor: userActor(action),
          metadata: { projectId: project.id, jiraProjectId: jiraProject.id, jiraProjectKey: jiraProject.key },
          context: action.request,
        });
        await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
          source: 'JIRA',
          type: 'jira.mapping_added',
          entityType: 'jira_project_mapping',
          entityId: id,
          summaryParams: { jiraProjectKey: jiraProject.key, jiraProjectName: jiraProject.name },
        });
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('This Jira project was mapped at the same time. Reload and try again.');
      }
      throw error;
    }
    return this.getMapping(organizationId, mappingId);
  }

  async updateMapping(
    action: ActionContext,
    mappingId: string,
    input: { version: number; syncEnabled?: boolean | undefined; blockedStatuses?: readonly string[] | undefined },
  ): Promise<JiraMappingView> {
    const organizationId = this.authorize(action);
    await this.db.$transaction(async (tx) => {
      const row = await tx.jiraProjectMapping.findFirst({
        where: { organizationId, id: mappingId, removedAt: null },
        select: { id: true, connectionId: true, syncEnabled: true, importState: true, blockedStatuses: true },
      });
      if (row === null) {
        throw new NotFoundError('Jira mapping');
      }
      const blockedStatuses =
        input.blockedStatuses === undefined ? undefined : normalizeStatuses(input.blockedStatuses);
      const updated = await tx.jiraProjectMapping.updateMany({
        where: { organizationId, id: mappingId, version: input.version },
        data: {
          ...(input.syncEnabled === undefined ? {} : { syncEnabled: input.syncEnabled }),
          ...(blockedStatuses === undefined ? {} : { blockedStatuses }),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Jira mapping');
      }
      if (blockedStatuses !== undefined) {
        await recomputeBlocked(tx, organizationId, mappingId, blockedStatuses);
      }
      if (input.syncEnabled !== undefined && input.syncEnabled !== row.syncEnabled) {
        if (!input.syncEnabled) {
          await cancelActiveRuns(tx, organizationId, { mappingId }, this.now());
        } else if (row.importState !== 'COMPLETED') {
          await this.queueRunIn(tx, organizationId, row.connectionId, mappingId, 'INITIAL_IMPORT', action);
        }
        await this.syncWebhooksIn(tx, organizationId, row.connectionId);
      }
      await recordAudit(tx, organizationId, {
        action: 'jira.mapping.updated',
        entityType: 'jira_project_mapping',
        entityId: mappingId,
        actor: userActor(action),
        metadata: {
          ...(input.syncEnabled === undefined ? {} : { syncEnabled: input.syncEnabled }),
          ...(blockedStatuses === undefined ? {} : { blockedStatuses }),
        },
        context: action.request,
      });
    });
    return this.getMapping(organizationId, mappingId);
  }

  async removeMapping(action: ActionContext, mappingId: string, version: number): Promise<void> {
    const organizationId = this.authorize(action);
    await this.db.$transaction(async (tx) => {
      const row = await tx.jiraProjectMapping.findFirst({
        where: { organizationId, id: mappingId, removedAt: null },
        select: { id: true, connectionId: true, projectId: true, jiraProjectKey: true, jiraProjectName: true },
      });
      if (row === null) {
        throw new NotFoundError('Jira mapping');
      }
      const updated = await tx.jiraProjectMapping.updateMany({
        where: { organizationId, id: mappingId, version },
        data: { removedAt: this.now(), syncEnabled: false, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Jira mapping');
      }
      await cancelActiveRuns(tx, organizationId, { mappingId }, this.now());
      await this.syncWebhooksIn(tx, organizationId, row.connectionId);
      await recordAudit(tx, organizationId, {
        action: 'jira.mapping.removed',
        entityType: 'jira_project_mapping',
        entityId: mappingId,
        actor: userActor(action),
        metadata: { projectId: row.projectId, jiraProjectKey: row.jiraProjectKey },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, row.projectId, action.principal.memberId, {
        source: 'JIRA',
        type: 'jira.mapping_removed',
        entityType: 'jira_project_mapping',
        entityId: mappingId,
        summaryParams: { jiraProjectKey: row.jiraProjectKey, jiraProjectName: row.jiraProjectName },
      });
    });
  }

  /** Starts a run by hand: a full resync, an incremental reconciliation or a deep check. */
  async requestRun(action: ActionContext, mappingId: string, type: JiraSyncRunType): Promise<JiraRunView> {
    const organizationId = this.authorize(action);
    const mapping = await this.db.jiraProjectMapping.findFirst({
      where: { organizationId, id: mappingId, removedAt: null },
      select: { id: true, connectionId: true, syncEnabled: true, importState: true },
    });
    if (mapping === null) {
      throw new NotFoundError('Jira mapping');
    }
    await this.liveConnection(organizationId);
    if (!mapping.syncEnabled) {
      throw new InvalidTransitionError('Enable sync for this mapping first.');
    }
    if ((type === 'RECONCILIATION' || type === 'DEEP_RECONCILIATION') && mapping.importState !== 'COMPLETED') {
      throw new InvalidTransitionError('Run the initial import before reconciling.');
    }
    const runId = await queueSyncRun(this.db, organizationId, {
      connectionId: mapping.connectionId,
      mappingId,
      type,
      requestedByMemberId: action.principal.memberId,
      requestId: action.request?.requestId ?? null,
    });
    if (runId === null) {
      throw new JiraSyncInProgressError();
    }
    await recordAudit(this.db, organizationId, {
      action: 'jira.sync.requested',
      entityType: 'jira_sync_run',
      entityId: runId,
      actor: userActor(action),
      metadata: { mappingId, type },
      context: action.request,
    });
    return this.getRun(action, runId).then((detail) => detail.run);
  }

  async cancelRun(action: ActionContext, runId: string): Promise<JiraRunView> {
    const organizationId = this.authorize(action);
    const run = await this.db.jiraSyncRun.findFirst({ where: { organizationId, id: runId }, select: { status: true } });
    if (run === null) {
      throw new NotFoundError('Sync run');
    }
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new InvalidTransitionError('Only queued or running syncs can be cancelled.');
    }
    await this.db.$transaction(async (tx) => {
      await tx.jiraSyncRun.updateMany({
        where: { organizationId, id: runId, status: 'QUEUED' },
        data: { status: 'CANCELLED', cancelRequested: true, finishedAt: this.now() },
      });
      await tx.jiraSyncRun.updateMany({
        where: { organizationId, id: runId, status: 'RUNNING' },
        data: { cancelRequested: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'jira.sync.cancelled',
        entityType: 'jira_sync_run',
        entityId: runId,
        actor: userActor(action),
        context: action.request,
      });
    });
    return (await this.getRun(action, runId)).run;
  }

  /** Re-runs a finished run; imports and deep checks resume from its checkpoint. */
  async retryRun(action: ActionContext, runId: string): Promise<JiraRunView> {
    const organizationId = this.authorize(action);
    const run = await this.db.jiraSyncRun.findFirst({
      where: { organizationId, id: runId },
      select: {
        id: true,
        status: true,
        type: true,
        connectionId: true,
        mappingId: true,
        lastCursor: true,
        mapping: { select: { removedAt: true, syncEnabled: true } },
      },
    });
    if (run === null) {
      throw new NotFoundError('Sync run');
    }
    if (run.status !== 'FAILED' && run.status !== 'CANCELLED' && run.status !== 'PARTIALLY_FAILED') {
      throw new InvalidTransitionError('Only failed, partially failed or cancelled syncs can be retried.');
    }
    if (run.mapping.removedAt !== null || !run.mapping.syncEnabled) {
      throw new InvalidTransitionError('Enable sync for this mapping first.');
    }
    await this.liveConnection(organizationId);
    const newId = await queueSyncRun(this.db, organizationId, {
      connectionId: run.connectionId,
      mappingId: run.mappingId,
      type: run.type,
      requestedByMemberId: action.principal.memberId,
      requestId: action.request?.requestId ?? null,
      resumedFromRunId: run.id,
      lastCursor: run.status === 'PARTIALLY_FAILED' ? {} : resumableCursor(run.lastCursor),
    });
    if (newId === null) {
      throw new JiraSyncInProgressError();
    }
    await recordAudit(this.db, organizationId, {
      action: 'jira.sync.retried',
      entityType: 'jira_sync_run',
      entityId: newId,
      actor: userActor(action),
      metadata: { resumedFromRunId: run.id },
      context: action.request,
    });
    return (await this.getRun(action, newId)).run;
  }

  async listRuns(
    action: ActionContext,
    options: {
      mappingId?: string | undefined;
      status?: JiraSyncRunStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<Page<JiraRunView>> {
    const organizationId = this.authorize(action);
    const size = pageSize(options.limit);
    const and: Prisma.JiraSyncRunWhereInput[] = [];
    if (options.cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(options.cursor, 2);
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.jiraSyncRun.findMany({
      where: {
        organizationId,
        ...(options.mappingId === undefined ? {} : { mappingId: options.mappingId }),
        ...(options.status === undefined ? {} : { status: options.status }),
        AND: and,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: runSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toRunView), nextCursor: page.nextCursor };
  }

  async getRun(action: ActionContext, runId: string): Promise<{ run: JiraRunView; failures: JiraRunFailureView[] }> {
    const organizationId = this.authorize(action);
    const row = await this.db.jiraSyncRun.findFirst({ where: { organizationId, id: runId }, select: runSelect });
    if (row === null) {
      throw new NotFoundError('Sync run');
    }
    const failures = await this.db.jiraSyncFailure.findMany({
      where: { organizationId, runId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, jiraIssueId: true, errorCode: true, classification: true, message: true, createdAt: true },
    });
    return {
      run: toRunView(row),
      failures: failures.map((failure) => ({ ...failure, createdAt: failure.createdAt.toISOString() })),
    };
  }

  /** Recent webhook deliveries that could not be processed (identifiers and error codes only). */
  async failedDeliveries(action: ActionContext): Promise<JiraDeliveryFailureView[]> {
    const organizationId = this.authorize(action);
    const rows = await this.db.jiraWebhookDelivery.findMany({
      where: { organizationId, status: 'FAILED' },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { id: true, eventType: true, jiraIssueId: true, errorCode: true, retryCount: true, receivedAt: true },
    });
    return rows.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString() }));
  }

  private async getMapping(organizationId: string, mappingId: string): Promise<JiraMappingView> {
    const row = await this.db.jiraProjectMapping.findFirst({
      where: { organizationId, id: mappingId },
      select: mappingSelect,
    });
    if (row === null) {
      throw new NotFoundError('Jira mapping');
    }
    return toMappingView(row);
  }

  private async queueRunIn(
    tx: TenantDb,
    organizationId: string,
    connectionId: string,
    mappingId: string,
    type: JiraSyncRunType,
    action: ActionContext,
  ): Promise<void> {
    const active = await tx.jiraSyncRun.findFirst({
      where: { organizationId, mappingId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (active !== null) {
      return;
    }
    const run = await tx.jiraSyncRun.create({
      data: {
        organizationId,
        connectionId,
        mappingId,
        type,
        requestedByMemberId: action.principal.memberId,
        requestId: action.request?.requestId ?? null,
      },
      select: { id: true },
    });
    await enqueueRun(tx, organizationId, run.id);
  }

  private async syncWebhooksIn(tx: TenantDb, organizationId: string, connectionId: string): Promise<void> {
    await enqueueOutboxEvent(tx, organizationId, {
      eventType: 'jira.webhooks.sync',
      aggregateType: 'jira_connection',
      aggregateId: connectionId,
      payload: { connectionId },
    });
  }

  /** The organization's connection, when Jira calls can be made with it. */
  private async liveConnection(organizationId: string): Promise<{ id: string; cloudId: string }> {
    this.requireRuntime();
    const connection = await this.db.jiraConnection.findFirst({
      where: { organizationId, status: { not: 'DISCONNECTED' } },
      select: { id: true, cloudId: true, status: true },
    });
    if (connection === null) {
      throw new JiraNotConnectedError();
    }
    if (connection.status === 'NEEDS_REAUTH') {
      throw new JiraReauthRequiredError();
    }
    return connection;
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'integration.manage')) {
      throw new ForbiddenError();
    }
    return organizationId;
  }

  private requireRuntime(): JiraRuntime {
    if (this.runtime === null) {
      throw new JiraNotConfiguredError();
    }
    return this.runtime;
  }
}

function resumableCursor(value: Prisma.JsonValue): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of ['createdAfter', 'updatedAfter', 'lastIssueRowId']) {
      const field = value[key];
      if (typeof field === 'string') {
        result[key] = field;
      }
    }
  }
  return result;
}
