import { createHash, randomBytes } from 'node:crypto';

/** Invitations are valid for 7 days; re-issuing revokes the previous token. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 random bytes, base64url. Shown once to the inviter; only its SHA-256 is stored. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape check before hashing, so arbitrary strings never reach the database lookup. */
export function isWellFormedInvitationToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
