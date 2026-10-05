import { useSyncExternalStore } from 'react';

/*
 * Dashboard deep links (ADR-0023 filter descriptors) are read through `WithLinkParams` and
 * `useLocationHash`, never from `window.location` during render: after a client-side navigation the
 * first render still sees the previous URL. Every value is validated against the allowed set; anything
 * unexpected is ignored, never forwarded as typed text.
 */

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
};

/** The URL fragment without `#`; re-read once the navigation has committed the new URL. */
export function useLocationHash(): string {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.replace('#', ''),
    () => '',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === value);
}

/** Comma-separated enum values; undefined when none is valid. */
export function csvOf<T extends string>(value: string | null, allowed: readonly T[]): T[] | undefined {
  if (value === null) return undefined;
  const picked = value
    .split(',')
    .map((part) => oneOf(part, allowed))
    .filter((part): part is T => part !== undefined);
  return picked.length === 0 ? undefined : [...new Set(picked)];
}

export const uuidOf = (value: string | null): string | undefined =>
  value !== null && UUID.test(value) ? value : undefined;

export const instantOf = (value: string | null): string | undefined =>
  value !== null && ISO_INSTANT.test(value) ? value : undefined;

export const dateOf = (value: string | null): string | undefined =>
  value !== null && ISO_DATE.test(value) ? value : undefined;

/** Turns a server link (`{ path, query, hash }`) into an app URL. */
export function linkHref(link: {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly hash: string | null;
}): string {
  const search = new URLSearchParams(link.query).toString();
  return `${link.path}${search === '' ? '' : `?${search}`}${link.hash === null ? '' : `#${link.hash}`}`;
}
