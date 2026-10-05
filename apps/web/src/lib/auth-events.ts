import { ApiError } from './api';

export type AuthProblem = 'session-expired' | 'mfa-required';

type Listener = (problem: AuthProblem) => void;

const listeners = new Set<Listener>();

/** Lets the app shell react to 401s from any query or mutation without each screen handling them. */
export function onAuthProblem(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Classifies an error; returns true when it was an authentication problem that the shell now handles. */
export function reportAuthProblem(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) {
    return false;
  }
  const problem: AuthProblem = error.code === 'MFA_REQUIRED' ? 'mfa-required' : 'session-expired';
  for (const listener of listeners) {
    listener(problem);
  }
  return true;
}

export function loginUrl(returnTo: string): string {
  return `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function stepUpUrl(returnTo: string): string {
  return `/api/v1/auth/step-up?returnTo=${encodeURIComponent(returnTo)}`;
}

export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
