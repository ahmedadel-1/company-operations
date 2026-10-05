import { describe, expect, it } from 'vitest';

import {
  apiEnvSchema,
  EnvValidationError,
  FILE_BACKED_SECRETS,
  parseEnv,
  resolveSecretFiles,
  storageEnvSchema,
  workerEnvSchema,
} from '../src/index.js';

const exampleKey = Buffer.alloc(32, 7).toString('base64');

const validApiEnv = {
  DATABASE_URL: 'postgresql://ops_app:example@localhost:5432/company_ops',
  REDIS_URL: 'redis://:example@localhost:6379',
  APP_PUBLIC_URL: 'https://ops.example.test/',
  OIDC_ISSUER: 'https://id.example.test/realms/company-ops',
  OIDC_CLIENT_SECRET: 'example-client-secret',
  APP_ENCRYPTION_KEY: exampleKey,
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'company-ops-dev',
  S3_ACCESS_KEY_ID: 'example-access-key',
  S3_SECRET_ACCESS_KEY: 'example-secret-key',
};

describe('apiEnvSchema', () => {
  it('applies defaults for optional variables', () => {
    const env = parseEnv('api', apiEnvSchema, validApiEnv);
    expect(env).toEqual({
      ...validApiEnv,
      APP_PUBLIC_URL: 'https://ops.example.test',
      NODE_ENV: 'development',
      API_PORT: 4000,
      API_OPS_PORT: 0,
      API_OPS_HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: false,
      CORS_ORIGINS: [],
      TRUST_PROXY_HOPS: 0,
      OIDC_CLIENT_ID: 'ops-api',
      OIDC_ALLOW_INSECURE_HTTP: false,
      APP_ENCRYPTION_KEY_ID: 'k1',
      APP_ENCRYPTION_KEYS_PREVIOUS: [],
      JIRA_OAUTH_CLIENT_ID: undefined,
      JIRA_OAUTH_CLIENT_SECRET: undefined,
      JIRA_AUTH_BASE_URL: 'https://auth.atlassian.com',
      JIRA_API_BASE_URL: 'https://api.atlassian.com',
      SESSION_IDLE_TIMEOUT_MINUTES: 30,
      SESSION_ABSOLUTE_TIMEOUT_MINUTES: 720,
      MFA_MAX_AGE_MINUTES: 720,
      RATE_LIMIT_DEFAULT_PER_MINUTE: 300,
      RATE_LIMIT_AUTH_PER_MINUTE: 20,
      RATE_LIMIT_USER_PER_MINUTE: 240,
      RATE_LIMIT_SENSITIVE_PER_MINUTE: 20,
      RATE_LIMIT_UPLOAD_PER_MINUTE: 30,
      RATE_LIMIT_JIRA_PER_MINUTE: 30,
      RATE_LIMIT_GITHUB_PER_MINUTE: 30,
      RATE_LIMIT_ATTENDANCE_PER_MINUTE: 10,
      RATE_LIMIT_SEARCH_PER_MINUTE: 60,
      RATE_LIMIT_WEBHOOK_PER_MINUTE: 600,
      GITHUB_API_BASE_URL: 'https://api.github.com',
      GITHUB_WEB_BASE_URL: 'https://github.com',
      GITHUB_WEBHOOK_MAX_BYTES: 5_242_880,
      S3_FORCE_PATH_STYLE: false,
    });
  });

  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEexample\n-----END PRIVATE KEY-----';
  const github = {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_CLIENT_ID: 'Iv23liExample',
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_APP_SLUG: 'company-ops',
    GITHUB_APP_CLIENT_SECRET: 'example-client-secret-0123',
    GITHUB_WEBHOOK_SECRET: 'example-webhook-secret-0123',
  };

  it('requires the complete GitHub App configuration once any part is set', () => {
    const env = parseEnv('api', apiEnvSchema, { ...validApiEnv, ...github });
    expect(env.GITHUB_APP_ID).toBe('123456');
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(pem);
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, GITHUB_APP_ID: '123456' })).toThrow(
      /GITHUB_WEBHOOK_SECRET: is required/,
    );
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, ...github, GITHUB_WEBHOOK_SECRET: 'short' })).toThrow(
      /GITHUB_WEBHOOK_SECRET: must be at least 16 characters/,
    );
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, ...github, GITHUB_APP_ID: 'abc' })).toThrow(
      /GITHUB_APP_ID/,
    );
  });

  it('accepts single-line PEM values and rejects anything that is not a private key, without echoing it', () => {
    const inline = pem.replace(/\n/g, '\\n');
    expect(
      parseEnv('api', apiEnvSchema, { ...validApiEnv, ...github, GITHUB_APP_PRIVATE_KEY: inline })
        .GITHUB_APP_PRIVATE_KEY,
    ).toBe(pem);
    try {
      parseEnv('api', apiEnvSchema, { ...validApiEnv, ...github, GITHUB_APP_PRIVATE_KEY: 'ghp_notakey123456' }); // gitleaks:allow
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(String(error)).toContain('GITHUB_APP_PRIVATE_KEY');
      expect(String(error)).not.toContain('ghp_notakey123456');
    }
  });

  it('pins the GitHub base URLs in production and caps the webhook body', () => {
    const fake = { ...validApiEnv, ...github, GITHUB_API_BASE_URL: 'http://127.0.0.1:9999' };
    expect(parseEnv('api', apiEnvSchema, fake).GITHUB_API_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(() => parseEnv('api', apiEnvSchema, { ...fake, NODE_ENV: 'production' })).toThrow(/GITHUB_API_BASE_URL/);
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...validApiEnv, GITHUB_WEBHOOK_MAX_BYTES: String(30 * 1024 * 1024) }),
    ).toThrow(/GITHUB_WEBHOOK_MAX_BYTES/);
  });

  it('normalizes CORS origins and rejects non-URL entries', () => {
    const env = parseEnv('api', apiEnvSchema, {
      ...validApiEnv,
      CORS_ORIGINS: 'https://a.example.test/, https://b.example.test:8443',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example.test', 'https://b.example.test:8443']);
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
  });

  it('requires an explicit opt-in for an http issuer and forbids it in production', () => {
    const httpIssuer = { ...validApiEnv, OIDC_ISSUER: 'http://localhost:8080/realms/company-ops' };
    expect(() => parseEnv('api', apiEnvSchema, httpIssuer)).toThrow(/OIDC_ALLOW_INSECURE_HTTP=true/);
    expect(
      parseEnv('api', apiEnvSchema, { ...httpIssuer, OIDC_ALLOW_INSECURE_HTTP: 'true' }).OIDC_ALLOW_INSECURE_HTTP,
    ).toBe(true);
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...httpIssuer, OIDC_ALLOW_INSECURE_HTTP: 'true', NODE_ENV: 'production' }),
    ).toThrow(/OIDC_ALLOW_INSECURE_HTTP: must be false in production/);
  });

  it('rejects insecure OIDC and a non-https public URL in production', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, {
        ...validApiEnv,
        NODE_ENV: 'production',
        OIDC_ISSUER: 'http://id.example.test/realms/x',
        OIDC_ALLOW_INSECURE_HTTP: 'true',
      }),
    ).toThrow(/OIDC_ALLOW_INSECURE_HTTP/);
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production', APP_PUBLIC_URL: 'http://ops.test' }),
    ).toThrow(/APP_PUBLIC_URL/);
  });

  it('rejects an encryption key that is not 32 bytes of base64', () => {
    expect(() =>
      parseEnv('api', apiEnvSchema, { ...validApiEnv, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it('parses retired encryption keys for rotation and rejects malformed or duplicate ones', () => {
    const old = Buffer.alloc(32, 9).toString('base64');
    const env = parseEnv('api', apiEnvSchema, { ...validApiEnv, APP_ENCRYPTION_KEYS_PREVIOUS: ` k0:${old} ` });
    expect(env.APP_ENCRYPTION_KEYS_PREVIOUS).toEqual([{ id: 'k0', key: old }]);
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, APP_ENCRYPTION_KEYS_PREVIOUS: 'k0:short' })).toThrow(
      /APP_ENCRYPTION_KEYS_PREVIOUS/,
    );
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, APP_ENCRYPTION_KEYS_PREVIOUS: `k1:${old}` })).toThrow(
      /must not repeat the current key id/,
    );
  });

  it('pairs the Jira client credentials and pins the Atlassian base URLs in production', () => {
    const jira = { JIRA_OAUTH_CLIENT_ID: 'client-id', JIRA_OAUTH_CLIENT_SECRET: 'client-secret-0123456789' };
    expect(parseEnv('api', apiEnvSchema, { ...validApiEnv, ...jira }).JIRA_OAUTH_CLIENT_ID).toBe('client-id');
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, JIRA_OAUTH_CLIENT_ID: 'client-id' })).toThrow(
      /go together/,
    );
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, ...jira, JIRA_OAUTH_CLIENT_SECRET: 'short' })).toThrow(
      /at least 16/,
    );
    const fake = { ...validApiEnv, ...jira, JIRA_API_BASE_URL: 'http://127.0.0.1:9999' };
    expect(parseEnv('api', apiEnvSchema, fake).JIRA_API_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(() => parseEnv('api', apiEnvSchema, { ...fake, NODE_ENV: 'production' })).toThrow(/JIRA_API_BASE_URL/);
  });

  it('parses string flags and numeric ports', () => {
    const env = parseEnv('api', apiEnvSchema, { ...validApiEnv, API_PORT: '4100', SWAGGER_ENABLED: 'true' });
    expect(env.API_PORT).toBe(4100);
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(() => parseEnv('api', apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      EnvValidationError,
    );
  });

  it('reports missing variables by name without echoing values', () => {
    const secret = 'super-secret-value';
    try {
      parseEnv('api', apiEnvSchema, { DATABASE_URL: secret });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).not.toContain(secret);
    }
  });
});

describe('workerEnvSchema', () => {
  it('requires the database, Redis and storage', () => {
    expect(() => parseEnv('worker', workerEnvSchema, {})).toThrow(EnvValidationError);
    try {
      parseEnv('worker', workerEnvSchema, {});
    } catch (error) {
      const message = (error as EnvValidationError).message;
      for (const name of ['DATABASE_URL', 'REDIS_URL', 'S3_BUCKET']) {
        expect(message).toContain(name);
      }
    }
  });

  const baseWorkerEnv = {
    DATABASE_URL: validApiEnv.DATABASE_URL,
    REDIS_URL: validApiEnv.REDIS_URL,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'company-ops-dev',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'b',
    APP_PUBLIC_URL: 'http://localhost:3000/',
  };

  it('applies outbox relay defaults and disables email without an SMTP host', () => {
    const env = parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, SMTP_HOST: '', SMTP_FROM: '' });
    expect(env).toMatchObject({
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_BATCH_SIZE: 50,
      OUTBOX_LEASE_MS: 30_000,
      OUTBOX_MAX_ATTEMPTS: 10,
      JOB_MAX_ATTEMPTS: 5,
      SLA_SWEEP_INTERVAL_MS: 60_000,
      APP_PUBLIC_URL: 'http://localhost:3000',
    });
    expect(env.SMTP_HOST).toBeUndefined();
  });

  it('requires a sender with an SMTP host and paired SMTP credentials', () => {
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, SMTP_HOST: 'localhost' })).toThrow(
      /SMTP_FROM/,
    );
    expect(() =>
      parseEnv('worker', workerEnvSchema, {
        ...baseWorkerEnv,
        SMTP_HOST: 'localhost',
        SMTP_FROM: 'ops@example.test',
        SMTP_USER: 'user',
      }),
    ).toThrow(/SMTP_PASSWORD/);
    const env = parseEnv('worker', workerEnvSchema, {
      ...baseWorkerEnv,
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_FROM: 'ops@example.test',
    });
    expect(env).toMatchObject({ SMTP_HOST: 'localhost', SMTP_PORT: 1025, SMTP_SECURE: false });
  });

  it('needs the encryption key only when Jira is configured', () => {
    const env = parseEnv('worker', workerEnvSchema, baseWorkerEnv);
    expect(env).toMatchObject({ JIRA_RECONCILE_INTERVAL_MS: 3_600_000, JIRA_WEBHOOK_REFRESH_INTERVAL_MS: 86_400_000 });
    expect(env.APP_ENCRYPTION_KEY).toBeUndefined();
    const jira = { JIRA_OAUTH_CLIENT_ID: 'client-id', JIRA_OAUTH_CLIENT_SECRET: 'client-secret-0123456789' };
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, ...jira })).toThrow(/APP_ENCRYPTION_KEY/);
    expect(
      parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, ...jira, APP_ENCRYPTION_KEY: exampleKey })
        .APP_ENCRYPTION_KEY,
    ).toBe(exampleKey);
  });

  it('requires an https public URL in production', () => {
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, NODE_ENV: 'production' })).toThrow(
      /APP_PUBLIC_URL/,
    );
  });

  it('needs only the App id, client id, private key and encryption key for GitHub, with bounded schedules', () => {
    const github = {
      GITHUB_APP_ID: '123456',
      GITHUB_APP_CLIENT_ID: 'Iv23liExample',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEexample\n-----END PRIVATE KEY-----',
    };
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, ...github })).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, GITHUB_APP_ID: '123456' })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
    const env = parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, ...github, APP_ENCRYPTION_KEY: exampleKey });
    expect(env).toMatchObject({
      GITHUB_RECONCILE_INTERVAL_MS: 1_800_000,
      GITHUB_INSTALLATION_SYNC_INTERVAL_MS: 21_600_000,
      GITHUB_PR_HISTORY_DAYS: 90,
      RETENTION_PURGE_INTERVAL_MS: 86_400_000,
      RETENTION_PURGE_BATCH_SIZE: 1_000,
    });
    expect(() => parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, GITHUB_PR_HISTORY_DAYS: '0' })).toThrow(
      /GITHUB_PR_HISTORY_DAYS/,
    );
    expect(() =>
      parseEnv('worker', workerEnvSchema, { ...baseWorkerEnv, RETENTION_PURGE_BATCH_SIZE: '50000' }),
    ).toThrow(/RETENTION_PURGE_BATCH_SIZE/);
  });
});

describe('resolveSecretFiles', () => {
  const files: Record<string, string> = {
    '/run/secrets/github-key': '-----BEGIN PRIVATE KEY-----\r\nMIIEexample\r\n-----END PRIVATE KEY-----\r\n', // gitleaks:allow
    '/run/secrets/webhook': 'file-webhook-secret-0123\n',
  };
  const read = (path: string): string => {
    const value = files[path];
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return value;
  };

  it('reads <NAME>_FILE secrets, normalizes line endings and drops the _FILE variable', () => {
    const resolved = resolveSecretFiles(
      'api',
      { GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-key', GITHUB_WEBHOOK_SECRET_FILE: '/run/secrets/webhook' },
      read,
    );
    expect(resolved.GITHUB_APP_PRIVATE_KEY).toBe('-----BEGIN PRIVATE KEY-----\nMIIEexample\n-----END PRIVATE KEY-----');
    expect(resolved.GITHUB_WEBHOOK_SECRET).toBe('file-webhook-secret-0123');
    expect(resolved.GITHUB_APP_PRIVATE_KEY_FILE).toBeUndefined();
  });

  it('rejects both forms, unreadable and oversized files without echoing paths or contents', () => {
    const attempt = (source: Record<string, string>) => {
      try {
        resolveSecretFiles('api', source, (path) => (path === '/big' ? 'x'.repeat(70 * 1024) : read(path)));
        return '';
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        return String(error);
      }
    };
    const both = attempt({
      GITHUB_WEBHOOK_SECRET: 'inline-value-0123456',
      GITHUB_WEBHOOK_SECRET_FILE: '/run/secrets/webhook',
    });
    expect(both).toMatch(/set either GITHUB_WEBHOOK_SECRET or GITHUB_WEBHOOK_SECRET_FILE/);
    expect(both).not.toContain('inline-value-0123456');
    const missing = attempt({ GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/nope' });
    expect(missing).toMatch(/GITHUB_APP_PRIVATE_KEY_FILE: the file cannot be read/);
    expect(missing).not.toContain('/run/secrets/nope');
    expect(attempt({ GITHUB_APP_CLIENT_SECRET_FILE: '/big' })).toMatch(/larger than/);
  });

  it('ignores _FILE variables for names that are not file-backed', () => {
    const resolved = resolveSecretFiles('api', { LOG_LEVEL_FILE: '/run/secrets/webhook' }, read);
    expect(resolved.LOG_LEVEL).toBeUndefined();
    expect(FILE_BACKED_SECRETS).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('covers every secret the apps read, including the data store URLs that carry passwords', () => {
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'OIDC_CLIENT_SECRET',
      'APP_ENCRYPTION_KEY',
      'APP_ENCRYPTION_KEYS_PREVIOUS',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'SMTP_PASSWORD',
      'JIRA_OAUTH_CLIENT_SECRET',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_WEBHOOK_SECRET',
    ]) {
      expect(FILE_BACKED_SECRETS).toContain(name);
    }
  });
});

describe('production configuration', () => {
  const strongKey = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256)).toString('base64');
  const productionApi = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://ops_app:Zq8vT3nLw1Rk9Pd2@db:5432/company_ops',
    REDIS_URL: 'redis://:Hx4mB7cQ2sV9eK1u@redis:6379',
    APP_PUBLIC_URL: 'https://ops.acme.test',
    OIDC_ISSUER: 'https://ops.acme.test/auth/realms/company-ops',
    OIDC_CLIENT_SECRET: 'Gm2Tq8Xr5Lb1Nv7Wc4Zp', // gitleaks:allow
    APP_ENCRYPTION_KEY: strongKey,
    S3_REGION: 'eu-central-1',
    S3_BUCKET: 'ops-files',
    S3_ACCESS_KEY_ID: 'ops-access',
    S3_SECRET_ACCESS_KEY: 'Pk3Wd9Hs1Fy6Jq2Tb8Ln', // gitleaks:allow
    TRUST_PROXY_HOPS: '1',
  };

  it('accepts a complete production configuration', () => {
    expect(parseEnv('api', apiEnvSchema, productionApi).NODE_ENV).toBe('production');
  });

  it.each([
    ['a placeholder OIDC secret', { OIDC_CLIENT_SECRET: '__SECRET:OIDC_CLIENT_SECRET__' }, /OIDC_CLIENT_SECRET/],
    ['a weak OIDC secret', { OIDC_CLIENT_SECRET: 'aaaaaaaaaaaaaaaaaaaa' }, /OIDC_CLIENT_SECRET/],
    [
      'a non-random encryption key',
      { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
      /APP_ENCRYPTION_KEY/,
    ],
    ['a database URL without password', { DATABASE_URL: 'postgresql://ops_app@db:5432/company_ops' }, /DATABASE_URL/],
    [
      'the postgres superuser',
      { DATABASE_URL: 'postgresql://postgres:Zq8vT3nLw1Rk9Pd2@db/company_ops' },
      /DATABASE_URL/,
    ],
    ['a Redis URL without password', { REDIS_URL: 'redis://redis:6379' }, /REDIS_URL/],
    ['a placeholder storage secret', { S3_SECRET_ACCESS_KEY: 'minioadmin' }, /S3_SECRET_ACCESS_KEY/],
    ['plain-http browser storage', { S3_PUBLIC_ENDPOINT: 'http://files.acme.test' }, /S3_PUBLIC_ENDPOINT/],
    ['Swagger', { SWAGGER_ENABLED: 'true' }, /SWAGGER_ENABLED/],
    ['an http CORS origin', { CORS_ORIGINS: 'http://other.acme.test' }, /CORS_ORIGINS/],
    ['a loopback public URL', { APP_PUBLIC_URL: 'https://localhost' }, /APP_PUBLIC_URL/],
    ['a documentation host', { APP_PUBLIC_URL: 'https://ops.example.com' }, /APP_PUBLIC_URL/],
    ['a placeholder access key', { S3_ACCESS_KEY_ID: 'replace-with-access-key-id' }, /S3_ACCESS_KEY_ID/],
    ['a generated-value placeholder', { OIDC_CLIENT_SECRET: '__KEY32:APP_ENCRYPTION_KEY__' }, /OIDC_CLIENT_SECRET/],
    ['too many trusted proxies', { TRUST_PROXY_HOPS: '5' }, /TRUST_PROXY_HOPS/],
  ])('rejects %s and never echoes the value', (_label, override, pattern) => {
    let message = '';
    try {
      parseEnv('api', apiEnvSchema, { ...productionApi, ...override });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(pattern);
    for (const value of Object.values(override)) {
      if (value.length >= 8) expect(message).not.toContain(value);
    }
  });

  it('keeps development conveniences out of the production worker', () => {
    const worker = {
      ...productionApi,
      SMTP_HOST: 'mailpit',
      SMTP_PORT: '1025',
      SMTP_FROM: 'ops@acme.test',
    };
    expect(() => parseEnv('worker', workerEnvSchema, worker)).toThrow(/SMTP_HOST/);
    expect(
      parseEnv('worker', workerEnvSchema, { ...worker, SMTP_HOST: 'smtp.acme.test', SMTP_PORT: '465' }).SMTP_HOST,
    ).toBe('smtp.acme.test');
    expect(() =>
      parseEnv('worker', workerEnvSchema, { ...worker, SMTP_HOST: undefined, REDIS_URL: 'redis://r:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('allows development values outside production', () => {
    expect(parseEnv('api', apiEnvSchema, validApiEnv).NODE_ENV).toBe('development');
  });
});

describe('storageEnvSchema', () => {
  it('accepts an S3-compatible endpoint with path-style addressing', () => {
    const env = parseEnv('storage', storageEnvSchema, {
      S3_ENDPOINT: 'http://localhost:8333',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'company-ops-dev',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'key',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_ENDPOINT).toBe('http://localhost:8333');
  });

  it('allows the endpoint to be omitted for providers resolved by region', () => {
    const env = parseEnv('storage', storageEnvSchema, {
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'company-ops-prod',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'key',
    });
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });
});
