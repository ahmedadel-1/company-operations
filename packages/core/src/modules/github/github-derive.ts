import type { GithubChecksState, GithubReviewState } from '@company-ops/db';

import type { CheckRunWire, CombinedStatusWire, ReviewWire } from './github-wire.js';

/**
 * Operational review summary of a pull request (no per-person scoring). Each reviewer's latest
 * decisive review counts (APPROVED, CHANGES_REQUESTED; DISMISSED clears it; COMMENTED and PENDING
 * never override). Precedence: any outstanding change request, then pending review requests, then
 * at least one approval.
 */
export function deriveReviewState(
  reviews: readonly ReviewWire[],
  requestedReviewers: readonly string[],
): GithubReviewState {
  const latest = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  const ordered = [...reviews].sort((a, b) => {
    const at = a.submitted_at === null || a.submitted_at === undefined ? 0 : Date.parse(a.submitted_at);
    const bt = b.submitted_at === null || b.submitted_at === undefined ? 0 : Date.parse(b.submitted_at);
    return at - bt || a.id - b.id;
  });
  for (const review of ordered) {
    const reviewer = review.user?.login;
    if (reviewer === undefined) {
      continue;
    }
    const state = review.state.toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      latest.set(reviewer, state);
    } else if (state === 'DISMISSED') {
      latest.delete(reviewer);
    }
  }
  const decisions = [...latest.values()];
  if (decisions.includes('CHANGES_REQUESTED')) {
    return 'CHANGES_REQUESTED';
  }
  if (requestedReviewers.length > 0) {
    return 'REVIEW_REQUIRED';
  }
  return decisions.includes('APPROVED') ? 'APPROVED' : 'NONE';
}

/** Pending review requests as stored: user logins and `team:<slug>`. */
export function requestedReviewerList(pull: {
  requested_reviewers: readonly { login: string }[];
  requested_teams: readonly { slug: string }[];
}): string[] {
  return [
    ...pull.requested_reviewers.map((user) => user.login),
    ...pull.requested_teams.map((team) => `team:${team.slug}`),
  ].slice(0, 100);
}

export interface ChecksSummary {
  readonly state: GithubChecksState;
  readonly total: number;
  readonly failed: number;
  readonly pending: number;
}

/** Check-run conclusions that block a merge in practice. neutral, skipped, stale and success do not. */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/**
 * Pending / passing / failing summary of a head commit from its check runs and legacy commit
 * statuses. Failing wins over pending, pending over passing; nothing reported at all is UNKNOWN.
 */
export function deriveChecks(runs: readonly CheckRunWire[], status: CombinedStatusWire | null): ChecksSummary {
  let total = 0;
  let failed = 0;
  let pending = 0;
  for (const run of runs) {
    total += 1;
    if (run.status !== 'completed') {
      pending += 1;
    } else if (FAILING_CONCLUSIONS.has(run.conclusion ?? '')) {
      failed += 1;
    }
  }
  for (const entry of status?.statuses ?? []) {
    total += 1;
    if (entry.state === 'failure' || entry.state === 'error') {
      failed += 1;
    } else if (entry.state === 'pending') {
      pending += 1;
    }
  }
  let state: GithubChecksState = 'UNKNOWN';
  if (failed > 0) {
    state = 'FAILURE';
  } else if (pending > 0) {
    state = 'PENDING';
  } else if (total > 0) {
    state = 'SUCCESS';
  }
  return { state, total, failed, pending };
}
