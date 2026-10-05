import { MFA_AT_LOGIN_ROLE_KEYS } from '@company-ops/shared';

/** ACR value of a multi-factor authentication in the Keycloak ACR->LoA mapping (ADR-0002, SECURITY §3.2). */
export const MFA_ACR = 'mfa';

const mfaAtLoginRoles: ReadonlySet<string> = new Set(MFA_AT_LOGIN_ROLE_KEYS);

/** ORG_ADMIN holders need MFA before a session is created (SECURITY §2.3, §3.2). */
export function requiresMfaAtLogin(roleKeys: readonly string[]): boolean {
  return roleKeys.some((key) => mfaAtLoginRoles.has(key));
}

export interface AuthenticationLevel {
  /** `acr` claim of the validated ID token. */
  readonly acr: string | null;
  /** Epoch milliseconds of that authentication (`auth_time`), when it satisfied MFA. */
  readonly mfaAuthenticatedAt: number | null;
}

/** Only the validated token's `acr` counts; never a client-side flag. */
export function isMfaSatisfied(level: AuthenticationLevel, nowMs: number, maxAgeMs: number): boolean {
  return level.acr === MFA_ACR && level.mfaAuthenticatedAt !== null && nowMs - level.mfaAuthenticatedAt <= maxAgeMs;
}
