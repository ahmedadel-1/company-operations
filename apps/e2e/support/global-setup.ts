import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { GenericContainer, Wait } from 'testcontainers';

import { createPrismaClient, seedDemoData } from '@company-ops/core';
import { FakeGithub, FakeJira, startFakeGithubServer, startFakeJiraServer } from '@company-ops/core/testing';
import { startTestDatabase } from '@company-ops/db/testing';

import { captureBaseline } from './baseline.js';
import { startKeycloak } from './keycloak.js';
import { E2E_API_PORT, E2E_API_URL, E2E_WEB_PORT, E2E_WEB_URL } from './ports.js';

const REDIS_IMAGE = 'redis:8.10.2@sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee';
/** Same image and digest as infra/compose/docker-compose.dev.yml (DEPENDENCIES §6). */
const SEAWEEDFS_IMAGE =
  'chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const logDir = join(import.meta.dirname, '..', 'test-results', 'stack-logs');

/** OS variables child processes need (temp/cache directories, executable lookup); nothing app-specific. */
const OS_ENV = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
] as const;

function requireBuilt(path: string, hint: string): string {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. ${hint}`);
  }
  return path;
}

/** Starts a process with a scrubbed environment and an isolated cwd (so no workspace `.env` is loaded). */
function startProcess(
  name: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): ChildProcessByStdio<null, Readable, Readable> {
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(join(logDir, `${name}.log`));
  const system = Object.fromEntries(
    OS_ENV.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...system, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function waitForHttp(url: string, name: string, child: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = 'no response yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with code ${String(child.exitCode)}; see ${join(logDir, `${name}.log`)}`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) {
        return;
      }
      lastProblem = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not become ready at ${url} within ${String(timeoutMs)} ms (${lastProblem})`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const apiMain = requireBuilt(
    join(repoRoot, 'apps', 'api', 'dist', 'main.js'),
    'Run `pnpm test:e2e` from the repository root (it builds first).',
  );
  const workerMain = requireBuilt(join(repoRoot, 'apps', 'worker', 'dist', 'main.js'), 'Build the worker first.');
  const webBuild = join(repoRoot, 'apps', 'web', '.next');
  requireBuilt(join(webBuild, 'BUILD_ID'), 'Build the web app first.');
  // The same standalone server the production image runs; Next leaves static assets for the deployer to copy.
  const webStandalone = join(webBuild, 'standalone', 'apps', 'web');
  const webServer = requireBuilt(join(webStandalone, 'server.js'), 'Build the web app first.');
  cpSync(join(webBuild, 'static'), join(webStandalone, '.next', 'static'), { recursive: true });
  cpSync(join(repoRoot, 'apps', 'web', 'public'), join(webStandalone, 'public'), { recursive: true });

  const database = await startTestDatabase();
  await database.migrate();
  const redisPassword = randomBytes(16).toString('hex');
  const redis = await new GenericContainer(REDIS_IMAGE)
    .withCommand(['redis-server', '--requirepass', redisPassword])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  const redisUrl = new URL(`redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`);
  redisUrl.password = redisPassword;

  const keycloak = await startKeycloak({
    appPublicUrl: E2E_WEB_URL,
    backchannelLogoutUrl: `http://host.docker.internal:${String(E2E_API_PORT)}/api/v1/auth/backchannel-logout`,
  });

  const prisma = createPrismaClient(database.appUrl);
  try {
    await seedDemoData(prisma, keycloak.issuer);
  } finally {
    await prisma.$disconnect();
  }

  const isolatedCwd = tmpdir();
  // The browser uploads to and downloads from the pre-signed URLs, so the endpoint must be reachable
  // from the host under the same origin the API signs for.
  const s3Credentials = {
    accessKeyId: randomBytes(10).toString('hex'),
    secretAccessKey: randomBytes(20).toString('hex'),
  };
  const seaweedfs = await new GenericContainer(SEAWEEDFS_IMAGE)
    .withCommand(['mini', '-dir=/data'])
    .withEnvironment({
      AWS_ACCESS_KEY_ID: s3Credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: s3Credentials.secretAccessKey,
      S3_BUCKET: 'e2e-bucket',
    })
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/healthz', 8333).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  const storageOrigin = `http://localhost:${String(seaweedfs.getMappedPort(8333))}`;
  const mailpit = await new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025).forStatusCode(200))
    .start();
  const mailpitUrl = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;
  // Deterministic Atlassian double (OAuth, REST v3, webhook registration and signed deliveries).
  // Never a real Jira site: browser automation must not depend on or modify one.
  const jiraCredentials = {
    clientId: `e2e-jira-${randomBytes(6).toString('hex')}`,
    clientSecret: randomBytes(24).toString('hex'),
  };
  const fakeJira = await startFakeJiraServer(new FakeJira(jiraCredentials));
  const jira = {
    JIRA_OAUTH_CLIENT_ID: jiraCredentials.clientId,
    JIRA_OAUTH_CLIENT_SECRET: jiraCredentials.clientSecret,
    JIRA_AUTH_BASE_URL: fakeJira.url,
    JIRA_API_BASE_URL: fakeJira.url,
    // The worker refreshes tokens with the same keys the API encrypted them with.
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  // Deterministic GitHub App double (App JWT, installation tokens, setup authorization, REST and
  // signed webhooks). The App key and secrets exist only for this run; never a real GitHub App.
  const { privateKey: githubKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const githubApp = {
    appId: String(100_000 + (randomBytes(2).readUInt16BE(0) % 900_000)),
    clientId: `Iv23e2e${randomBytes(6).toString('hex')}`,
    clientSecret: randomBytes(24).toString('hex'),
    webhookSecret: randomBytes(24).toString('hex'),
    slug: 'company-ops-e2e',
  };
  const fakeGithub = await startFakeGithubServer(
    new FakeGithub({
      ...githubApp,
      privateKeyPem: githubKey,
      setupUrl: `${E2E_WEB_URL}/api/v1/integrations/github/setup`,
      // Through the web origin, like GitHub reaching the public URL.
      webhookUrl: `${E2E_WEB_URL}/api/v1/webhooks/github`,
    }),
  );
  const githubWorker = {
    GITHUB_APP_ID: githubApp.appId,
    GITHUB_APP_CLIENT_ID: githubApp.clientId,
    GITHUB_APP_PRIVATE_KEY: githubKey,
    GITHUB_API_BASE_URL: fakeGithub.url,
  };
  const github = {
    ...githubWorker,
    GITHUB_APP_SLUG: githubApp.slug,
    GITHUB_APP_CLIENT_SECRET: githubApp.clientSecret,
    GITHUB_WEBHOOK_SECRET: githubApp.webhookSecret,
    GITHUB_WEB_BASE_URL: fakeGithub.url,
  };
  const storage = {
    S3_ENDPOINT: storageOrigin,
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'e2e-bucket',
    S3_ACCESS_KEY_ID: s3Credentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3Credentials.secretAccessKey,
    S3_FORCE_PATH_STYLE: 'true',
  };
  const api = startProcess(
    'api',
    [apiMain],
    {
      ...storage,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      API_PORT: String(E2E_API_PORT),
      DATABASE_URL: database.appUrl,
      REDIS_URL: redisUrl.toString(),
      APP_PUBLIC_URL: E2E_WEB_URL,
      TRUST_PROXY_HOPS: '1',
      OIDC_ISSUER: keycloak.issuer,
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      OIDC_CLIENT_SECRET: keycloak.clientSecret,
      ...jira,
      ...github,
      // Many sign-ins from one machine in a few minutes; rate limiting is covered by the API suite.
      RATE_LIMIT_AUTH_PER_MINUTE: '500',
      RATE_LIMIT_DEFAULT_PER_MINUTE: '5000',
      RATE_LIMIT_USER_PER_MINUTE: '5000',
      RATE_LIMIT_JIRA_PER_MINUTE: '5000',
      RATE_LIMIT_GITHUB_PER_MINUTE: '5000',
      RATE_LIMIT_ATTENDANCE_PER_MINUTE: '5000',
      RATE_LIMIT_SEARCH_PER_MINUTE: '5000',
    },
    isolatedCwd,
  );
  const worker = startProcess(
    'worker',
    [workerMain],
    {
      ...storage,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: database.appUrl,
      REDIS_URL: redisUrl.toString(),
      OUTBOX_POLL_INTERVAL_MS: '500',
      APP_PUBLIC_URL: E2E_WEB_URL,
      SMTP_HOST: mailpit.getHost(),
      SMTP_PORT: String(mailpit.getMappedPort(1025)),
      SMTP_FROM: 'ops-e2e@localhost.test',
      SLA_SWEEP_INTERVAL_MS: '10000',
      ...jira,
      ...githubWorker,
    },
    isolatedCwd,
  );
  const web = startProcess(
    'web',
    [webServer],
    {
      NODE_ENV: 'production',
      PORT: String(E2E_WEB_PORT),
      HOSTNAME: '127.0.0.1',
      API_INTERNAL_URL: `http://127.0.0.1:${String(E2E_API_PORT)}`,
      STORAGE_PUBLIC_ORIGIN: storageOrigin,
    },
    join(repoRoot, 'apps', 'web'),
  );

  const children = [api, worker, web];
  const stop = async () => {
    for (const child of children) {
      child.kill();
    }
    await Promise.allSettled([
      fakeJira.close(),
      fakeGithub.close(),
      keycloak.container.stop(),
      redis.stop(),
      seaweedfs.stop(),
      mailpit.stop(),
      database.stop(),
    ]);
  };

  try {
    await waitForHttp(`${E2E_API_URL}/api/v1/health/ready`, 'api', api);
    await waitForHttp(`${E2E_WEB_URL}/sign-in`, 'web', web);
    if (worker.exitCode !== null) {
      throw new Error(`worker exited with code ${String(worker.exitCode)}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  const runDir = mkdtempSync(join(tmpdir(), 'company-ops-e2e-'));
  await captureBaseline(database.appUrl, runDir);
  // Read by the tests (Playwright exposes environment variables set here to every worker).
  process.env.E2E_KEYCLOAK_URL = keycloak.baseUrl;
  process.env.E2E_DEMO_PASSWORD = keycloak.demoPassword;
  process.env.E2E_RUN_DIR = runDir;
  process.env.E2E_DATABASE_URL = database.appUrl;
  process.env.E2E_MAILPIT_URL = mailpitUrl;
  process.env.E2E_FAKE_JIRA_URL = fakeJira.url;
  process.env.E2E_FAKE_GITHUB_URL = fakeGithub.url;
  return async () => {
    await stop();
    rmSync(runDir, { recursive: true, force: true });
  };
}
