// Production-stack rehearsal on a workstation (docs/runbooks/deploy.md §Rehearsal). Runs the real
// docker-compose.prod.yml with the release images, random secrets, a throwaway self-signed certificate and
// the rehearsal overlay (stand-in S3), then migrates and runs the smoke test. Never use it against a real
// host. Runs with Node 24 native type stripping:
//
//   node scripts/release/rehearse.ts up --version <image tag> [--registry ops]
//   node scripts/release/rehearse.ts smoke --dir <rehearsal dir>
//   node scripts/release/rehearse.ts journey --dir <rehearsal dir>   (first admin sign-in, step-up, SSE drain)
//   node scripts/release/rehearse.ts restore-drill --dir <rehearsal dir> [--version <migrate image tag>]
//   node scripts/release/rehearse.ts rotate --dir <rehearsal dir>   (DB/Redis/OIDC/encryption-key rotation)
//   node scripts/release/rehearse.ts down --dir <rehearsal dir>
//
// Deployment files are copied to a temporary directory (Docker Desktop cannot bind-mount every drive) and
// secrets are generated there; nothing is written to the repository and no secret is printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = join(import.meta.dirname, '..', '..');
const PROJECT = 'company-ops-rehearsal';
const HOST = 'ops.rehearsal.test';
const FILES_HOST = 'files.rehearsal.test';
const HTTP_PORT = 8088;
const HTTPS_PORT = 8443;
const OPENSSL_IMAGE = 'postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: 'string' },
    registry: { type: 'string', default: 'ops' },
    dir: { type: 'string' },
  },
});
const command = positionals[0];

function compose(dir: string, args: readonly string[], options: { readonly quiet?: boolean } = {}): void {
  const files = [
    '-f',
    join(dir, 'infra', 'compose', 'docker-compose.prod.yml'),
    '-f',
    join(dir, 'infra', 'compose', 'rehearsal', 'docker-compose.rehearsal.yml'),
  ];
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '--env-file', join(dir, 'compose.env'), ...files, ...args],
    {
      stdio: options.quiet === true ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (exit ${String(result.status)})`);
  }
}

const hex = (bytes = 24): string => randomBytes(bytes).toString('hex');
const slash = (path: string): string => path.replace(/\\/g, '/');

function prepare(version: string, registry: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'company-ops-rehearsal-'));
  for (const path of [
    ['infra', 'compose'],
    ['infra', 'nginx', 'prod'],
    ['infra', 'docker', 'postgres', 'prod-init'],
    ['infra', 'docker', 'keycloak', 'realms-prod'],
    ['infra', 'backup'],
  ]) {
    cpSync(join(root, ...path), join(dir, ...path), { recursive: true });
  }
  const templates = join(dir, 'infra', 'compose', 'rehearsal', 'rehearsal-templates');
  mkdirSync(templates, { recursive: true });
  cpSync(join(root, 'infra', 'nginx', 'prod', 'templates', 'ops.conf.template'), join(templates, 'ops.conf.template'));
  cpSync(join(root, 'infra', 'compose', 'rehearsal', 'files.conf.template'), join(templates, 'files.conf.template'));

  const secrets = join(dir, 'secrets');
  mkdirSync(secrets);
  const passwords = { app: hex(), migrator: hex(), redis: hex() };
  const secretFiles: Record<string, string> = {
    database_url: `postgresql://ops_app:${passwords.app}@postgres:5432/company_ops`,
    database_migration_url: `postgresql://ops_migrator:${passwords.migrator}@postgres:5432/company_ops`,
    redis_url: `redis://:${passwords.redis}@redis:6379`,
    redis_password: passwords.redis,
    oidc_client_secret: hex(),
    app_encryption_key: randomBytes(32).toString('base64'),
    app_encryption_keys_previous: '',
    s3_access_key_id: `rehearsal${hex(8)}`,
    s3_secret_access_key: hex(),
    postgres_superuser_password: hex(),
    ops_app_db_password: passwords.app,
    ops_migrator_db_password: passwords.migrator,
    ops_backup_db_password: hex(),
    keycloak_db_password: hex(),
    keycloak_admin_password: hex(),
  };
  for (const [name, value] of Object.entries(secretFiles)) {
    writeFileSync(join(secrets, name), `${value}\n`, { mode: 0o644 });
  }

  const tls = join(dir, 'tls');
  mkdirSync(tls);
  mkdirSync(join(dir, 'acme'));
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${slash(tls)}:/out`,
      '--entrypoint',
      'sh',
      OPENSSL_IMAGE,
      '-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=${HOST} ` +
        `-addext subjectAltName=DNS:${HOST},DNS:${FILES_HOST} -keyout /out/privkey.pem -out /out/fullchain.pem 2>/dev/null ` +
        '&& chmod 0644 /out/privkey.pem /out/fullchain.pem',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  cpSync(join(tls, 'fullchain.pem'), join(secrets, 'rehearsal_ca.pem'));

  const publicUrl = `https://${HOST}:${String(HTTPS_PORT)}`;
  writeFileSync(
    join(dir, 'compose.env'),
    [
      `OPS_IMAGE_REGISTRY=${registry}`,
      `OPS_VERSION=${version}`,
      `OPS_PUBLIC_HOST=${HOST}`,
      `OPS_FILES_HOST=${FILES_HOST}`,
      `OPS_HTTP_PORT=${String(HTTP_PORT)}`,
      `OPS_HTTPS_PORT=${String(HTTPS_PORT)}`,
      `APP_PUBLIC_URL=${publicUrl}`,
      `OPS_APP_ENV_FILE=${slash(join(dir, 'app.env'))}`,
      `OPS_SECRETS_DIR=${slash(secrets)}`,
      `OPS_TLS_DIR=${slash(tls)}`,
      `OPS_ACME_WEBROOT=${slash(join(dir, 'acme'))}`,
      `STORAGE_PUBLIC_ORIGIN=https://${FILES_HOST}:${String(HTTPS_PORT)}`,
      'KC_ADMIN_TUNNEL_PORT=8090',
      'S3_BUCKET=company-ops',
      'POSTGRES_SHARED_BUFFERS=128MB',
      'REDIS_MAXMEMORY=256mb',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'app.env'),
    [
      'LOG_LEVEL=info',
      `APP_PUBLIC_URL=${publicUrl}`,
      `OIDC_ISSUER=${publicUrl}/auth/realms/company-ops`,
      'OIDC_CLIENT_ID=ops-api',
      'APP_ENCRYPTION_KEY_ID=k1',
      'S3_ENDPOINT=http://seaweedfs:8333',
      `S3_PUBLIC_ENDPOINT=https://${FILES_HOST}:${String(HTTPS_PORT)}`,
      'S3_REGION=us-east-1',
      'S3_BUCKET=company-ops',
      'S3_FORCE_PATH_STYLE=true',
      'SMTP_HOST=',
      '',
    ].join('\n'),
  );
  return dir;
}

function smoke(dir: string): number {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'release', 'smoke.ts'),
      '--url',
      `https://${HOST}:${String(HTTPS_PORT)}`,
      '--http-port',
      String(HTTP_PORT),
      '--resolve',
      '127.0.0.1',
      '--ca',
      join(dir, 'tls', 'fullchain.pem'),
    ],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

function composeCapture(dir: string, args: readonly string[]): string {
  const files = [
    '-f',
    join(dir, 'infra', 'compose', 'docker-compose.prod.yml'),
    '-f',
    join(dir, 'infra', 'compose', 'rehearsal', 'docker-compose.rehearsal.yml'),
  ];
  return execFileSync('docker', ['compose', '-p', PROJECT, '--env-file', join(dir, 'compose.env'), ...files, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Creates the first administrator in the production realm through the loopback-only admin port. */
async function createKeycloakUser(dir: string, username: string, email: string, password: string): Promise<void> {
  const admin = 'http://127.0.0.1:8090/auth';
  const tokenResponse = await fetch(`${admin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'ops-admin',
      password: readFileSync(join(dir, 'secrets', 'keycloak_admin_password'), 'utf8').trim(),
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Keycloak admin token request failed (${String(tokenResponse.status)})`);
  }
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string };
  const response = await fetch(`${admin}/admin/realms/company-ops/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      email,
      emailVerified: true,
      enabled: true,
      firstName: 'Rehearsal',
      lastName: 'Admin',
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Keycloak user creation failed (${String(response.status)})`);
  }
}

/** Opens the live-update stream with the journey's session, stops the API and measures the drain. */
async function sseShutdown(dir: string, session: string): Promise<boolean> {
  const opened = await new Promise<{ ended: Promise<number> }>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: HOST,
        port: HTTPS_PORT,
        path: '/api/v1/notifications/events/stream',
        headers: { cookie: `__Host-ops_sid=${session}`, accept: 'text/event-stream' },
        ca: readFileSync(join(dir, 'tls', 'fullchain.pem')),
        lookup: (_host, options, callback) => {
          if (options.all === true) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(null, '127.0.0.1', 4);
          }
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`stream answered ${String(response.statusCode)}`));
          return;
        }
        response.resume();
        resolve({
          ended: new Promise((done) => {
            response.on('close', () => {
              done(Date.now());
            });
          }),
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
  const stopStarted = Date.now();
  compose(dir, ['stop', 'api'], { quiet: true });
  const stopped = Date.now();
  const endedAt = await Promise.race([
    opened.ended,
    new Promise<number>((done) => {
      setTimeout(() => {
        done(-1);
      }, 5000);
    }),
  ]);
  const exit = composeCapture(dir, ['ps', '--all', '--format', '{{.ExitCode}}', 'api']).trim();
  console.log(
    `SSE shutdown: api stopped in ${String(stopped - stopStarted)} ms (exit ${exit}); stream closed ` +
      (endedAt < 0 ? 'NOT within 5 s' : `${String(endedAt - stopStarted)} ms after stop began`),
  );
  compose(dir, ['up', '-d', '--wait', 'api'], { quiet: true });
  return endedAt > 0 && stopped - stopStarted < 30_000 && exit === '143';
}

async function journey(dir: string): Promise<number> {
  const work = join(dir, 'journey');
  mkdirSync(work, { recursive: true });
  const username = 'rehearsal.admin';
  const passwordFile = join(work, 'password');
  if (!existsSync(passwordFile)) {
    writeFileSync(passwordFile, `${hex(16)}Aa1!`, { mode: 0o600 });
  }
  await createKeycloakUser(dir, username, `${username}@${HOST}`, readFileSync(passwordFile, 'utf8').trim());

  const invitationFile = join(work, 'invitation');
  const remote = `/tmp/invitation-${hex(6)}`;
  compose(dir, [
    'exec',
    '-T',
    'api',
    'ops-bootstrap',
    '--slug',
    'rehearsal',
    '--name',
    'Rehearsal Company',
    '--time-zone',
    'Africa/Cairo',
    '--work-week',
    '7,1,2,3,4',
    '--admin-name',
    'Rehearsal Admin',
    '--admin-email',
    `${username}@${HOST}`,
    '--reissue',
    '--confirm-production',
    'rehearsal',
    '--invitation-file',
    remote,
  ]);
  const link = composeCapture(dir, ['exec', '-T', 'api', 'sh', '-c', `cat ${remote} 2>/dev/null; rm -f ${remote}`]);
  // A rerun after the invitation was redeemed ("already bootstrapped") signs in from the home page instead.
  writeFileSync(invitationFile, link.trim() === '' ? `https://${HOST}:${String(HTTPS_PORT)}/` : link, { mode: 0o600 });

  const sessionFile = join(work, 'session');
  const playwright = spawnSync(
    'pnpm --filter @company-ops/e2e exec playwright test -c playwright.rehearsal.config.ts',
    {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        REHEARSAL_URL: `https://${HOST}:${String(HTTPS_PORT)}`,
        REHEARSAL_USER: username,
        REHEARSAL_PASSWORD_FILE: passwordFile,
        REHEARSAL_INVITATION_FILE: invitationFile,
        REHEARSAL_SESSION_FILE: sessionFile,
        REHEARSAL_TOTP_FILE: join(work, 'totp'),
      },
    },
  );
  if (playwright.status !== 0) {
    return playwright.status ?? 1;
  }
  return (await sseShutdown(dir, readFileSync(sessionFile, 'utf8').trim())) ? 0 : 1;
}

function docker(args: readonly string[], capture = false): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'ignore', 'inherit'] });
}

/**
 * Backup with the `backup` service, then a timed restore into a scratch PostgreSQL initialized with the
 * production roles script, row-count verification, `prisma migrate status` from the migrate image and an
 * ops_app read. Nothing touches the rehearsal database.
 */
function restoreDrill(dir: string): boolean {
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  const env = readFileSync(join(dir, 'compose.env'), 'utf8');
  if (!env.includes('OPS_BACKUP_DIR=')) {
    writeFileSync(join(dir, 'compose.env'), `${env}OPS_BACKUP_DIR=${slash(backups)}\n`);
  }
  cpSync(join(root, 'infra', 'backup'), join(dir, 'infra', 'backup'), { recursive: true });
  cpSync(
    join(root, 'infra', 'compose', 'docker-compose.prod.yml'),
    join(dir, 'infra', 'compose', 'docker-compose.prod.yml'),
  );

  const backupStarted = Date.now();
  compose(dir, ['--profile', 'backup', 'run', '--rm', 'backup']);
  const backupMs = Date.now() - backupStarted;
  const stamp = readdirSync(backups)
    .filter((name) => name.endsWith('Z'))
    .sort()
    .at(-1);
  if (stamp === undefined) {
    throw new Error('backup produced no directory');
  }

  const name = 'company-ops-restore-drill';
  const network = `${name}-net`;
  const password = hex();
  docker(['rm', '-f', name]);
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  docker(['network', 'create', '--internal', network]);
  try {
    docker([
      'create',
      '--name',
      name,
      '--network',
      network,
      '--network-alias',
      'drill-db',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      `OPS_APP_DB_PASSWORD=${password}`,
      '-e',
      `OPS_MIGRATOR_DB_PASSWORD=${password}`,
      '-e',
      `OPS_BACKUP_DB_PASSWORD=${password}`,
      '-e',
      `KEYCLOAK_DB_PASSWORD=${password}`,
      OPENSSL_IMAGE,
    ]);
    docker([
      'cp',
      join(root, 'infra', 'docker', 'postgres', 'prod-init', '01-roles-and-databases.sh'),
      `${name}:/docker-entrypoint-initdb.d/01-roles-and-databases.sh`,
    ]);
    docker(['start', name]);
    for (let attempt = 0; ; attempt += 1) {
      const ready = spawnSync(
        'docker',
        [
          'exec',
          name,
          'psql',
          '-U',
          'postgres',
          '-d',
          'company_ops',
          '-Atc',
          "select 1 from pg_roles where rolname = 'ops_backup'",
        ],
        { encoding: 'utf8' },
      );
      if (
        ready.stdout.trim() === '1' &&
        spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0
      ) {
        break;
      }
      if (attempt > 60) {
        throw new Error(`scratch PostgreSQL did not start: ${ready.stdout} ${ready.stderr}`);
      }
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
    }
    docker(['cp', join(backups, stamp), `${name}:/tmp/restore`]);
    docker(['cp', join(root, 'infra', 'backup', 'pg-restore.sh'), `${name}:/tmp/pg-restore.sh`]);
    const restoreStarted = Date.now();
    const restore = spawnSync(
      'docker',
      ['exec', '-u', 'postgres', name, 'bash', '/tmp/pg-restore.sh', '/tmp/restore', 'company_ops', 'keycloak'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const restoreMs = Date.now() - restoreStarted;
    process.stdout.write(restore.stdout);
    if (restore.status !== 0) {
      return false;
    }
    const status = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network,
        '-e',
        `DATABASE_MIGRATION_URL=postgresql://ops_migrator:${password}@drill-db:5432/company_ops`,
        `${values.registry}/ops-migrate:${values.version ?? 'p9'}`,
        'node',
        'node_modules/prisma/build/index.js',
        'migrate',
        'status',
      ],
      { encoding: 'utf8' },
    );
    const upToDate = status.status === 0 && status.stdout.includes('Database schema is up to date');
    const appRead = docker(
      [
        'exec',
        '-e',
        `PGPASSWORD=${password}`,
        name,
        'psql',
        '-h',
        '127.0.0.1',
        '-U',
        'ops_app',
        '-d',
        'company_ops',
        '-Atc',
        'select count(*) from organizations',
      ],
      true,
    ).trim();
    const otp = docker(
      [
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'keycloak',
        '-Atc',
        "select count(*) from credential c join user_entity u on u.id = c.user_id where u.username = 'rehearsal.admin' and c.type = 'otp'",
      ],
      true,
    ).trim();
    console.log(
      `Restore drill: backup ${String(backupMs)} ms, restore ${String(restoreMs)} ms; migrate status ` +
        `${upToDate ? 'up to date' : 'NOT up to date'}; ops_app reads ${appRead} organization(s); ` +
        `restored Keycloak keeps ${otp} OTP credential(s) for the rehearsal admin`,
    );
    return upToDate && Number(appRead) >= 1 && otp === '1';
  } finally {
    docker(['rm', '-f', name]);
    spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  }
}

function composeInput(dir: string, args: readonly string[], input: string): void {
  const files = [
    '-f',
    join(dir, 'infra', 'compose', 'docker-compose.prod.yml'),
    '-f',
    join(dir, 'infra', 'compose', 'rehearsal', 'docker-compose.rehearsal.yml'),
  ];
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '--env-file', join(dir, 'compose.env'), ...files, ...args],
    {
      input,
      stdio: ['pipe', 'ignore', 'inherit'],
    },
  );
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (exit ${String(result.status)})`);
  }
}

/**
 * Rotates the database runtime password, the Redis password, the OIDC client secret and the application
 * encryption key on the running stack, as docs/runbooks/secrets.md describes, then proves: the old
 * database and Redis passwords are refused, an existing session (ID token encrypted with the retired key)
 * still works, and a full sign-in (code exchange with the new client secret) succeeds.
 */
async function rotate(dir: string): Promise<boolean> {
  const secrets = join(dir, 'secrets');
  const readSecret = (name: string): string => readFileSync(join(secrets, name), 'utf8').trim();
  const writeSecret = (name: string, value: string): void => {
    writeFileSync(join(secrets, name), `${value}\n`, { mode: 0o644 });
  };
  cpSync(
    join(root, 'infra', 'compose', 'docker-compose.prod.yml'),
    join(dir, 'infra', 'compose', 'docker-compose.prod.yml'),
  );
  if (!existsSync(join(secrets, 'app_encryption_keys_previous'))) {
    writeSecret('app_encryption_keys_previous', '');
  }
  const oldDb = readSecret('ops_app_db_password');
  const oldRedis = readSecret('redis_password');

  const db = hex();
  composeInput(
    dir,
    ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
    `ALTER ROLE ops_app PASSWORD '${db}';\n`,
  );
  writeSecret('ops_app_db_password', db);
  writeSecret('database_url', `postgresql://ops_app:${db}@postgres:5432/company_ops`);

  const redis = hex();
  composeInput(
    dir,
    ['exec', '-T', '-e', `REDISCLI_AUTH=${oldRedis}`, 'redis', 'redis-cli', '-x', 'CONFIG', 'SET', 'requirepass'],
    redis,
  );
  writeSecret('redis_password', redis);
  writeSecret('redis_url', `redis://:${redis}@redis:6379`);

  const admin = 'http://127.0.0.1:8090/auth';
  const tokenResponse = await fetch(`${admin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'ops-admin',
      password: readSecret('keycloak_admin_password'),
    }),
  });
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string };
  const headers = { authorization: `Bearer ${token}` };
  const [client] = (await (
    await fetch(`${admin}/admin/realms/company-ops/clients?clientId=ops-api`, { headers })
  ).json()) as { id: string }[];
  const regenerated = await fetch(`${admin}/admin/realms/company-ops/clients/${client?.id ?? ''}/client-secret`, {
    method: 'POST',
    headers,
  });
  if (!regenerated.ok) {
    throw new Error(`client secret regeneration failed (${String(regenerated.status)})`);
  }
  writeSecret('oidc_client_secret', ((await regenerated.json()) as { value: string }).value);

  const appEnv = readFileSync(join(dir, 'app.env'), 'utf8');
  const currentId = /^APP_ENCRYPTION_KEY_ID=(\S+)$/m.exec(appEnv)?.[1] ?? 'k1';
  const nextId = `k${String(Number(currentId.slice(1)) + 1)}`;
  // Retired keys are appended (at most 5 kept): data encrypted with any of them must stay readable.
  const retired = [
    `${currentId}:${readSecret('app_encryption_key')}`,
    ...readSecret('app_encryption_keys_previous').split(','),
  ]
    .filter((entry) => entry !== '')
    .slice(0, 5);
  writeSecret('app_encryption_keys_previous', retired.join(','));
  writeSecret('app_encryption_key', randomBytes(32).toString('base64'));
  writeFileSync(
    join(dir, 'app.env'),
    appEnv.replace(/^APP_ENCRYPTION_KEY_ID=\S+$/m, `APP_ENCRYPTION_KEY_ID=${nextId}`),
  );

  compose(dir, ['up', '-d', '--force-recreate', '--wait', 'api', 'worker'], { quiet: true });

  // Over the network like the applications (loopback inside the postgres container is trust-authenticated).
  const connects = (password: string): boolean =>
    spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        `${PROJECT}_data`,
        '-e',
        `PGPASSWORD=${password}`,
        OPENSSL_IMAGE,
        'psql',
        '-h',
        'postgres',
        '-U',
        'ops_app',
        '-d',
        'company_ops',
        '-c',
        'select 1',
      ],
      { stdio: 'ignore' },
    ).status === 0;
  const oldDbRefused = !connects(oldDb) && connects(db);
  const oldRedisReply = spawnSync(
    'docker',
    ['exec', '-e', `REDISCLI_AUTH=${oldRedis}`, `${PROJECT}-redis-1`, 'redis-cli', 'ping'],
    { encoding: 'utf8' },
  );
  const oldRedisRefused = !oldRedisReply.stdout.includes('PONG');
  const session = readFileSync(join(dir, 'journey', 'session'), 'utf8').trim();
  const me = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `${PROJECT}_edge`,
      `${values.registry}/ops-api:${values.version ?? 'p9'}`,
      'node',
      '-e',
      `fetch('http://api:4000/api/v1/me',{headers:{cookie:'__Host-ops_sid=${session}'}}).then(r=>{console.log(r.status)})`,
    ],
    { encoding: 'utf8' },
  );
  const sessionKept = me.stdout.trim() === '200';
  console.log(
    `Rotation: old database password ${oldDbRefused ? 'refused' : 'STILL ACCEPTED'}; old Redis password ` +
      `${oldRedisRefused ? 'refused' : 'STILL ACCEPTED'}; existing session after key rotation ${sessionKept ? 'kept' : `LOST (${me.stdout.trim()})`}`,
  );
  return oldDbRefused && oldRedisRefused && sessionKept && (await journey(dir)) === 0;
}

if (command === 'up') {
  if (values.version === undefined) {
    console.error('usage: node scripts/release/rehearse.ts up --version <image tag> [--registry ops]');
    process.exit(2);
  }
  const dir = prepare(values.version, values.registry);
  console.log(`Rehearsal directory: ${dir}`);
  const started = Date.now();
  compose(dir, ['config', '--quiet']);
  compose(dir, ['up', '-d', '--wait', 'postgres', 'redis']);
  const migrateStarted = Date.now();
  compose(dir, ['run', '--rm', 'migrate']);
  console.log(`Migrations applied in ${String(Math.round((Date.now() - migrateStarted) / 1000))} s`);
  compose(dir, ['up', '-d', '--wait']);
  console.log(`Stack healthy ${String(Math.round((Date.now() - started) / 1000))} s after start`);
  process.exit(smoke(dir));
} else if (command === 'rotate' && values.dir !== undefined) {
  process.exit((await rotate(values.dir)) ? 0 : 1);
} else if (command === 'restore-drill' && values.dir !== undefined) {
  process.exit(restoreDrill(values.dir) ? 0 : 1);
} else if (command === 'journey' && values.dir !== undefined) {
  process.exit(await journey(values.dir));
} else if (command === 'smoke' && values.dir !== undefined) {
  process.exit(smoke(values.dir));
} else if (command === 'down' && values.dir !== undefined) {
  compose(values.dir, ['--profile', 'migrate', 'down', '--volumes', '--remove-orphans']);
  rmSync(values.dir, { recursive: true, force: true });
  console.log('Rehearsal stack and its volumes removed');
} else {
  console.error('usage: node scripts/release/rehearse.ts up --version <tag> | smoke --dir <dir> | down --dir <dir>');
  process.exit(2);
}
