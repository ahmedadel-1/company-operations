import type {
  GithubAccountType,
  GithubInstallationStatus,
  GithubRepositorySelection,
  GithubRepositoryStatus,
  GithubSyncRunStatus,
  GithubSyncRunType,
  GithubSyncState,
  GithubWebhookDeliveryStatus,
  Prisma,
} from '@company-ops/db';

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
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide, loadProjectForAccess } from '../projects/project-access.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import { GithubInstallationInactiveError, GithubSyncInProgressError } from './github-errors.js';
import { cancelGithubRuns, enqueueInstallationSync, queueGithubRun } from './github-runs.js';
import { githubCallbackUrl, githubSetupUrl, githubWebhookUrl } from './github-runtime.js';
import type { GithubRuntime } from './github-runtime.js';

/** Repository permissions the App requests (read-only; never contents). */
export const GITHUB_REQUIRED_PERMISSIONS: Readonly<Record<string, 'read'>> = {
  metadata: 'read',
  pull_requests: 'read',
  checks: 'read',
  statuses: 'read',
};

/** Webhook events the App subscribes to (installation events are always delivered). */
export const GITHUB_SUBSCRIBED_EVENTS = [
  'repository',
  'pull_request',
  'pull_request_review',
  'check_suite',
  'check_run',
  'status',
] as const;

export interface GithubInstallationView {
  readonly id: string;
  readonly githubInstallationId: string;
  readonly accountLogin: string;
  readonly accountType: GithubAccountType;
  readonly repositorySelection: GithubRepositorySelection;
  readonly permissions: Readonly<Record<string, string>>;
  /** Required permissions GitHub does not report as granted (the owner must accept new permissions). */
  readonly missingPermissions: readonly string[];
  readonly events: readonly string[];
  readonly status: GithubInstallationStatus;
  readonly suspendedAt: string | null;
  readonly boundAt: string;
  readonly installedBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly repositoryCount: number;
  /** Where the account owner manages the installation on GitHub. */
  readonly manageUrl: string | null;
  readonly version: number;
}

export interface GithubIntegrationStatus {
  readonly configured: boolean;
  readonly canInstall: boolean;
  readonly webhookUrl: string | null;
  readonly setupUrl: string | null;
  readonly callbackUrl: string | null;
  readonly requiredPermissions: Readonly<Record<string, string>>;
  readonly subscribedEvents: readonly string[];
  readonly installations: readonly GithubInstallationView[];
}

export interface GithubRunView {
  readonly id: string;
  readonly repository: { readonly id: string; readonly fullName: string };
  readonly type: GithubSyncRunType;
  readonly status: GithubSyncRunStatus;
  readonly cancelRequested: boolean;
  readonly requestedBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly recordsProcessed: number;
  readonly recordsCreated: number;
  readonly recordsUpdated: number;
  readonly recordsUnchanged: number;
  readonly recordsFailed: number;
  readonly pages: number;
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
  readonly createdAt: string;
}

export interface GithubRunFailureView {
  readonly id: string;
  readonly prNumber: number | null;
  readonly errorCode: string;
  readonly classification: 'RETRYABLE' | 'PERMANENT';
  readonly message: string;
  readonly createdAt: string;
}

export interface GithubMappingView {
  readonly id: string;
  readonly project: { readonly id: string; readonly code: string; readonly name: string };
  readonly version: number;
  readonly createdAt: string;
}

export interface GithubRepositoryView {
  readonly id: string;
  readonly installationId: string;
  readonly githubRepoId: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly htmlUrl: string;
  readonly defaultBranch: string | null;
  readonly status: GithubRepositoryStatus;
  readonly unavailableAt: string | null;
  readonly syncState: GithubSyncState;
  readonly lastFullSyncAt: string | null;
  readonly lastReconciledAt: string | null;
  readonly openPullCount: number;
  readonly mappings: readonly GithubMappingView[];
  readonly lastRun: GithubRunView | null;
}

export interface GithubDeliveryView {
  readonly id: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly status: GithubWebhookDeliveryStatus;
  readonly outcome: string | null;
  readonly errorCode: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

const personSelect = { select: { id: true, profile: { select: { fullName: true } } } } as const;

const runSelect = {
  id: true,
  type: true,
  status: true,
  cancelRequested: true,
  startedAt: true,
  finishedAt: true,
  recordsProcessed: true,
  recordsCreated: true,
  recordsUpdated: true,
  recordsUnchanged: true,
  recordsFailed: true,
  pages: true,
  errorCode: true,
  errorSummary: true,
  createdAt: true,
  requestedBy: personSelect,
  repository: { select: { id: true, fullName: true } },
} as const satisfies Prisma.GithubSyncRunSelect;

type RunRow = Prisma.GithubSyncRunGetPayload<{ select: typeof runSelect }>;

export function toGithubRunView(row: RunRow): GithubRunView {
  return {
    id: row.id,
    repository: row.repository,
    type: row.type,
    status: row.status,
    cancelRequested: row.cancelRequested,
    requestedBy:
      row.requestedBy === null
        ? null
        : { memberId: row.requestedBy.id, fullName: row.requestedBy.profile?.fullName ?? null },
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    recordsProcessed: row.recordsProcessed,
    recordsCreated: row.recordsCreated,
    recordsUpdated: row.recordsUpdated,
    recordsUnchanged: row.recordsUnchanged,
    recordsFailed: row.recordsFailed,
    pages: row.pages,
    errorCode: row.errorCode,
    errorSummary: row.errorSummary,
    createdAt: row.createdAt.toISOString(),
  };
}

const installationSelect = {
  id: true,
  githubInstallationId: true,
  accountLogin: true,
  accountType: true,
  repositorySelection: true,
  permissions: true,
  events: true,
  status: true,
  suspendedAt: true,
  boundAt: true,
  lastSyncedAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  version: true,
  installedBy: personSelect,
  _count: { select: { repositories: { where: { status: 'AVAILABLE' } } } },
} as const satisfies Prisma.GithubInstallationSelect;

type InstallationRow = Prisma.GithubInstallationGetPayload<{ select: typeof installationSelect }>;

const repositorySelect = {
  id: true,
  installationId: true,
  githubRepoId: true,
  fullName: true,
  private: true,
  archived: true,
  htmlUrl: true,
  defaultBranch: true,
  status: true,
  unavailableAt: true,
  syncState: true,
  lastFullSyncAt: true,
  lastReconciledAt: true,
  mappings: {
    where: { removedAt: null },
    select: { id: true, version: true, createdAt: true, project: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
  syncRuns: { select: runSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
  _count: { select: { pullRequests: { where: { state: 'OPEN' } } } },
} as const satisfies Prisma.GithubRepositorySelect;

type RepositoryRow = Prisma.GithubRepositoryGetPayload<{ select: typeof repositorySelect }>;

function toRepositoryView(row: RepositoryRow): GithubRepositoryView {
  const lastRun = row.syncRuns[0];
  return {
    id: row.id,
    installationId: row.installationId,
    githubRepoId: row.githubRepoId.toString(),
    fullName: row.fullName,
    private: row.private,
    archived: row.archived,
    htmlUrl: row.htmlUrl,
    defaultBranch: row.defaultBranch,
    status: row.status,
    unavailableAt: row.unavailableAt?.toISOString() ?? null,
    syncState: row.syncState,
    lastFullSyncAt: row.lastFullSyncAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    openPullCount: row._count.pullRequests,
    mappings: row.mappings.map((mapping) => ({
      id: mapping.id,
      project: mapping.project,
      version: mapping.version,
      createdAt: mapping.createdAt.toISOString(),
    })),
    lastRun: lastRun === undefined ? null : toGithubRunView(lastRun),
  };
}

function permissionRecord(value: Prisma.JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, level] of Object.entries(value)) {
      if (typeof level === 'string') {
        out[key] = level;
      }
    }
  }
  return out;
}

/**
 * GitHub administration (`integration.manage` at organization scope; controllers add fresh MFA):
 * installation health, repository discovery results, project ↔ repository mappings (many-to-many,
 * same organization only, repositories of a verified active installation only), sync runs and
 * redacted webhook delivery records. Everything here reads the local cache; GitHub is only called
 * by the worker. Every change is audited; mapping changes also appear on the project timeline.
 */
export class GithubAdminService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: GithubRuntime | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(action: ActionContext): Promise<GithubIntegrationStatus> {
    const organizationId = this.authorize(action);
    const rows = await this.db.githubInstallation.findMany({
      where: { organizationId, status: { not: 'DISCONNECTED' } },
      select: installationSelect,
      orderBy: [{ boundAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    const settings = this.runtime?.settings ?? null;
    return {
      configured: settings !== null,
      canInstall: (settings?.slug ?? null) !== null && (settings?.clientSecret ?? null) !== null,
      webhookUrl: settings === null ? null : githubWebhookUrl(settings),
      setupUrl: settings === null ? null : githubSetupUrl(settings),
      callbackUrl: settings === null ? null : githubCallbackUrl(settings),
      requiredPermissions: GITHUB_REQUIRED_PERMISSIONS,
      subscribedEvents: GITHUB_SUBSCRIBED_EVENTS,
      installations: rows.map((row) => this.installationView(row)),
    };
  }

  async listRepositories(
    action: ActionContext,
    options: { installationId?: string | undefined; includeUnavailable?: boolean | undefined },
  ): Promise<GithubRepositoryView[]> {
    const organizationId = this.authorize(action);
    const rows = await this.db.githubRepository.findMany({
      where: {
        organizationId,
        installation: { status: { not: 'DISCONNECTED' } },
        ...(options.installationId === undefined ? {} : { installationId: options.installationId }),
        ...(options.includeUnavailable === true
          ? {}
          : { OR: [{ status: 'AVAILABLE' }, { mappings: { some: { removedAt: null } } }] }),
      },
      select: repositorySelect,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toRepositoryView);
  }

  async createMapping(
    action: ActionContext,
    input: { repositoryId: string; projectId: string },
  ): Promise<GithubRepositoryView> {
    const organizationId = this.authorize(action);
    const repo = await this.db.githubRepository.findFirst({
      where: { organizationId, id: input.repositoryId },
      select: {
        id: true,
        fullName: true,
        status: true,
        installationId: true,
        lastFullSyncAt: true,
        installation: { select: { status: true } },
      },
    });
    if (repo === null) {
      throw new NotFoundError('GitHub repository');
    }
    if (repo.status !== 'AVAILABLE' || repo.installation.status !== 'ACTIVE') {
      throw new GithubInstallationInactiveError('The repository is not accessible through an active installation.');
    }
    const project = await loadProjectForAccess(this.db, organizationId, input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    if (project.row.status === 'ARCHIVED') {
      throw new InvalidTransitionError('The project is archived; restore it before mapping repositories.');
    }
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.githubRepositoryMapping.findFirst({
          where: { organizationId, repositoryId: repo.id, projectId: project.id },
          select: { id: true, removedAt: true },
        });
        if (existing !== null && existing.removedAt === null) {
          throw new ConflictError('This repository is already mapped to the project.');
        }
        let id: string;
        if (existing === null) {
          const created = await tx.githubRepositoryMapping.create({
            data: {
              organizationId,
              repositoryId: repo.id,
              projectId: project.id,
              createdByMemberId: action.principal.memberId,
            },
            select: { id: true },
          });
          id = created.id;
        } else {
          await tx.githubRepositoryMapping.updateMany({
            where: { organizationId, id: existing.id },
            data: { removedAt: null, createdByMemberId: action.principal.memberId, version: { increment: 1 } },
          });
          id = existing.id;
        }
        await recordAudit(tx, organizationId, {
          action: existing === null ? 'github.mapping.created' : 'github.mapping.restored',
          entityType: 'github_repository_mapping',
          entityId: id,
          actor: userActor(action),
          metadata: { projectId: project.id, repositoryId: repo.id, repository: repo.fullName },
          context: action.request,
        });
        await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
          source: 'GITHUB',
          type: 'github.repository_mapped',
          entityType: 'github_repository_mapping',
          entityId: id,
          summaryParams: { repository: repo.fullName },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('This repository was mapped at the same time. Reload and try again.');
      }
      throw error;
    }
    await queueGithubRun(this.db, organizationId, {
      installationId: repo.installationId,
      repositoryId: repo.id,
      type: repo.lastFullSyncAt === null ? 'INITIAL_SYNC' : 'RECONCILIATION',
      requestedByMemberId: action.principal.memberId,
      requestId: action.request?.requestId ?? null,
    });
    return this.getRepository(organizationId, repo.id);
  }

  async removeMapping(action: ActionContext, mappingId: string, version: number): Promise<void> {
    const organizationId = this.authorize(action);
    await this.db.$transaction(async (tx) => {
      const row = await tx.githubRepositoryMapping.findFirst({
        where: { organizationId, id: mappingId, removedAt: null },
        select: { id: true, projectId: true, repositoryId: true, repository: { select: { fullName: true } } },
      });
      if (row === null) {
        throw new NotFoundError('GitHub mapping');
      }
      const updated = await tx.githubRepositoryMapping.updateMany({
        where: { organizationId, id: mappingId, version, removedAt: null },
        data: { removedAt: this.now(), version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('GitHub mapping');
      }
      const remaining = await tx.githubRepositoryMapping.count({
        where: { organizationId, repositoryId: row.repositoryId, removedAt: null },
      });
      if (remaining === 0) {
        await cancelGithubRuns(tx, organizationId, { repositoryId: row.repositoryId });
      }
      await recordAudit(tx, organizationId, {
        action: 'github.mapping.removed',
        entityType: 'github_repository_mapping',
        entityId: mappingId,
        actor: userActor(action),
        metadata: { projectId: row.projectId, repositoryId: row.repositoryId, repository: row.repository.fullName },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, row.projectId, action.principal.memberId, {
        source: 'GITHUB',
        type: 'github.repository_unmapped',
        entityType: 'github_repository_mapping',
        entityId: mappingId,
        summaryParams: { repository: row.repository.fullName },
      });
    });
  }

  /** Full resync of a mapped repository (open PRs plus the history window). */
  async requestSync(action: ActionContext, repositoryId: string): Promise<GithubRunView> {
    const organizationId = this.authorize(action);
    const repo = await this.db.githubRepository.findFirst({
      where: { organizationId, id: repositoryId },
      select: {
        id: true,
        status: true,
        installationId: true,
        installation: { select: { status: true } },
        _count: { select: { mappings: { where: { removedAt: null } } } },
      },
    });
    if (repo === null) {
      throw new NotFoundError('GitHub repository');
    }
    if (repo.status !== 'AVAILABLE' || repo.installation.status !== 'ACTIVE') {
      throw new GithubInstallationInactiveError();
    }
    if (repo._count.mappings === 0) {
      throw new InvalidTransitionError('Map the repository to a project first.');
    }
    const runId = await queueGithubRun(this.db, organizationId, {
      installationId: repo.installationId,
      repositoryId: repo.id,
      type: 'MANUAL_RESYNC',
      requestedByMemberId: action.principal.memberId,
      requestId: action.request?.requestId ?? null,
    });
    if (runId === null) {
      throw new GithubSyncInProgressError();
    }
    await recordAudit(this.db, organizationId, {
      action: 'github.sync.requested',
      entityType: 'github_sync_run',
      entityId: runId,
      actor: userActor(action),
      metadata: { repositoryId },
      context: action.request,
    });
    return (await this.getRun(action, runId)).run;
  }

  /** Re-reads the installation and its repository list from GitHub (worker). */
  async refreshInstallation(action: ActionContext, installationId: string): Promise<void> {
    const organizationId = this.authorize(action);
    const row = await this.db.githubInstallation.findFirst({
      where: { organizationId, id: installationId },
      select: { status: true },
    });
    if (row === null) {
      throw new NotFoundError('GitHub installation');
    }
    if (row.status === 'DELETED' || row.status === 'DISCONNECTED') {
      throw new GithubInstallationInactiveError();
    }
    await this.db.$transaction(async (tx) => {
      await enqueueInstallationSync(tx, organizationId, installationId);
      await recordAudit(tx, organizationId, {
        action: 'github.installation.refresh_requested',
        entityType: 'github_installation',
        entityId: installationId,
        actor: userActor(action),
        context: action.request,
      });
    });
  }

  /**
   * Unbinds an installation from this organization: syncing and webhook processing stop at once,
   * repositories become unavailable, and cached pull requests, mappings and links stay as history.
   * The App stays installed on GitHub until the account owner uninstalls it there.
   */
  async disconnect(action: ActionContext, installationId: string, version: number): Promise<GithubInstallationView> {
    const organizationId = this.authorize(action);
    const now = this.now();
    const githubId = await this.db.$transaction(async (tx): Promise<string | null> => {
      const row = await tx.githubInstallation.findFirst({
        where: { organizationId, id: installationId },
        select: { status: true, accountLogin: true, githubInstallationId: true },
      });
      if (row === null) {
        throw new NotFoundError('GitHub installation');
      }
      if (row.status === 'DISCONNECTED') {
        return null;
      }
      const updated = await tx.githubInstallation.updateMany({
        where: { organizationId, id: installationId, version },
        data: { status: 'DISCONNECTED', disconnectedAt: now, deletedAt: null, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('GitHub installation');
      }
      const ghId = row.githubInstallationId.toString();
      await tx.githubRepository.updateMany({
        where: { organizationId, installationId, status: 'AVAILABLE' },
        data: { status: 'REMOVED', unavailableAt: now },
      });
      await cancelGithubRuns(tx, organizationId, { installationId });
      await recordAudit(tx, organizationId, {
        action: 'github.installation.disconnected',
        entityType: 'github_installation',
        entityId: installationId,
        actor: userActor(action),
        metadata: { account: row.accountLogin, githubInstallationId: ghId },
        context: action.request,
      });
      return ghId;
    });
    if (githubId !== null && this.runtime !== null) {
      await this.runtime.tokens.invalidate(githubId);
    }
    const row = await this.db.githubInstallation.findFirst({
      where: { organizationId, id: installationId },
      select: installationSelect,
    });
    if (row === null) {
      throw new NotFoundError('GitHub installation');
    }
    return this.installationView(row);
  }

  async listRuns(
    action: ActionContext,
    options: {
      repositoryId?: string | undefined;
      status?: GithubSyncRunStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<Page<GithubRunView>> {
    const organizationId = this.authorize(action);
    const size = pageSize(options.limit);
    const and: Prisma.GithubSyncRunWhereInput[] = [];
    if (options.cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(options.cursor, 2);
      const at = new Date(createdAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.githubSyncRun.findMany({
      where: {
        organizationId,
        ...(options.repositoryId === undefined ? {} : { repositoryId: options.repositoryId }),
        ...(options.status === undefined ? {} : { status: options.status }),
        AND: and,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: runSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toGithubRunView), nextCursor: page.nextCursor };
  }

  async getRun(
    action: ActionContext,
    runId: string,
  ): Promise<{ run: GithubRunView; failures: GithubRunFailureView[] }> {
    const organizationId = this.authorize(action);
    const row = await this.db.githubSyncRun.findFirst({ where: { organizationId, id: runId }, select: runSelect });
    if (row === null) {
      throw new NotFoundError('Sync run');
    }
    const failures = await this.db.githubSyncFailure.findMany({
      where: { organizationId, runId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, prNumber: true, errorCode: true, classification: true, message: true, createdAt: true },
    });
    return {
      run: toGithubRunView(row),
      failures: failures.map((failure) => ({ ...failure, createdAt: failure.createdAt.toISOString() })),
    };
  }

  async cancelRun(action: ActionContext, runId: string): Promise<GithubRunView> {
    const organizationId = this.authorize(action);
    const run = await this.db.githubSyncRun.findFirst({
      where: { organizationId, id: runId },
      select: { status: true },
    });
    if (run === null) {
      throw new NotFoundError('Sync run');
    }
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new InvalidTransitionError('Only queued or running syncs can be cancelled.');
    }
    await this.db.$transaction(async (tx) => {
      await tx.githubSyncRun.updateMany({
        where: { organizationId, id: runId, status: 'QUEUED' },
        data: { status: 'CANCELLED', cancelRequested: true, finishedAt: this.now() },
      });
      await tx.githubSyncRun.updateMany({
        where: { organizationId, id: runId, status: 'RUNNING' },
        data: { cancelRequested: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'github.sync.cancelled',
        entityType: 'github_sync_run',
        entityId: runId,
        actor: userActor(action),
        context: action.request,
      });
    });
    return (await this.getRun(action, runId)).run;
  }

  /** Delivery records (identifiers, outcome and error codes only — payloads are never stored). */
  async listDeliveries(
    action: ActionContext,
    options: {
      status?: GithubWebhookDeliveryStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<Page<GithubDeliveryView>> {
    const organizationId = this.authorize(action);
    const size = pageSize(options.limit);
    const and: Prisma.GithubWebhookDeliveryWhereInput[] = [];
    if (options.cursor !== undefined) {
      const [receivedAt = '', id = ''] = decodeCursor(options.cursor, 2);
      const at = new Date(receivedAt);
      if (Number.isNaN(at.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ receivedAt: { lt: at } }, { receivedAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.githubWebhookDelivery.findMany({
      where: { organizationId, ...(options.status === undefined ? {} : { status: options.status }), AND: and },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: {
        id: true,
        deliveryId: true,
        event: true,
        action: true,
        status: true,
        outcome: true,
        errorCode: true,
        receivedAt: true,
        processedAt: true,
      },
    });
    const page = toPage(rows, size, (row) => [row.receivedAt.toISOString(), row.id]);
    return {
      items: page.items.map((row) => ({
        ...row,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async getRepository(organizationId: string, repositoryId: string): Promise<GithubRepositoryView> {
    const row = await this.db.githubRepository.findFirst({
      where: { organizationId, id: repositoryId },
      select: repositorySelect,
    });
    if (row === null) {
      throw new NotFoundError('GitHub repository');
    }
    return toRepositoryView(row);
  }

  private installationView(row: InstallationRow): GithubInstallationView {
    const permissions = permissionRecord(row.permissions);
    const web = this.runtime?.settings.webBaseUrl ?? null;
    const id = row.githubInstallationId.toString();
    let manageUrl: string | null = null;
    if (web !== null) {
      manageUrl =
        row.accountType === 'USER'
          ? `${web}/settings/installations/${id}`
          : `${web}/organizations/${encodeURIComponent(row.accountLogin)}/settings/installations/${id}`;
    }
    return {
      id: row.id,
      githubInstallationId: id,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      permissions,
      missingPermissions: Object.keys(GITHUB_REQUIRED_PERMISSIONS).filter((name) => permissions[name] === undefined),
      events: row.events,
      status: row.status,
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      boundAt: row.boundAt.toISOString(),
      installedBy:
        row.installedBy === null
          ? null
          : { memberId: row.installedBy.id, fullName: row.installedBy.profile?.fullName ?? null },
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      repositoryCount: row._count.repositories,
      manageUrl,
      version: row.version,
    };
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'integration.manage')) {
      throw new ForbiddenError();
    }
    return organizationId;
  }
}
