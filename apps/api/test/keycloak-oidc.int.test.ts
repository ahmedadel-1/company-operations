import { createHash } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_USERS } from '@company-ops/core';
import { createEmployeeResponseSchema, errorEnvelopeSchema, meResponseSchema } from '@company-ops/validation';

import { SESSION_COOKIE } from '../src/auth/session/cookies.js';
import { CookieJar, parseForm, startKeycloak, totp } from './support/keycloak.js';
import type { StartedKeycloak } from './support/keycloak.js';
import { freePort, seed, startApiStack } from './support/stack.js';
import type { ApiStack } from './support/stack.js';

/**
 * Real Keycloak 26.8.0 (repository realm import) + real API + PostgreSQL + Redis. The browser is
 * simulated with plain HTTP requests: redirects are followed manually and Keycloak's HTML forms
 * are submitted, so every step of Authorization Code + PKCE runs for real.
 */
let keycloak: StartedKeycloak;
let stack: ApiStack;
let organizationId: string;
let apiPort: number;
let adminApi: CookieJar | undefined;

interface BrowserResult {
  readonly api: CookieJar;
  readonly keycloak: CookieJar;
  readonly finalLocation: string;
  readonly trail: readonly string[];
}

const user = (username: string) => {
  const found = DEMO_USERS.find((u) => u.username === username);
  if (found === undefined) {
    throw new Error(`unknown demo user ${username}`);
  }
  return found;
};

/**
 * Follows the redirect chain from `startPath` on the API through Keycloak and back, filling the
 * login form, the TOTP enrolment form and the OTP form. Stops at the first redirect that leaves
 * the auth flow (the post-login target).
 */
async function browse(
  startPath: string,
  username: string,
  jars?: { api: CookieJar; keycloak: CookieJar },
): Promise<BrowserResult> {
  const api = jars?.api ?? new CookieJar();
  const kc = jars?.keycloak ?? new CookieJar();
  const trail: string[] = [];
  let totpSecret: Buffer | undefined;
  let url = `${stack.baseUrl}${startPath}`;
  let method: 'GET' | 'POST' = 'GET';
  let body: URLSearchParams | undefined;

  for (let step = 0; step < 20; step += 1) {
    const toApi = url.startsWith(stack.baseUrl);
    const jar = toApi ? api : kc;
    trail.push(`${method} ${url}`);
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      headers: { cookie: jar.header() },
    });
    jar.store(response);
    method = 'GET';
    body = undefined;

    if (response.status >= 300 && response.status < 400) {
      const location = new URL(response.headers.get('location') ?? '', url).href;
      const isAuthStep = location.startsWith(keycloak.baseUrl) || location.startsWith(`${stack.baseUrl}/api/v1/auth/`);
      if (!isAuthStep) {
        return { api, keycloak: kc, finalLocation: location, trail };
      }
      url = location;
      continue;
    }
    if (response.status !== 200 || toApi) {
      throw new Error(`Unexpected ${String(response.status)} at ${url}: ${(await response.text()).slice(0, 300)}`);
    }
    const html = await response.text();
    const form = parseForm(html);
    const fields = new URLSearchParams(form.fields);
    if (html.includes('name="username"')) {
      fields.set('username', username);
      fields.set('password', keycloak.demoPassword);
    } else if (form.fields.totpSecret !== undefined) {
      totpSecret = Buffer.from(form.fields.totpSecret, 'utf8');
      fields.set('totp', totp(totpSecret));
      fields.set('userLabel', 'integration-test');
    } else if (html.includes('name="otp"') && totpSecret !== undefined) {
      fields.set('otp', totp(totpSecret));
    } else {
      throw new Error(`Unrecognised Keycloak page at ${url}: ${html.slice(0, 300)}`);
    }
    url = form.action;
    method = 'POST';
    body = fields;
  }
  throw new Error(`Login did not finish: ${trail.join(' -> ')}`);
}

function apiFetch(path: string, jar: CookieJar, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', jar.header());
  return fetch(`${stack.baseUrl}/api/v1${path}`, { ...init, headers, redirect: 'manual' });
}

async function csrfToken(jar: CookieJar): Promise<string> {
  const response = await apiFetch('/auth/csrf', jar);
  return ((await response.json()) as { data: { csrfToken: string } }).data.csrfToken;
}

beforeAll(async () => {
  apiPort = await freePort();
  const publicUrl = `http://localhost:${String(apiPort)}`;
  keycloak = await startKeycloak({
    appPublicUrl: publicUrl,
    backchannelLogoutUrl: `http://host.docker.internal:${String(apiPort)}/api/v1/auth/backchannel-logout`,
  });
  stack = await startApiStack({
    issuer: keycloak.issuer,
    listen: { port: apiPort, host: '0.0.0.0' },
    // Many logins from one test IP; rate limiting itself is covered by http-security.int.test.ts.
    overrides: {
      APP_PUBLIC_URL: publicUrl,
      OIDC_CLIENT_SECRET: keycloak.clientSecret,
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
    },
  });
  organizationId = await seed(stack);
}, 400_000);

afterAll(async () => {
  await stack.stop();
  await keycloak.stop();
});

describe('Keycloak realm (imported from infra/docker/keycloak/realms)', () => {
  it('serves discovery and a JWKS for the company-ops realm', async () => {
    const discovery = (await (await fetch(`${keycloak.issuer}/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >;
    expect(discovery.issuer).toBe(keycloak.issuer);
    expect(discovery.authorization_endpoint).toBe(`${keycloak.issuer}/protocol/openid-connect/auth`);
    expect(discovery.token_endpoint).toBe(`${keycloak.issuer}/protocol/openid-connect/token`);
    expect(discovery.end_session_endpoint).toBe(`${keycloak.issuer}/protocol/openid-connect/logout`);
    expect(discovery.code_challenge_methods_supported).toContain('S256');
    expect(discovery.backchannel_logout_supported).toBe(true);
    const jwks = (await (await fetch(String(discovery.jwks_uri))).json()) as { keys: { alg?: string; use?: string }[] };
    expect(jwks.keys.some((k) => k.alg === 'RS256' && k.use === 'sig')).toBe(true);
  });

  it('configures ops-api as a confidential Authorization Code + PKCE client (admin API)', async () => {
    const token = await keycloak.adminToken();
    const headers = { authorization: `Bearer ${token}` };
    const admin = `${keycloak.baseUrl}/admin/realms/company-ops`;
    const [client] = (await (await fetch(`${admin}/clients?clientId=ops-api`, { headers })).json()) as Record<
      string,
      unknown
    >[];
    expect(client).toMatchObject({
      publicClient: false,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [`${stack.env.APP_PUBLIC_URL}/api/v1/auth/callback`],
      attributes: expect.objectContaining({
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${stack.env.APP_PUBLIC_URL}/`,
        'backchannel.logout.session.required': 'true',
      }) as unknown,
    });
    const realm = (await (await fetch(admin, { headers })).json()) as {
      browserFlow: string;
      attributes: Record<string, string>;
      bruteForceProtected: boolean;
    };
    expect(realm.browserFlow).toBe('loa browser');
    expect(JSON.parse(realm.attributes['acr.loa.map'] ?? '{}')).toEqual({ pwd: 1, mfa: 2 });
    expect(realm.bruteForceProtected).toBe(true);
    const executions = (await (
      await fetch(`${admin}/authentication/flows/loa%20browser/executions`, { headers })
    ).json()) as {
      providerId?: string;
    }[];
    expect(executions.map((e) => e.providerId)).toEqual(
      expect.arrayContaining([
        'auth-cookie',
        'conditional-level-of-authentication',
        'auth-username-password-form',
        'auth-otp-form',
      ]),
    );
    const users = (await (await fetch(`${admin}/users?max=50`, { headers })).json()) as {
      id: string;
      username: string;
    }[];
    for (const demo of DEMO_USERS) {
      expect(users.find((u) => u.username === demo.username)?.id).toBe(demo.subject);
    }
  });

  it('rejects the password grant, implicit flow, missing PKCE and unregistered redirect URIs', async () => {
    const tokenEndpoint = `${keycloak.issuer}/protocol/openid-connect/token`;
    const password = await fetch(tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'ops-api',
        client_secret: keycloak.clientSecret,
        username: 'employee',
        password: keycloak.demoPassword,
      }),
    });
    expect(password.status).toBeGreaterThanOrEqual(400);
    expect(((await password.json()) as { error: string }).error).toBe('unauthorized_client');

    const authorize = (params: Record<string, string>) =>
      fetch(
        `${keycloak.issuer}/protocol/openid-connect/auth?${new URLSearchParams({ client_id: 'ops-api', scope: 'openid', state: 's', ...params }).toString()}`,
        {
          redirect: 'manual',
        },
      );
    const callback = `${stack.env.APP_PUBLIC_URL}/api/v1/auth/callback`;
    const noPkce = await authorize({ response_type: 'code', redirect_uri: callback });
    expect(noPkce.headers.get('location') ?? '').toMatch(/error=invalid_request/);
    const implicit = await authorize({ response_type: 'token', redirect_uri: callback, nonce: 'n' });
    expect(implicit.headers.get('location') ?? '').toMatch(/error=unauthorized_client|error=unsupported_response_type/);
    const badRedirect = await authorize({
      response_type: 'code',
      redirect_uri: 'https://evil.example/cb',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    expect(badRedirect.status).toBe(400);
  });
});

describe('OIDC login through the API (Authorization Code + PKCE, server-side callback)', () => {
  it('logs in an employee end to end and creates a server-side session', async () => {
    const result = await browse('/api/v1/auth/login?returnTo=/dashboard', 'employee');
    expect(result.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/dashboard`);
    const authorize = new URL(
      result.trail.find((t) => t.includes('/protocol/openid-connect/auth'))?.split(' ')[1] ?? '',
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).not.toBeNull();
    expect(authorize.searchParams.get('nonce')).not.toBeNull();
    expect(authorize.searchParams.get('client_secret')).toBeNull();

    expect(result.api.get(SESSION_COOKIE)).toBeDefined();
    const me = meResponseSchema.parse(await (await apiFetch('/me', result.api)).json());
    expect(me.data.activeOrganization.id).toBe(organizationId);
    expect(me.data.mfa).toEqual({ satisfied: false, acr: 'pwd' });
    const dbUser = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: user('employee').subject } });
    expect(dbUser.idpIssuer).toBe(keycloak.issuer);
    expect(
      await stack.prisma.auditLog.count({ where: { action: 'auth.login.succeeded', actorUserId: dbUser.id } }),
    ).toBeGreaterThan(0);
  });

  it('a callback cannot be replayed and a forged state is rejected', async () => {
    const api = new CookieJar();
    const login = await fetch(`${stack.baseUrl}/api/v1/auth/login`, { redirect: 'manual' });
    api.store(login);
    const authorizeUrl = new URL(login.headers.get('location') ?? '');
    const tampered = new URL(`${stack.baseUrl}/api/v1/auth/callback`);
    tampered.searchParams.set('code', 'forged-code');
    tampered.searchParams.set('state', `${authorizeUrl.searchParams.get('state') ?? ''}x`);
    const forged = await fetch(tampered, { redirect: 'manual', headers: { cookie: api.header() } });
    expect(forged.headers.get('location')).toBe(`${stack.env.APP_PUBLIC_URL}/?authError=callback_rejected`);
    expect(
      forged.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)),
    ).toBe(false);
    // The transaction was consumed by the failed attempt: replaying with the same cookie fails too.
    const replay = await fetch(tampered, { redirect: 'manual', headers: { cookie: api.header() } });
    expect(replay.headers.get('location')).toBe(`${stack.env.APP_PUBLIC_URL}/?authError=transaction_missing`);
  });

  it('login replaces any pre-existing session id (fixation)', async () => {
    const first = await browse('/api/v1/auth/login', 'hr');
    const before = first.api.get(SESSION_COOKIE) ?? '';
    const second = await browse('/api/v1/auth/login', 'hr', { api: first.api, keycloak: new CookieJar() });
    const after = second.api.get(SESSION_COOKIE) ?? '';
    expect(after).not.toBe(before);
    expect(await stack.sessions.load(before)).toBeNull();
    expect((await apiFetch('/me', second.api)).status).toBe(200);
  });

  it('rejects a user without an active membership (no session)', async () => {
    const result = await browse('/api/v1/auth/login', 'outsider');
    expect(result.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/?authError=no_active_membership`);
    expect(result.api.get(SESSION_COOKIE)).toBeUndefined();
    const disabled = await browse('/api/v1/auth/login', 'disabled');
    expect(disabled.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/?authError=no_active_membership`);
  });

  it('ORG_ADMIN must complete MFA at login (TOTP enrolment + acr=mfa) before a session exists', async () => {
    const result = await browse('/api/v1/auth/login?returnTo=/admin', 'org.admin');
    expect(result.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/admin`);
    const stepUp = result.trail.filter(
      (t) => t.includes('/protocol/openid-connect/auth') && t.includes('acr_values=mfa'),
    );
    expect(stepUp.length).toBe(1);
    const me = meResponseSchema.parse(await (await apiFetch('/me', result.api)).json());
    expect(me.data.mfa).toEqual({ satisfied: true, acr: 'mfa' });

    const employee = await stack.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId, user: { idpSubject: user('employee').subject } },
    });
    const role = await stack.prisma.role.findFirstOrThrow({ where: { organizationId, key: 'SUPPORT_AGENT' } });
    const grant = await apiFetch(`/members/${employee.id}/roles`, result.api, {
      method: 'POST',
      headers: {
        origin: stack.env.APP_PUBLIC_URL,
        'x-csrf-token': await csrfToken(result.api),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roleId: role.id }),
    });
    expect(grant.status).toBe(200);
    expect(await grant.json()).toEqual({ data: { created: true } });
    // The admin's TOTP secret exists only inside that browse; later tests reuse this MFA session.
    adminApi = result.api;
  });

  it('an invitation link binds the membership to whoever signs in with it, exactly once', async () => {
    if (adminApi === undefined) {
      throw new Error('requires the ORG_ADMIN session from the previous test');
    }
    const created = await apiFetch('/employees', adminApi, {
      method: 'POST',
      headers: {
        origin: stack.env.APP_PUBLIC_URL,
        'x-csrf-token': await csrfToken(adminApi),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fullName: 'Invited Outsider', workEmail: 'outsider@example.test' }),
    });
    expect(created.status).toBe(201);
    const invitation = createEmployeeResponseSchema.parse(await created.json()).data.invitation;
    const link = new URL(invitation.url);
    expect(link.origin).toBe(stack.env.APP_PUBLIC_URL);

    // The token travels in the OIDC transaction (server side), not through Keycloak.
    const accepted = await browse(`${link.pathname}${link.search}`, 'outsider');
    expect(
      accepted.trail.some((step) => step.startsWith(`GET ${keycloak.baseUrl}`) && step.includes('invitation')),
    ).toBe(false);
    expect(accepted.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/`);
    const me = meResponseSchema.parse(await (await apiFetch('/me', accepted.api)).json());
    expect(me.data.activeOrganization.id).toBe(organizationId);
    const outsider = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: user('outsider').subject } });
    expect(
      await stack.prisma.auditLog.count({
        where: { organizationId, action: 'member.invitation.accepted', actorUserId: outsider.id },
      }),
    ).toBe(1);

    // Single use: replaying the link (any identity) is rejected without creating a session.
    const replay = await browse(`${link.pathname}${link.search}`, 'gm');
    expect(replay.finalLocation).toBe(`${stack.env.APP_PUBLIC_URL}/?authError=invitation_invalid`);
    expect(replay.api.get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe('logout', () => {
  it('ends the session and returns the Keycloak end-session URL with id_token_hint', async () => {
    const result = await browse('/api/v1/auth/login', 'gm');
    const response = await apiFetch('/auth/logout', result.api, {
      method: 'POST',
      headers: { origin: stack.env.APP_PUBLIC_URL, 'x-csrf-token': await csrfToken(result.api) },
    });
    expect(response.status).toBe(200);
    const logoutUrl = new URL(((await response.json()) as { data: { logoutUrl: string } }).data.logoutUrl);
    expect(logoutUrl.href.startsWith(`${keycloak.issuer}/protocol/openid-connect/logout`)).toBe(true);
    expect(logoutUrl.searchParams.get('id_token_hint')).not.toBeNull();
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe(`${stack.env.APP_PUBLIC_URL}/`);
    expect((await apiFetch('/me', result.api)).status).toBe(401);

    const endSession = await fetch(logoutUrl, { redirect: 'manual', headers: { cookie: result.keycloak.header() } });
    expect(endSession.status).toBe(302);
    expect(endSession.headers.get('location')).toBe(`${stack.env.APP_PUBLIC_URL}/`);
    const gm = await stack.prisma.user.findFirstOrThrow({ where: { idpSubject: user('gm').subject } });
    expect(await stack.prisma.auditLog.count({ where: { action: 'auth.logout', actorUserId: gm.id } })).toBe(1);
  });

  it('back-channel logout from Keycloak deletes the API session', async () => {
    const result = await browse('/api/v1/auth/login', 'employee');
    expect((await apiFetch('/me', result.api)).status).toBe(200);
    const token = await keycloak.adminToken();
    const logout = await fetch(
      `${keycloak.baseUrl}/admin/realms/company-ops/users/${user('employee').subject}/logout`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(logout.status).toBe(204);
    let status = 200;
    for (let attempt = 0; attempt < 20 && status === 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = (await apiFetch('/me', result.api)).status;
    }
    expect(status).toBe(401);
    expect(await stack.prisma.auditLog.count({ where: { action: 'auth.logout.backchannel' } })).toBeGreaterThan(0);
  });

  it('rejects a forged back-channel logout token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'logout+jwt' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: keycloak.issuer, aud: 'ops-api', sid: 'x', jti: 'j', iat: 1, events: {} }),
    ).toString('base64url');
    const response = await fetch(`${stack.baseUrl}/api/v1/auth/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: `${header}.${payload}.c2lnbmF0dXJl` }),
    });
    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('session semantics without token refresh (ADR-0002 amendment)', () => {
  it('stores no access or refresh token; only the encrypted ID token', async () => {
    const result = await browse('/api/v1/auth/login', 'hr');
    const sessionId = result.api.get(SESSION_COOKIE) ?? '';
    const redis = new Redis(stack.env.REDIS_URL);
    try {
      const raw = (await redis.get(`ops:sess:${createHash('sha256').update(sessionId).digest('hex')}`)) ?? '';
      const record = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(record).filter((key) => /access|refresh/i.test(key))).toEqual([]);
      expect(typeof record.idTokenEnc).toBe('string');
      // No JWT in clear text anywhere in the record.
      expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
    } finally {
      redis.disconnect();
    }
  });

  it('a user disabled in Keycloak cannot sign in again; the existing session ends when Keycloak signs them out', async () => {
    const existing = await browse('/api/v1/auth/login', 'hr');
    expect((await apiFetch('/me', existing.api)).status).toBe(200);
    const admin = `${keycloak.baseUrl}/admin/realms/company-ops/users/${user('hr').subject}`;
    const setEnabled = async (enabled: boolean) => {
      const response = await fetch(admin, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await keycloak.adminToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      expect(response.status).toBe(204);
    };
    await setEnabled(false);
    try {
      await expect(browse('/api/v1/auth/login', 'hr')).rejects.toThrow();
      // No refresh call exists that could fail: the issued application session is still valid ...
      expect((await apiFetch('/me', existing.api)).status).toBe(200);
      // ... until Keycloak signs the user out (back-channel logout).
      const logout = await fetch(`${admin}/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await keycloak.adminToken()}` },
      });
      expect(logout.status).toBe(204);
      let status = 200;
      for (let attempt = 0; attempt < 20 && status === 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = (await apiFetch('/me', existing.api)).status;
      }
      expect(status).toBe(401);
    } finally {
      await setEnabled(true);
    }
  });
});
