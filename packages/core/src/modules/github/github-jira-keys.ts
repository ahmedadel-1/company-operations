import type { GithubPrJiraLinkSource } from '@company-ops/db';

/** Only this much of a pull-request description is scanned (it is never stored). */
export const BODY_SCAN_LIMIT = 10_000;
/** At most this many distinct keys are kept per pull request. */
export const MAX_KEYS_PER_PULL = 50;

const UPPER_KEY = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,49}-[1-9][0-9]{0,11})(?![A-Za-z0-9])/g;
/** Branch names are usually lower case (`feature/ihd-42-login`), so case is ignored there only. */
const ANY_CASE_KEY = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]{1,49}-[1-9][0-9]{0,11})(?![A-Za-z0-9])/g;

export interface InferredKey {
  readonly key: string;
  /** Highest-priority place it was found: branch name, then title, then description. */
  readonly source: Exclude<GithubPrJiraLinkSource, 'MANUAL'>;
}

function scan(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1].toUpperCase()]));
}

/**
 * Jira-looking keys in a pull request's branch name, title and description (first
 * `BODY_SCAN_LIMIT` characters). These are candidates only: nothing here says the issue exists.
 */
export function inferJiraKeys(input: { branch: string; title: string; body: string | null }): InferredKey[] {
  const found = new Map<string, InferredKey['source']>();
  const add = (keys: readonly string[], source: InferredKey['source']): void => {
    for (const key of keys) {
      if (!found.has(key) && found.size < MAX_KEYS_PER_PULL) {
        found.set(key, source);
      }
    }
  };
  add(scan(input.branch, ANY_CASE_KEY), 'BRANCH_NAME');
  add(scan(input.title, UPPER_KEY), 'TITLE');
  add(scan((input.body ?? '').slice(0, BODY_SCAN_LIMIT), UPPER_KEY), 'BODY');
  return [...found].map(([key, source]) => ({ key, source }));
}
