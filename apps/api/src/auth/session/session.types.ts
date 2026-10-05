/**
 * Server-side session (SECURITY §3.3). Lives only in Redis; the browser holds an opaque id. The
 * active organization is trusted session state, changed only by a validated switch.
 */
export interface SessionRecord {
  readonly v: 1;
  readonly userId: string;
  readonly organizationId: string;
  readonly memberId: string;
  /** `organization_members.authz_version` the cached permissions were computed for. */
  readonly authzVersion: number;
  readonly roleKeys: readonly string[];
  readonly permissions: Readonly<Record<string, readonly string[]>>;
  /** `acr` of the last validated ID token. */
  readonly acr: string | null;
  /** Epoch ms of the last MFA authentication (ID token `auth_time` with `acr = mfa`). */
  readonly mfaAuthenticatedAt: number | null;
  /** Keycloak session id (`sid`), for back-channel logout. */
  readonly idpSessionId: string | null;
  /** AES-256-GCM envelope of the ID token, used only as `id_token_hint` at logout. */
  readonly idTokenEnc: string | null;
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly absoluteExpiresAt: number;
}

export type NewSession = Omit<
  SessionRecord,
  'v' | 'csrfToken' | 'createdAt' | 'lastSeenAt' | 'absoluteExpiresAt' | 'idTokenEnc'
> & {
  readonly idToken: string | null;
};

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPermissionMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((scopes) => isStringArray(scopes))
  );
}

/** Validates a record read back from Redis; anything unexpected is treated as no session. */
export function parseSessionRecord(raw: string): SessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const r = value as Record<string, unknown>;
  if (!(
    r.v === 1 &&
    isString(r.userId) &&
    isString(r.organizationId) &&
    isString(r.memberId) &&
    isFiniteNumber(r.authzVersion) &&
    isStringArray(r.roleKeys) &&
    isPermissionMap(r.permissions) &&
    isNullableString(r.acr) &&
    isNullableNumber(r.mfaAuthenticatedAt) &&
    isNullableString(r.idpSessionId) &&
    isNullableString(r.idTokenEnc) &&
    isString(r.csrfToken) &&
    isFiniteNumber(r.createdAt) &&
    isFiniteNumber(r.lastSeenAt) &&
    isFiniteNumber(r.absoluteExpiresAt)
  )) {
    return null;
  }
  return {
    v: 1,
    userId: r.userId,
    organizationId: r.organizationId,
    memberId: r.memberId,
    authzVersion: r.authzVersion,
    roleKeys: r.roleKeys,
    permissions: r.permissions,
    acr: r.acr,
    mfaAuthenticatedAt: r.mfaAuthenticatedAt,
    idpSessionId: r.idpSessionId,
    idTokenEnc: r.idTokenEnc,
    csrfToken: r.csrfToken,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    absoluteExpiresAt: r.absoluteExpiresAt,
  };
}
