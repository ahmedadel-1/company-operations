import { createHash } from 'node:crypto';

import type { JiraStatusCategory } from '@company-ops/db';

import type { JiraIssueWire } from './jira-wire.js';

/** The cached copy of one Jira issue (DATA_MODEL §8 `jira_issues`), derived from a Jira response. */
export interface JiraIssueSnapshot {
  readonly jiraIssueId: string;
  readonly issueKey: string;
  readonly jiraProjectId: string;
  readonly summary: string;
  readonly issueType: string;
  readonly statusName: string;
  readonly statusCategory: JiraStatusCategory;
  readonly priorityName: string | null;
  readonly assigneeAccountId: string | null;
  readonly assigneeDisplayName: string | null;
  readonly reporterDisplayName: string | null;
  readonly jiraCreatedAt: Date;
  readonly jiraUpdatedAt: Date;
  readonly dueDate: Date | null;
  readonly resolution: string | null;
  readonly resolvedAt: Date | null;
  readonly labels: readonly string[];
  readonly parentIssueId: string | null;
  readonly url: string;
}

const MAX_SUMMARY = 1000;
const MAX_NAME = 255;
const MAX_LABELS = 50;

const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);
const clipOrNull = (value: string | null | undefined, max = MAX_NAME): string | null =>
  value === null || value === undefined || value === '' ? null : clip(value, max);

/** Jira status categories: `new` → TODO, `indeterminate` → IN_PROGRESS, `done` → DONE. */
export function toStatusCategory(key: string | undefined): JiraStatusCategory {
  if (key === 'done') {
    return 'DONE';
  }
  if (key === 'indeterminate') {
    return 'IN_PROGRESS';
  }
  return 'TODO';
}

/** Jira timestamps look like `2026-10-01T10:00:00.000+0000`; the offset gets a colon for `Date`. */
export function parseJiraTimestamp(value: string): Date | null {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJiraDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Browser link to the issue on its site (the site URL comes from accessible-resources only). */
export function issueBrowseUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(issueKey)}`;
}

/** Maps a validated Jira issue; null when its timestamps cannot be parsed (recorded as a failure). */
export function toSnapshot(issue: JiraIssueWire, siteUrl: string): JiraIssueSnapshot | null {
  const fields = issue.fields;
  const created = parseJiraTimestamp(fields.created);
  const updated = parseJiraTimestamp(fields.updated);
  if (created === null || updated === null) {
    return null;
  }
  return {
    jiraIssueId: issue.id,
    issueKey: issue.key,
    jiraProjectId: fields.project.id,
    summary: clip(fields.summary, MAX_SUMMARY),
    issueType: clip(fields.issuetype.name, MAX_NAME),
    statusName: clip(fields.status.name, MAX_NAME),
    statusCategory: toStatusCategory(fields.status.statusCategory?.key),
    priorityName: clipOrNull(fields.priority?.name),
    assigneeAccountId: clipOrNull(fields.assignee?.accountId, 128),
    assigneeDisplayName: clipOrNull(fields.assignee?.displayName),
    reporterDisplayName: clipOrNull(fields.reporter?.displayName),
    jiraCreatedAt: created,
    jiraUpdatedAt: updated,
    dueDate: parseJiraDate(fields.duedate),
    resolution: clipOrNull(fields.resolution?.name),
    resolvedAt:
      fields.resolutiondate === null || fields.resolutiondate === undefined
        ? null
        : parseJiraTimestamp(fields.resolutiondate),
    labels: (fields.labels ?? []).slice(0, MAX_LABELS).map((label) => clip(label, MAX_NAME)),
    parentIssueId: fields.parent?.id ?? null,
    url: issueBrowseUrl(siteUrl, issue.key),
  };
}

/**
 * Whether a status counts as blocked for a mapping: one of its configured status names
 * (case-insensitive), or, when none are configured, a name containing "block".
 */
export function isBlockedStatus(statusName: string, blockedStatuses: readonly string[]): boolean {
  if (blockedStatuses.length === 0) {
    return /block/i.test(statusName);
  }
  const name = statusName.toLowerCase();
  return blockedStatuses.some((status) => status.toLowerCase() === name);
}

/** Content hash of the cached fields: an unchanged hash means no write is needed. */
export function snapshotHash(snapshot: JiraIssueSnapshot, mappingId: string | null, isBlocked: boolean): string {
  const canonical = JSON.stringify([
    snapshot.issueKey,
    snapshot.jiraProjectId,
    snapshot.summary,
    snapshot.issueType,
    snapshot.statusName,
    snapshot.statusCategory,
    snapshot.priorityName,
    snapshot.assigneeAccountId,
    snapshot.assigneeDisplayName,
    snapshot.reporterDisplayName,
    snapshot.jiraUpdatedAt.toISOString(),
    snapshot.dueDate?.toISOString() ?? null,
    snapshot.resolution,
    snapshot.resolvedAt?.toISOString() ?? null,
    snapshot.labels,
    snapshot.parentIssueId,
    snapshot.url,
    mappingId,
    isBlocked,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
