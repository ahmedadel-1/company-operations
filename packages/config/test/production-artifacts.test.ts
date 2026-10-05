import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Release artifacts keep development and test material out of production (Phase 9 §56) and the
 * production realm does not drift from the development realm except where it must be stricter.
 * Static checks over the files that are deployed; the rehearsal (scripts/release/rehearse.ts) runs them.
 */
const root = join(import.meta.dirname, '..', '..', '..');
const read = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8');
const realm = (directory: string): Record<string, unknown> =>
  JSON.parse(read('infra', 'docker', 'keycloak', directory, 'company-ops-realm.json')) as Record<string, unknown>;

/** Top-level service blocks of a compose file (two-space indented keys under `services:`). */
function services(yaml: string): Map<string, string> {
  const body = yaml.slice(yaml.indexOf('\nservices:\n') + '\nservices:\n'.length);
  const end = body.search(/^\S/m);
  const section = end < 0 ? body : body.slice(0, end);
  const blocks = new Map<string, string>();
  for (const match of section.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\s*\n)*)/gm)) {
    blocks.set(match[1] ?? '', match[2] ?? '');
  }
  return blocks;
}

describe('production Keycloak realm', () => {
  const dev = realm('realms');
  const prod = realm('realms-prod');

  it('differs from the development realm only where production must be stricter', () => {
    const differing = [...new Set([...Object.keys(dev), ...Object.keys(prod)])]
      .filter((key) => JSON.stringify(dev[key]) !== JSON.stringify(prod[key]))
      .sort();
    expect(differing).toEqual([
      'adminEventsDetailsEnabled',
      'adminEventsEnabled',
      'displayName',
      'eventsEnabled',
      'eventsExpiration',
      'passwordPolicy',
      'sslRequired',
      'users',
    ]);
    expect(prod.users).toBeUndefined();
    // Sign-in and admin events are kept 30 days for incident investigation; admin event bodies are not
    // stored because they can contain credentials.
    expect(prod.eventsEnabled).toBe(true);
    expect(prod.eventsExpiration).toBe(2_592_000);
    expect(prod.adminEventsEnabled).toBe(true);
    expect(prod.adminEventsDetailsEnabled).toBe(false);
    expect(prod.sslRequired).toBe('all');
    expect(prod.displayName).not.toMatch(/develop|demo|test/i);
    expect(String(prod.passwordPolicy)).toContain(String(dev.passwordPolicy));
    expect(String(prod.passwordPolicy)).toContain('passwordHistory');
  });

  it('has no literal secrets, demo hosts or self-service shortcuts', () => {
    const text = read('infra', 'docker', 'keycloak', 'realms-prod', 'company-ops-realm.json');
    expect(text).not.toMatch(/localhost|127\.0\.0\.1|\.test\b|demo|mailpit/i);
    expect(prod.bruteForceProtected).toBe(true);
    expect(prod.registrationAllowed).toBe(false);
    const clients = prod.clients as { secret?: string; redirectUris: string[]; directAccessGrantsEnabled: boolean }[];
    for (const client of clients) {
      expect(client.secret).toBe('${OIDC_CLIENT_SECRET}');
      expect(client.directAccessGrantsEnabled).toBe(false);
      for (const uri of client.redirectUris) {
        expect(uri.startsWith('${APP_PUBLIC_URL}/')).toBe(true);
      }
    }
  });
});

describe('production compose', () => {
  const yaml = read('infra', 'compose', 'docker-compose.prod.yml');
  const blocks = services(yaml);

  it('contains no development services, seed, demo realm or published data ports', () => {
    expect([...blocks.keys()].sort()).toEqual(
      ['api', 'backup', 'keycloak', 'migrate', 'postgres', 'proxy', 'redis', 'web', 'worker'].sort(),
    );
    const configuration = yaml.replace(/^\s*#.*$/gm, '');
    expect(configuration).not.toMatch(/mailpit|mailhog|seed:dev|dev-seed|keycloak\/realms:|start-dev/i);
    for (const name of ['postgres', 'redis', 'migrate', 'backup', 'worker', 'api', 'web']) {
      expect(blocks.get(name), name).not.toMatch(/^ {4}ports:/m);
    }
    expect(blocks.get('keycloak')).toMatch(/- '127\.0\.0\.1:\$\{KC_ADMIN_TUNNEL_PORT:-8090\}:8080'/);
    expect(yaml).toMatch(/ {2}data:\n {4}driver: bridge\n {4}internal: true/);
  });

  it('pins every third-party image by digest and hardens the application containers', () => {
    for (const [name, block] of blocks) {
      const image = /^ {4}image: (\S+)/m.exec(block)?.[1];
      if (image === undefined) {
        continue;
      }
      if (image.startsWith('${OPS_IMAGE_REGISTRY')) {
        expect(image, name).toMatch(/:\$\{OPS_VERSION:\?/);
      } else {
        expect(image, name).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }
    for (const name of ['api', 'worker', 'web', 'migrate', 'backup']) {
      const block = blocks.get(name) ?? '';
      expect(block, name).toContain('<<: *hardening');
    }
    expect(yaml).toMatch(
      /x-hardening: &hardening\n(?: {2}.*\n)*? {2}read_only: true\n(?: {2}.*\n)*? {2}cap_drop: \[ALL\]/,
    );
  });

  it('starts the data stores as their unprivileged image users, never as root', () => {
    for (const name of ['postgres', 'redis', 'backup']) {
      expect(blocks.get(name), name).toMatch(/^ {4}user: '?999(:999)?'?$/m);
    }
  });

  it('passes secrets only as files, never as environment values', () => {
    for (const [name, block] of blocks) {
      for (const line of block.split('\n')) {
        const match = /^ {6}([A-Z0-9_]*(PASSWORD|SECRET|_KEY|TOKEN|DATABASE_URL|REDIS_URL)[A-Z0-9_]*): (.+)$/.exec(
          line,
        );
        if (match !== null) {
          expect(`${name}: ${match[1] ?? ''}`).toMatch(/_FILE$|KC_BOOTSTRAP_ADMIN_USERNAME|S3_ACCESS_KEY_ID/);
        }
      }
    }
  });
});

describe('production proxy and images', () => {
  it('enforces TLS 1.2+, HSTS and hides docs and identity administration', () => {
    const nginx = read('infra', 'nginx', 'prod', 'nginx.conf');
    const site = read('infra', 'nginx', 'prod', 'templates', 'ops.conf.template');
    expect(nginx).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
    expect(nginx).toMatch(/server_tokens off;/);
    expect(site).toMatch(/Strict-Transport-Security "max-age=63072000; includeSubDomains" always/);
    expect(site).toMatch(/location \/api\/v1\/docs \{\s*return 404;/);
    expect(site).toMatch(/location \^~ \/auth\/admin\/ \{\s*return 404;/);
    expect(site).toMatch(/location \^~ \/auth\/realms\/master\/ \{\s*return 404;/);
  });

  it('answers edge rate-limit rejections with Retry-After, HSTS and the API error envelope', () => {
    const site = read('infra', 'nginx', 'prod', 'templates', 'ops.conf.template');
    expect(site).toMatch(/error_page 429 = @ops_rate_limited;/);
    const handler = /location @ops_rate_limited \{([^}]*)\}/.exec(site)?.[1] ?? '';
    expect(handler).toMatch(/add_header Retry-After \d+ always;/);
    expect(handler).toMatch(/add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;/);
    expect(handler).toMatch(/"code":"RATE_LIMITED"/);
  });

  it('turns unreachable upstreams into 503 with Retry-After: the error envelope for API callers, a page for browsers', () => {
    const site = read('infra', 'nginx', 'prod', 'templates', 'ops.conf.template');
    const apiErrors = read('infra', 'nginx', 'prod', 'snippets', 'api-errors.conf');
    expect(site).toMatch(/^\s*error_page 502 503 504 = @ops_unavailable;/m);
    expect(apiErrors).toMatch(/^error_page 429 = @ops_rate_limited;$/m);
    expect(apiErrors).toMatch(/^error_page 502 503 504 = @ops_api_unavailable;$/m);
    const block = (name: string): string => new RegExp(`location ${name} \\{([^}]*)\\}`).exec(site)?.[1] ?? '';
    expect(block('@ops_api_unavailable')).toMatch(/"code":"DEPENDENCY_UNAVAILABLE"/);
    for (const name of ['@ops_api_unavailable', '@ops_unavailable']) {
      expect(block(name), name).toMatch(/return 503 /);
      expect(block(name), name).toMatch(/add_header Retry-After \d+ always;/);
      expect(block(name), name).toMatch(/add_header Strict-Transport-Security /);
    }
    for (const location of ['= /api/v1/notifications/events/stream', '/api/v1/webhooks/', '/api/']) {
      const body =
        new RegExp(`location ${location.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\{([^}]*)\\}`).exec(site)?.[1] ?? '';
      expect(body, location).toContain('include /etc/nginx/snippets/api-errors.conf;');
    }
    expect(site).not.toMatch(/proxy_intercept_errors on/);
  });

  it('builds non-root images from a pinned base without secrets in the context', () => {
    const dockerfile = read('infra', 'docker', 'app.Dockerfile');
    const ignore = read('.dockerignore');
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:[\d.]+-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^#\s*syntax=/m);
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
    const entries = ignore.split(/\r?\n/);
    for (const pattern of ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/secrets', '**/node_modules', '.git']) {
      expect(entries, pattern).toContain(pattern);
    }
  });
});
