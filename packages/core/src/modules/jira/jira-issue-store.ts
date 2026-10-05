import type { JiraStatusCategory } from '@company-ops/db';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { loadTicketForAccess } from '../support/ticket-access.js';
import { recordTicketEvent } from '../support/ticket-history.js';
import { announceTicketChange, notifyTicketAudience, watcherMemberIds } from '../support/ticket-notify.js';
import { isBlockedStatus, snapshotHash } from './jira-mapper.js';
import type { JiraIssueSnapshot } from './jira-mapper.js';

export interface MappingInfo {
  readonly id: string;
  readonly projectId: string;
  readonly jiraProjectId: string;
  readonly blockedStatuses: readonly string[];
}

/** Everything needed to place an issue: its connection and the connection's live mappings by Jira project id. */
export interface IssuePlacement {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly mappings: ReadonlyMap<string, MappingInfo>;
}

export type ApplyOutcome = 'created' | 'updated' | 'unchanged' | 'stale' | 'ignored';

export interface ApplyResult {
  readonly outcome: ApplyOutcome;
  readonly issueId: string | null;
}

/** Live (not removed) mappings of a connection, keyed by Jira project id. */
export async function loadPlacement(
  db: TenantDb,
  organizationId: string,
  connectionId: string,
): Promise<IssuePlacement> {
  const rows = await db.jiraProjectMapping.findMany({
    where: { organizationId, connectionId, removedAt: null },
    select: { id: true, projectId: true, jiraProjectId: true, blockedStatuses: true },
  });
  return { organizationId, connectionId, mappings: new Map(rows.map((row) => [row.jiraProjectId, row])) };
}

function issueData(snapshot: JiraIssueSnapshot, mappingId: string | null, isBlocked: boolean, hash: string, now: Date) {
  return {
    mappingId,
    issueKey: snapshot.issueKey,
    jiraProjectId: snapshot.jiraProjectId,
    summary: snapshot.summary,
    issueType: snapshot.issueType,
    statusName: snapshot.statusName,
    statusCategory: snapshot.statusCategory,
    priorityName: snapshot.priorityName,
    assigneeAccountId: snapshot.assigneeAccountId,
    assigneeDisplayName: snapshot.assigneeDisplayName,
    reporterDisplayName: snapshot.reporterDisplayName,
    jiraCreatedAt: snapshot.jiraCreatedAt,
    jiraUpdatedAt: snapshot.jiraUpdatedAt,
    dueDate: snapshot.dueDate,
    resolution: snapshot.resolution,
    resolvedAt: snapshot.resolvedAt,
    labels: [...snapshot.labels],
    parentIssueId: snapshot.parentIssueId,
    isBlocked,
    url: snapshot.url,
    syncHash: hash,
    lastSyncedAt: now,
    deletedInJiraAt: null,
  };
}

/**
 * Upserts one issue into the cache by its immutable Jira id (keys change when issues move).
 * - Out-of-order guard: a snapshot older than the cached `jiraUpdatedAt` is ignored (`stale`), also
 *   under concurrency (conditional update).
 * - No write when nothing changed (content hash).
 * - An issue in an unmapped project is cached only if it is already known (it moved; its mapping
 *   becomes null) or `allowUnmapped` (created from a ticket into a mapped project, then moved).
 * - A status change on a linked issue records `JIRA_STATUS_SYNCED` on each linked ticket; a status
 *   category change also notifies the ticket's assignee and watchers in-app. Ticket state never changes.
 */
export async function applySnapshot(
  db: TenantScopedClient,
  placement: IssuePlacement,
  snapshot: JiraIssueSnapshot,
  options: { allowUnmapped?: boolean; now?: Date } = {},
): Promise<ApplyResult> {
  try {
    return await applyOnce(db, placement, snapshot, options);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return applyOnce(db, placement, snapshot, options);
    }
    throw error;
  }
}

async function applyOnce(
  db: TenantScopedClient,
  placement: IssuePlacement,
  snapshot: JiraIssueSnapshot,
  options: { allowUnmapped?: boolean; now?: Date },
): Promise<ApplyResult> {
  const { organizationId, connectionId } = placement;
  const now = options.now ?? new Date();
  const mapping = placement.mappings.get(snapshot.jiraProjectId) ?? null;
  const isBlocked = mapping === null ? false : isBlockedStatus(snapshot.statusName, mapping.blockedStatuses);
  const hash = snapshotHash(snapshot, mapping?.id ?? null, isBlocked);
  const data = issueData(snapshot, mapping?.id ?? null, isBlocked, hash, now);
  return db.$transaction(async (tx) => {
    const existing = await tx.jiraIssue.findFirst({
      where: { organizationId, connectionId, jiraIssueId: snapshot.jiraIssueId },
      select: {
        id: true,
        jiraUpdatedAt: true,
        syncHash: true,
        statusName: true,
        statusCategory: true,
        deletedInJiraAt: true,
      },
    });
    if (existing === null) {
      if (mapping === null && options.allowUnmapped !== true) {
        return { outcome: 'ignored', issueId: null };
      }
      const created = await tx.jiraIssue.create({
        data: { organizationId, connectionId, jiraIssueId: snapshot.jiraIssueId, ...data },
        select: { id: true },
      });
      return { outcome: 'created', issueId: created.id };
    }
    if (existing.jiraUpdatedAt.getTime() > snapshot.jiraUpdatedAt.getTime()) {
      return { outcome: 'stale', issueId: existing.id };
    }
    if (existing.syncHash === hash && existing.deletedInJiraAt === null) {
      return { outcome: 'unchanged', issueId: existing.id };
    }
    const updated = await tx.jiraIssue.updateMany({
      where: { organizationId, id: existing.id, jiraUpdatedAt: { lte: snapshot.jiraUpdatedAt } },
      data,
    });
    if (updated.count === 0) {
      return { outcome: 'stale', issueId: existing.id };
    }
    if (existing.statusName !== snapshot.statusName || existing.statusCategory !== snapshot.statusCategory) {
      await recordStatusSync(tx, organizationId, existing.id, snapshot, {
        statusName: existing.statusName,
        statusCategory: existing.statusCategory,
      });
    }
    return { outcome: 'updated', issueId: existing.id };
  });
}

async function recordStatusSync(
  tx: TenantDb,
  organizationId: string,
  issueId: string,
  snapshot: JiraIssueSnapshot,
  previous: { statusName: string; statusCategory: JiraStatusCategory },
): Promise<void> {
  const links = await tx.supportTicketJiraLink.findMany({
    where: { organizationId, issueId },
    select: { ticketId: true },
    orderBy: { ticketId: 'asc' },
  });
  const categoryChanged = previous.statusCategory !== snapshot.statusCategory;
  for (const { ticketId } of links) {
    const eventId = await recordTicketEvent(tx, organizationId, ticketId, {
      type: 'JIRA_STATUS_SYNCED',
      actorMemberId: null,
      from: { status: previous.statusName, category: previous.statusCategory },
      to: { status: snapshot.statusName, category: snapshot.statusCategory },
      metadata: { issueKey: snapshot.issueKey, issueId },
    });
    if (categoryChanged) {
      const ticket = await loadTicketForAccess(tx, organizationId, ticketId);
      if (ticket !== null) {
        await notifyTicketAudience(
          tx,
          organizationId,
          ticket,
          [ticket.row.assigneeMemberId, ...(await watcherMemberIds(tx, organizationId, ticketId))],
          {
            type: 'JIRA_ISSUE_STATUS_CHANGED',
            severity: 'INFO',
            email: false,
            causeId: eventId,
            requires: 'jira.view',
            params: { issueKey: snapshot.issueKey, status: snapshot.statusName },
          },
          null,
        );
      }
    }
    await announceTicketChange(tx, organizationId, ticketId, false);
  }
}

/** Marks a cached issue deleted/inaccessible in Jira. Links stay; the issue is shown as removed. */
export async function tombstoneIssue(
  db: TenantDb,
  organizationId: string,
  connectionId: string,
  jiraIssueId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db.jiraIssue.updateMany({
    where: { organizationId, connectionId, jiraIssueId, deletedInJiraAt: null },
    data: { deletedInJiraAt: now, lastSyncedAt: now },
  });
  return result.count > 0;
}

/** Recomputes `isBlocked` for a mapping after its blocked-status list changed (few distinct statuses). */
export async function recomputeBlocked(
  db: TenantDb,
  organizationId: string,
  mappingId: string,
  blockedStatuses: readonly string[],
): Promise<void> {
  const groups = await db.jiraIssue.groupBy({
    by: ['statusName'],
    where: { organizationId, mappingId },
    orderBy: { statusName: 'asc' },
  });
  for (const { statusName } of groups) {
    await db.jiraIssue.updateMany({
      where: { organizationId, mappingId, statusName },
      data: { isBlocked: isBlockedStatus(statusName, blockedStatuses) },
    });
  }
}
