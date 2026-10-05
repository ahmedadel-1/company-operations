/**
 * JQL builders (INTEGRATIONS §1.9.4). Every value that reaches JQL is either a numeric Jira id
 * (validated) or a quoted, escaped string; user text never becomes JQL syntax. Time bounds use
 * relative minutes (`-120m`) because absolute JQL dates are read in the Jira user's time zone.
 */

const NUMERIC_ID = /^[0-9]{1,20}$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-[0-9]{1,12}$/;
const MAX_TEXT = 100;

function projectIds(ids: readonly string[]): string {
  if (ids.length === 0 || ids.some((value) => !NUMERIC_ID.test(value))) {
    throw new Error('JQL project ids must be numeric.');
  }
  return ids.length === 1 ? `project = ${ids[0] ?? ''}` : `project in (${ids.join(', ')})`;
}

/** A JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Whole minutes between `since` and `now`, plus an overlap; never below the overlap. */
export function minutesSince(since: Date, now: Date, overlapMinutes: number): number {
  const elapsed = Math.ceil((now.getTime() - since.getTime()) / 60_000);
  return Math.max(0, elapsed) + overlapMinutes;
}

/** Full import, oldest first. `createdWithinMinutes` resumes from a checkpoint. */
export function importJql(projectId: string, createdWithinMinutes: number | null): string {
  const bound = createdWithinMinutes === null ? '' : ` AND created >= -${String(createdWithinMinutes)}m`;
  return `${projectIds([projectId])}${bound} ORDER BY created ASC, key ASC`;
}

/** Incremental reconciliation: issues updated within the window, oldest change first. */
export function reconcileJql(projectId: string, updatedWithinMinutes: number): string {
  return `${projectIds([projectId])} AND updated >= -${String(updatedWithinMinutes)}m ORDER BY updated ASC, key ASC`;
}

/** Bounded count query for drift detection. */
export function countJql(projectId: string): string {
  return projectIds([projectId]);
}

/** Webhook filter (the documented JQL subset: `project in (...)`). */
export function webhookJql(ids: readonly string[]): string {
  return projectIds([...ids].sort((a, b) => Number(a) - Number(b)));
}

/** Characters with meaning in Jira text search; removed rather than escaped. */
const TEXT_SPECIALS = /[+\-&|!(){}[\]^~*?\\:"/'%<>=;,]/g;

/**
 * Link search inside the mapped projects: an issue key matches exactly, anything else is a text
 * search on sanitized words. Empty text lists the most recently updated issues.
 */
export function linkSearchJql(ids: readonly string[], text: string): string {
  const scope = projectIds(ids);
  const trimmed = text.trim();
  if (ISSUE_KEY.test(trimmed)) {
    return `${scope} AND issuekey = ${jqlString(trimmed.toUpperCase())} ORDER BY updated DESC`;
  }
  const words = trimmed.replace(TEXT_SPECIALS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return words === ''
    ? `${scope} ORDER BY updated DESC`
    : `${scope} AND text ~ ${jqlString(words)} ORDER BY updated DESC`;
}

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value.trim());
}
