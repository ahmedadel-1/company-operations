const SECRET_KEYS = [
  'password',
  'secret',
  'clientSecret',
  'client_secret',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'privateKey',
  'webhookSecret',
  'jwt',
  'authorization',
  'cookie',
  'csrfToken',
  'sessionId',
  'invitationToken',
  'codeVerifier',
  'nonce',
] as const;
/** Attendance coordinates are personal data and never belong in logs (SECURITY §9). */
const LOCATION_KEYS = ['latitude', 'longitude', 'location', 'accuracyMeters'] as const;

export const REDACTED = '[REDACTED]';

/**
 * pino redaction list (ARCHITECTURE §14). pino paths support one wildcard level per segment, so each
 * sensitive key is listed at the top level of a log call, one level down (`*.key`) and two levels down.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  'req.query.code',
  'req.query.state',
  ...[...SECRET_KEYS, ...LOCATION_KEYS].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, REDACTED],
  [
    /([?&#](?:invitation|token|code|state|nonce|session|sid|access_token|refresh_token|id_token|client_secret|code_verifier|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"'#<>]+/gi,
    `$1${REDACTED}`,
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  [/\b(__Host-ops_(?:sid|oidc)|ops_sid|ops_csrf)=[^;\s]+/g, `$1=${REDACTED}`],
  [/\b(lat(?:itude)?|lng|lon(?:gitude)?)(["']?\s*[:=]\s*)-?\d{1,3}\.\d{3,}/gi, `$1$2${REDACTED}`],
];

/**
 * Removes secrets that can hide inside free text: private keys, bearer tokens, JWTs, GitHub tokens,
 * sensitive URL parameters (invitations, OIDC code/state, pre-signed signatures), URL credentials,
 * session cookies and precise coordinates. Used for every log line and every CLI error message.
 */
export function redactSecrets(text: string): string {
  return PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

/** Error serializer: keeps type, message, stack and code, scrubbed; drops everything else. */
export function serializeErrorForLog(error: unknown): unknown {
  if (typeof error === 'string') return redactSecrets(error);
  if (typeof error !== 'object' || error === null) return error;
  // pino-http passes errors already turned into plain objects by pino's standard serializer.
  const text = (key: string): string | undefined => {
    const value: unknown = Reflect.get(error, key);
    return typeof value === 'string' ? redactSecrets(value) : undefined;
  };
  const code: unknown = Reflect.get(error, 'code');
  return {
    type: error instanceof Error ? error.name : text('type'),
    message: text('message'),
    stack: text('stack'),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}

function scrubArgument(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value instanceof Error) return serializeErrorForLog(value);
  return value;
}

/**
 * pino options shared by the API and the worker: key-based redaction plus free-text scrubbing of the
 * message and of errors, so a secret inside an exception message or a URL never reaches the log.
 */
export function pinoSecurityOptions(): {
  readonly redact: { readonly paths: string[]; readonly censor: string };
  readonly serializers: { readonly err: (error: unknown) => unknown };
  readonly hooks: { logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void): void };
} {
  return {
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    serializers: { err: serializeErrorForLog },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(scrubArgument));
      },
    },
  };
}
