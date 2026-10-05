import { randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { createPrismaClient, IdentityService, MFA_ACR, seedDemoData, serializePermissions } from '@company-ops/core';
import type { PrismaClient } from '@company-ops/core';
import { startTestDatabase } from '@company-ops/db/testing';
import type { TestDatabase } from '@company-ops/db/testing';

import { AppModule } from '../../src/app.module.js';
import { SESSION_COOKIE } from '../../src/auth/session/cookies.js';
import { SessionStore } from '../../src/auth/session/session.store.js';
import { configureHttp } from '../../src/bootstrap.js';
import { loadApiEnv } from '../../src/config/api-env.js';
import type { ApiEnv } from '../../src/config/api-env.js';

/** Same image and digest as infra/compose/docker-compose.dev.yml. */
export const REDIS_TEST_IMAGE = 'redis:8.10.2@sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee';

export const PUBLIC_URL = 'http://localhost:3000';
export const ALLOWED_EXTRA_ORIGIN = 'http://localhost:3100';

export interface StartedRedis {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startTestRedis(): Promise<StartedRedis> {
  const password = randomBytes(16).toString('hex');
  const container: StartedTestContainer = await new GenericContainer(REDIS_TEST_IMAGE)
    .withCommand(['redis-server', '--requirepass', password])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  const url = new URL(`redis://${container.getHost()}:${String(container.getMappedPort(6379))}`);
  url.password = password;
  return {
    url: url.toString(),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface ApiStack {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly env: ApiEnv;
  readonly db: TestDatabase;
  readonly prisma: PrismaClient;
  readonly sessions: SessionStore;
  stop(): Promise<void>;
}

/** A currently free TCP port (released before returning). */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export async function startApiStack(options: {
  issuer: string;
  overrides?: Readonly<Record<string, string>>;
  database?: TestDatabase;
  redis?: StartedRedis;
  /** Fixed port/interface, e.g. so a Keycloak container can reach the API for back-channel logout. */
  listen?: { port: number; host: string };
}): Promise<ApiStack> {
  const db = options.database ?? (await startTestDatabase());
  if (options.database === undefined) {
    await db.migrate();
  }
  const redis = options.redis ?? (await startTestRedis());
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.appUrl,
    REDIS_URL: redis.url,
    APP_PUBLIC_URL: PUBLIC_URL,
    CORS_ORIGINS: ALLOWED_EXTRA_ORIGIN,
    OIDC_ISSUER: options.issuer,
    OIDC_ALLOW_INSECURE_HTTP: 'true',
    OIDC_CLIENT_SECRET: 'integration-test-client-secret',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // Pre-signing works offline; suites that need real object storage override these.
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'api-test-bucket',
    S3_ACCESS_KEY_ID: 'api-test-access-key',
    S3_SECRET_ACCESS_KEY: 'api-test-secret-key',
    S3_FORCE_PATH_STYLE: 'true',
    ...options.overrides,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureHttp(app, env);
  await app.listen(options.listen?.port ?? 0, options.listen?.host ?? '127.0.0.1');
  const baseUrl =
    options.listen === undefined
      ? (await app.getUrl()).replace('[::1]', '127.0.0.1')
      : `http://localhost:${String(options.listen.port)}`;
  const prisma = createPrismaClient(db.appUrl);
  return {
    app,
    baseUrl,
    env,
    db,
    prisma,
    sessions: app.get(SessionStore),
    stop: async () => {
      await app.close();
      await prisma.$disconnect();
      if (options.redis === undefined) {
        await redis.stop();
      }
      if (options.database === undefined) {
        await db.stop();
      }
    },
  };
}

export async function seed(stack: ApiStack): Promise<string> {
  const report = await seedDemoData(stack.prisma, stack.env.OIDC_ISSUER);
  return report.organizationId;
}

export interface TestSession {
  readonly id: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

/**
 * Creates a server-side session exactly as the OIDC callback does after token validation (the
 * OIDC exchange itself is covered by the Keycloak suite). Fails if the user has no active
 * membership in the organization.
 */
export async function createSession(
  stack: ApiStack,
  subject: string,
  organizationId: string,
  options: { mfa?: boolean } = {},
): Promise<TestSession> {
  const user = await stack.prisma.user.findUniqueOrThrow({
    where: { idpIssuer_idpSubject: { idpIssuer: stack.env.OIDC_ISSUER, idpSubject: subject } },
  });
  const principal = await new IdentityService(stack.prisma).loadPrincipal(user.id, organizationId);
  if (principal === null) {
    throw new Error(`No active membership for ${subject}`);
  }
  const mfa = options.mfa === true;
  const { id, record } = await stack.sessions.create({
    userId: user.id,
    organizationId,
    memberId: principal.memberId,
    authzVersion: principal.authzVersion,
    roleKeys: [...principal.roleKeys],
    permissions: serializePermissions(principal.permissions),
    acr: mfa ? MFA_ACR : 'pwd',
    mfaAuthenticatedAt: mfa ? Date.now() : null,
    idpSessionId: null,
    idToken: null,
  });
  return { id, cookie: `${SESSION_COOKIE}=${id}`, csrfToken: record.csrfToken };
}

/** Session id from a `Set-Cookie` response header, if the response set one. */
export function sessionIdFromResponse(response: Response): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(header);
    if (match?.[1] !== undefined && match[1] !== '') {
      return match[1];
    }
  }
  return undefined;
}
