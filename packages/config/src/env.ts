import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
const redisUrlSchema = z.url({ protocol: /^rediss?$/ });
const httpUrlSchema = z.url({ protocol: /^https?$/ });

/** Absolute http(s) origin or base URL without a trailing slash. */
const baseUrlSchema = httpUrlSchema.transform((value) => value.replace(/\/+$/, ''));

const originListSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(httpUrlSchema.transform((origin) => new URL(origin).origin)));

/** 32 random bytes, base64-encoded (AES-256 key, SECURITY §7). */
export const encryptionKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes, base64-encoded (44 characters)');

const keyIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);

/**
 * Retired encryption keys still accepted for decryption: `id:base64key` pairs separated by commas.
 * Envelopes written under them are re-encrypted with the current key on next use.
 */
const previousKeysSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf(':');
        return { id: entry.slice(0, separator), key: entry.slice(separator + 1) };
      }),
  )
  .pipe(z.array(z.object({ id: keyIdSchema, key: encryptionKeySchema })).max(5));

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

export const ATLASSIAN_AUTH_BASE_URL = 'https://auth.atlassian.com';
export const ATLASSIAN_API_BASE_URL = 'https://api.atlassian.com';

/**
 * Jira Cloud OAuth 2.0 (3LO) app (INTEGRATIONS §1.9). Unset client id = Jira integration disabled.
 * The base URLs exist for the deterministic test double and must be Atlassian's in production.
 */
const jiraEnvShape = {
  JIRA_OAUTH_CLIENT_ID: optionalText,
  JIRA_OAUTH_CLIENT_SECRET: optionalText,
  JIRA_AUTH_BASE_URL: baseUrlSchema.default(ATLASSIAN_AUTH_BASE_URL),
  JIRA_API_BASE_URL: baseUrlSchema.default(ATLASSIAN_API_BASE_URL),
};

interface JiraEnvFields {
  NODE_ENV: z.output<typeof nodeEnvSchema>;
  JIRA_OAUTH_CLIENT_ID?: string | undefined;
  JIRA_OAUTH_CLIENT_SECRET?: string | undefined;
  JIRA_AUTH_BASE_URL: string;
  JIRA_API_BASE_URL: string;
}

function refineJiraEnv(env: JiraEnvFields, ctx: z.core.$RefinementCtx): void {
  if ((env.JIRA_OAUTH_CLIENT_ID === undefined) !== (env.JIRA_OAUTH_CLIENT_SECRET === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JIRA_OAUTH_CLIENT_SECRET'],
      message: 'JIRA_OAUTH_CLIENT_ID and JIRA_OAUTH_CLIENT_SECRET go together',
    });
  }
  if (env.JIRA_OAUTH_CLIENT_SECRET !== undefined && env.JIRA_OAUTH_CLIENT_SECRET.length < 16) {
    ctx.addIssue({ code: 'custom', path: ['JIRA_OAUTH_CLIENT_SECRET'], message: 'must be at least 16 characters' });
  }
  if (env.NODE_ENV === 'production') {
    if (env.JIRA_AUTH_BASE_URL !== ATLASSIAN_AUTH_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['JIRA_AUTH_BASE_URL'],
        message: `must be ${ATLASSIAN_AUTH_BASE_URL} in production`,
      });
    }
    if (env.JIRA_API_BASE_URL !== ATLASSIAN_API_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['JIRA_API_BASE_URL'],
        message: `must be ${ATLASSIAN_API_BASE_URL} in production`,
      });
    }
  }
}

export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_WEB_BASE_URL = 'https://github.com';

/** PEM private key; `\n` escapes (single-line env values) are turned back into newlines. */
const optionalPem = optionalText
  .transform((value) => (value === undefined ? undefined : value.replace(/\\n/g, '\n')))
  .pipe(
    z
      .string()
      .regex(
        /^-----BEGIN (RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (RSA )?PRIVATE KEY-----\s*$/,
        'must be a PEM private key',
      )
      .optional(),
  );

/**
 * GitHub App (INTEGRATIONS §2, ADR-0020). Unset app id = GitHub integration disabled; otherwise every
 * credential the process needs must be present. The base URLs exist for the deterministic test double
 * and must be GitHub.com's in production.
 */
const githubAppShape = {
  GITHUB_APP_ID: optionalText.pipe(
    z
      .string()
      .regex(/^[0-9]{1,20}$/, 'must be a numeric app id')
      .optional(),
  ),
  GITHUB_APP_CLIENT_ID: optionalText.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/, 'must be the app client id')
      .optional(),
  ),
  GITHUB_APP_PRIVATE_KEY: optionalPem,
  GITHUB_API_BASE_URL: baseUrlSchema.default(GITHUB_API_BASE_URL),
};

const githubApiShape = {
  ...githubAppShape,
  GITHUB_APP_SLUG: optionalText.pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'must be the app slug')
      .optional(),
  ),
  GITHUB_APP_CLIENT_SECRET: optionalText,
  GITHUB_WEBHOOK_SECRET: optionalText,
  GITHUB_WEB_BASE_URL: baseUrlSchema.default(GITHUB_WEB_BASE_URL),
  /** Raw webhook body cap; GitHub caps payloads at 25 MB. */
  GITHUB_WEBHOOK_MAX_BYTES: z.coerce.number().int().min(1024).max(26_214_400).default(5_242_880),
};

interface GithubEnvFields {
  NODE_ENV: z.output<typeof nodeEnvSchema>;
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_CLIENT_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
  GITHUB_API_BASE_URL: string;
  GITHUB_APP_SLUG?: string | undefined;
  GITHUB_APP_CLIENT_SECRET?: string | undefined;
  GITHUB_WEBHOOK_SECRET?: string | undefined;
  GITHUB_WEB_BASE_URL?: string | undefined;
}

function refineGithubEnv(env: GithubEnvFields, ctx: z.core.$RefinementCtx, scope: 'api' | 'worker'): void {
  const required: (keyof GithubEnvFields)[] =
    scope === 'api'
      ? [
          'GITHUB_APP_ID',
          'GITHUB_APP_CLIENT_ID',
          'GITHUB_APP_PRIVATE_KEY',
          'GITHUB_APP_SLUG',
          'GITHUB_APP_CLIENT_SECRET',
          'GITHUB_WEBHOOK_SECRET',
        ]
      : ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_PRIVATE_KEY'];
  const present = required.filter((name) => env[name] !== undefined);
  if (present.length > 0 && present.length < required.length) {
    for (const name of required.filter((n) => env[n] === undefined)) {
      ctx.addIssue({ code: 'custom', path: [name], message: `is required when any of ${required.join(', ')} is set` });
    }
  }
  for (const name of ['GITHUB_APP_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET'] as const) {
    const value = env[name];
    if (value !== undefined && value.length < 16) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'must be at least 16 characters' });
    }
  }
  if (env.NODE_ENV === 'production') {
    if (env.GITHUB_API_BASE_URL !== GITHUB_API_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_API_BASE_URL'],
        message: `must be ${GITHUB_API_BASE_URL} in production`,
      });
    }
    if (env.GITHUB_WEB_BASE_URL !== undefined && env.GITHUB_WEB_BASE_URL !== GITHUB_WEB_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_WEB_BASE_URL'],
        message: `must be ${GITHUB_WEB_BASE_URL} in production`,
      });
    }
  }
}

/** Values from `.env.example`, documentation and common defaults; never acceptable in production. */
const PLACEHOLDER_PATTERN =
  /__SECRET:|__KEY32:|change[-_ ]?me|replace[-_ ]?(me|with)|placeholder|example|dummy|not[-_]?a[-_]?secret|^(password|secret|admin|postgres|redis|minioadmin|test|dev|development)$/i;

/** Documentation and reserved names (RFC 2606/6761) that are never a deployment's public host. */
const DOCUMENTATION_HOST = /(^|\.)(example\.(com|net|org)|example|invalid|localhost)$/i;

function isWeakSecret(value: string): boolean {
  if (PLACEHOLDER_PATTERN.test(value)) return true;
  // A single repeated character or very few distinct characters is not a secret.
  return new Set(value).size < Math.min(8, value.length);
}

/** An AES key whose 32 bytes use fewer than 16 distinct values was not drawn from a random source. */
function isWeakEncryptionKey(base64: string): boolean {
  return new Set(Buffer.from(base64, 'base64')).size < 16;
}

function urlPassword(value: string): { user: string; password: string } {
  const url = new URL(value);
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

interface ProductionFields {
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly APP_PUBLIC_URL: string;
  readonly APP_ENCRYPTION_KEY?: string | undefined;
  readonly APP_ENCRYPTION_KEYS_PREVIOUS: readonly { readonly id: string; readonly key: string }[];
  readonly S3_ACCESS_KEY_ID: string;
  readonly S3_SECRET_ACCESS_KEY: string;
  readonly S3_PUBLIC_ENDPOINT?: string | undefined;
  readonly S3_ENDPOINT?: string | undefined;
  readonly JIRA_OAUTH_CLIENT_SECRET?: string | undefined;
  readonly GITHUB_APP_CLIENT_SECRET?: string | undefined;
  readonly GITHUB_WEBHOOK_SECRET?: string | undefined;
}

/**
 * Production-only checks shared by the API and the worker (SECURITY §8): no placeholder or weak
 * secrets, credentials on every data store, the runtime database role is not a superuser name, the
 * public origin is a real https host, and browsers only see https storage endpoints. Messages name the
 * variable, never the value.
 */
function refineProductionCommon(env: ProductionFields, ctx: z.core.$RefinementCtx): void {
  const issue = (path: string, message: string) => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };
  const db = urlPassword(env.DATABASE_URL);
  if (db.password === '') issue('DATABASE_URL', 'must include a password in production');
  else if (isWeakSecret(db.password)) issue('DATABASE_URL', 'the password is a placeholder or too weak');
  if (db.user === 'postgres') issue('DATABASE_URL', 'must use the runtime role (ops_app), not the postgres superuser');
  const redis = urlPassword(env.REDIS_URL);
  if (redis.password === '') issue('REDIS_URL', 'must include a password in production');
  else if (isWeakSecret(redis.password)) issue('REDIS_URL', 'the password is a placeholder or too weak');
  const publicHost = new URL(env.APP_PUBLIC_URL).hostname;
  if (LOCAL_HOSTS.test(publicHost) || DOCUMENTATION_HOST.test(publicHost)) {
    issue('APP_PUBLIC_URL', 'must be the public host name in production, not a loopback or example address');
  }
  if (PLACEHOLDER_PATTERN.test(env.S3_ACCESS_KEY_ID)) issue('S3_ACCESS_KEY_ID', 'is a placeholder');
  if (env.APP_ENCRYPTION_KEY !== undefined && isWeakEncryptionKey(env.APP_ENCRYPTION_KEY)) {
    issue('APP_ENCRYPTION_KEY', 'is not random (generate it with `openssl rand -base64 32`)');
  }
  if (env.APP_ENCRYPTION_KEYS_PREVIOUS.some((entry) => isWeakEncryptionKey(entry.key))) {
    issue('APP_ENCRYPTION_KEYS_PREVIOUS', 'contains a key that is not random');
  }
  if (isWeakSecret(env.S3_SECRET_ACCESS_KEY)) issue('S3_SECRET_ACCESS_KEY', 'is a placeholder or too weak');
  const browserStorage = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
  if (browserStorage !== undefined && !browserStorage.startsWith('https://')) {
    issue(
      env.S3_PUBLIC_ENDPOINT === undefined ? 'S3_ENDPOINT' : 'S3_PUBLIC_ENDPOINT',
      'must use https in production (browsers upload to it)',
    );
  }
  for (const name of ['JIRA_OAUTH_CLIENT_SECRET', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET'] as const) {
    const value = env[name];
    if (value !== undefined && isWeakSecret(value)) issue(name, 'is a placeholder or too weak');
  }
}

const minutes = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const perMinute = (fallback: number) => z.coerce.number().int().min(1).max(100_000).default(fallback);

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  /** Browser-reachable endpoint used only in pre-signed URLs (defaults to S3_ENDPOINT). */
  S3_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3).max(63),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

export type StorageEnv = z.output<typeof storageEnvSchema>;

export const apiEnvSchema = z
  .object({
    ...storageEnvSchema.shape,
    NODE_ENV: nodeEnvSchema.default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    /**
     * Internal Prometheus listener (ADR-0024); 0 disables it. Bind it to the private network only
     * (`0.0.0.0` inside a container whose port is not published); the reverse proxy never routes it.
     */
    API_OPS_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
    API_OPS_HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: logLevelSchema.default('info'),
    DATABASE_URL: postgresUrlSchema,
    REDIS_URL: redisUrlSchema,
    SWAGGER_ENABLED: z.stringbool().default(false),

    /** Browser-facing origin of the deployment (web and API are same-site, ARCHITECTURE §6). */
    APP_PUBLIC_URL: baseUrlSchema,
    /** Additional allowed browser origins for CORS and CSRF Origin checks. Empty = same-origin only. */
    CORS_ORIGINS: originListSchema,
    /** Number of reverse-proxy hops whose X-Forwarded-* headers are trusted. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    OIDC_ISSUER: baseUrlSchema,
    OIDC_CLIENT_ID: z.string().min(1).default('ops-api'),
    OIDC_CLIENT_SECRET: z.string().min(16),
    /** Development only: allow an http:// issuer (local Keycloak). Rejected in production. */
    OIDC_ALLOW_INSECURE_HTTP: z.stringbool().default(false),

    APP_ENCRYPTION_KEY: encryptionKeySchema,
    APP_ENCRYPTION_KEY_ID: keyIdSchema.default('k1'),
    APP_ENCRYPTION_KEYS_PREVIOUS: previousKeysSchema,

    ...jiraEnvShape,
    ...githubApiShape,

    SESSION_IDLE_TIMEOUT_MINUTES: minutes(5, 240, 30),
    SESSION_ABSOLUTE_TIMEOUT_MINUTES: minutes(60, 1440, 720),
    /** Maximum age of an MFA authentication before privileged endpoints require step-up again. */
    MFA_MAX_AGE_MINUTES: minutes(1, 1440, 720),

    /** Every request, per client IP (SECURITY §5). */
    RATE_LIMIT_DEFAULT_PER_MINUTE: perMinute(300),
    /** Sign-in, callback and logout, per client IP. */
    RATE_LIMIT_AUTH_PER_MINUTE: perMinute(20),
    /** Authenticated requests, per user (independent of IP). */
    RATE_LIMIT_USER_PER_MINUTE: perMinute(240),
    /** Sensitive operations (role changes, member status, invitations, settings), per user. */
    RATE_LIMIT_SENSITIVE_PER_MINUTE: perMinute(20),
    /** Attachment upload intents, per user. */
    RATE_LIMIT_UPLOAD_PER_MINUTE: perMinute(30),
    /** Requests that call Jira live (search, issue types, link, create), per user; protects the shared Jira quota. */
    RATE_LIMIT_JIRA_PER_MINUTE: perMinute(30),
    /** Requests that call GitHub live or queue GitHub work (setup, resync), per user; protects the app quota. */
    RATE_LIMIT_GITHUB_PER_MINUTE: perMinute(30),
    /** Attendance check-in and check-out, per user (SECURITY §5: 10/min/user). */
    RATE_LIMIT_ATTENDANCE_PER_MINUTE: perMinute(10),
    /** Global search, per user (Phase 8); the palette debounces typing, so one lookup is a few requests. */
    RATE_LIMIT_SEARCH_PER_MINUTE: perMinute(60),
    /** Inbound webhooks (Phase 2+), per source; separate from user traffic. */
    RATE_LIMIT_WEBHOOK_PER_MINUTE: perMinute(600),
  })
  .superRefine((env, ctx) => {
    refineJiraEnv(env, ctx);
    refineGithubEnv(env, ctx, 'api');
    if (env.APP_ENCRYPTION_KEYS_PREVIOUS.some((k) => k.id === env.APP_ENCRYPTION_KEY_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEYS_PREVIOUS'],
        message: 'must not repeat the current key id',
      });
    }
    if (env.OIDC_ISSUER.startsWith('http://') && !env.OIDC_ALLOW_INSECURE_HTTP) {
      ctx.addIssue({
        code: 'custom',
        path: ['OIDC_ISSUER'],
        message: 'an http:// issuer requires OIDC_ALLOW_INSECURE_HTTP=true (development only)',
      });
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    if (env.OIDC_ALLOW_INSECURE_HTTP) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ALLOW_INSECURE_HTTP'], message: 'must be false in production' });
    }
    if (!env.APP_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_PUBLIC_URL'], message: 'must use https in production' });
    }
    refineProductionCommon(env, ctx);
    if (isWeakSecret(env.OIDC_CLIENT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_CLIENT_SECRET'], message: 'is a placeholder or too weak' });
    }
    if (env.SWAGGER_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_ENABLED'],
        message: 'must be false in production (the API description is published from CI instead)',
      });
    }
    if (env.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'every origin must use https in production' });
    }
    if (env.TRUST_PROXY_HOPS > 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message: 'more than 3 trusted proxies is almost certainly wrong and lets clients choose their address',
      });
    }
  });

export type ApiEnv = z.output<typeof apiEnvSchema>;

export const workerEnvSchema = z
  .object({
    ...storageEnvSchema.shape,
    NODE_ENV: nodeEnvSchema.default('development'),
    LOG_LEVEL: logLevelSchema.default('info'),
    /** Internal health and metrics listener (ADR-0024): `/health/live`, `/health/ready`, `/metrics`; 0 disables it. */
    WORKER_OPS_PORT: z.coerce.number().int().min(0).max(65_535).default(4001),
    WORKER_OPS_HOST: z.string().min(1).default('127.0.0.1'),
    DATABASE_URL: postgresUrlSchema,
    REDIS_URL: redisUrlSchema,
    /** Outbox relay (ARCHITECTURE §3): poll interval, batch size, lease and attempts before giving up. */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
    /** Attempts per queue job (exponential backoff) before it is kept as failed. */
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
    /** Base URL for links in emails (the browser-facing origin). */
    APP_PUBLIC_URL: baseUrlSchema,
    /** SMTP relay (Mailpit in development). Unset host = email disabled; deliveries are recorded as SKIPPED. */
    SMTP_HOST: optionalText,
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /** true = implicit TLS (port 465); false = STARTTLS when the server offers it. */
    SMTP_SECURE: z.stringbool().default(false),
    SMTP_FROM: optionalText.pipe(z.email().optional()),
    SMTP_USER: optionalText,
    SMTP_PASSWORD: optionalText,
    /** SLA sweep interval (`sla.sweep`). */
    SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
    /** Approval reminder sweep interval (`request.sla.sweep`). */
    REQUEST_SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
    /** Missing check-out sweep interval (`attendance.missing-checkout.sweep`). */
    ATTENDANCE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
    /** Tender, contract, guarantee and corporate document monitor interval (`commercial.monitor`). */
    COMMERCIAL_MONITOR_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),

    /** Same keys as the API; needed only for the Jira integration (token use and refresh). */
    APP_ENCRYPTION_KEY: optionalText.pipe(encryptionKeySchema.optional()),
    APP_ENCRYPTION_KEY_ID: keyIdSchema.default('k1'),
    APP_ENCRYPTION_KEYS_PREVIOUS: previousKeysSchema,
    ...jiraEnvShape,
    /** Incremental reconciliation (`updated` since the last pass, with overlap). */
    JIRA_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
    /** Deep reconciliation (deletions, moves, count drift). */
    JIRA_DEEP_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(3_600_000).max(2_592_000_000).default(604_800_000),
    /** Webhook registration upkeep (refresh before the 30-day expiry, re-register on mapping changes). */
    JIRA_WEBHOOK_REFRESH_INTERVAL_MS: z.coerce.number().int().min(60_000).max(604_800_000).default(86_400_000),
    ...githubAppShape,
    /** Incremental pull-request reconciliation per mapped repository (`updated` since the last pass). */
    GITHUB_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(1_800_000),
    /** Installation and repository-access refresh (catches missed installation events). */
    GITHUB_INSTALLATION_SYNC_INTERVAL_MS: z.coerce.number().int().min(300_000).max(604_800_000).default(21_600_000),
    /** Closed/merged pull requests imported by the initial sync (open ones are always imported). */
    GITHUB_PR_HISTORY_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    /** Retention purge cadence and per-organization, per-category batch (only where a policy exists). */
    RETENTION_PURGE_INTERVAL_MS: z.coerce.number().int().min(300_000).max(604_800_000).default(86_400_000),
    RETENTION_PURGE_BATCH_SIZE: z.coerce.number().int().min(100).max(5_000).default(1_000),
  })
  .superRefine((env, ctx) => {
    refineJiraEnv(env, ctx);
    refineGithubEnv(env, ctx, 'worker');
    if (env.JIRA_OAUTH_CLIENT_ID !== undefined && env.APP_ENCRYPTION_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEY'],
        message: 'is required when JIRA_OAUTH_CLIENT_ID is set',
      });
    }
    if (env.GITHUB_APP_ID !== undefined && env.APP_ENCRYPTION_KEY === undefined) {
      ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_KEY'], message: 'is required when GITHUB_APP_ID is set' });
    }
    if (env.SMTP_HOST !== undefined && env.SMTP_FROM === undefined) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'is required when SMTP_HOST is set' });
    }
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'SMTP_USER and SMTP_PASSWORD go together' });
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    if (!env.APP_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_PUBLIC_URL'], message: 'must use https in production' });
    }
    refineProductionCommon(env, ctx);
    if (env.SMTP_HOST !== undefined && (/mailpit|mailhog/i.test(env.SMTP_HOST) || env.SMTP_PORT === 1025)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'points at a development mail catcher; configure the production SMTP relay or leave it empty',
      });
    }
    if (env.SMTP_PASSWORD !== undefined && isWeakSecret(env.SMTP_PASSWORD)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'is a placeholder or too weak' });
    }
  });

export type WorkerEnv = z.output<typeof workerEnvSchema>;

/**
 * Development seed (ROADMAP P1-4). Runs only when NODE_ENV is not production AND ALLOW_DEMO_SEED is
 * explicitly true; both conditions are re-checked by the seed itself.
 */
export const seedEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  ALLOW_DEMO_SEED: z.stringbool().default(false),
  DATABASE_URL: postgresUrlSchema,
  OIDC_ISSUER: baseUrlSchema,
});

export type SeedEnv = z.output<typeof seedEnvSchema>;

/** First-run bootstrap CLI (ROADMAP P1-5). Allowed in production, but only with explicit confirmation. */
export const bootstrapEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  DATABASE_URL: postgresUrlSchema,
  /** Used only to print the invitation link. */
  APP_PUBLIC_URL: baseUrlSchema,
});

export type BootstrapEnv = z.output<typeof bootstrapEnvSchema>;

/** Operator maintenance commands (for example the project activity rebuild). */
export const maintenanceEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  DATABASE_URL: postgresUrlSchema,
});

export type MaintenanceEnv = z.output<typeof maintenanceEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    super(`Invalid ${scope} environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables against a schema. Error messages list variable names and
 * the failed rule only; received values are never included because they may be secrets.
 */
export function parseEnv<TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  source: Readonly<Record<string, string | undefined>>,
): z.output<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  throw new EnvValidationError(scope, issues);
}
