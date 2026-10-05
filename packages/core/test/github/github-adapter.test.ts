import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemoryKeyValueStore } from '../../src/modules/jira/jira-coordination.js';
import { TOKEN_RENEW_MARGIN_MS } from '../../src/modules/github/github-client.js';
import { tokenCacheKey } from '../../src/modules/github/github-coordination.js';
import {
  APP_JWT_TTL_SECONDS,
  createAppJwt,
  loadAppPrivateKey,
  verifyWebhookSignature,
  webhookSignature,
} from '../../src/modules/github/github-crypto.js';
import { deriveChecks, deriveReviewState, requestedReviewerList } from '../../src/modules/github/github-derive.js';
import {
  classifyGithubResponse,
  GithubApiError,
  parseGithubRetryAfter,
  SECONDARY_LIMIT_WAIT_MS,
} from '../../src/modules/github/github-errors.js';
import {
  GITHUB_API_VERSION,
  GithubHttp,
  githubBackoffDelay,
  nextPageUrl,
} from '../../src/modules/github/github-http.js';
import { BODY_SCAN_LIMIT, inferJiraKeys, MAX_KEYS_PER_PULL } from '../../src/modules/github/github-jira-keys.js';
import { createGithubRuntime } from '../../src/modules/github/github-runtime.js';
import { pullSignals, repositoryStale } from '../../src/modules/github/github-views.js';
import type { CheckRunWire, ReviewWire } from '../../src/modules/github/github-wire.js';
import { EnvelopeCipher } from '../../src/platform/crypto/envelope-cipher.js';
import { FakeGithub } from '../../src/testing/fake-github.js';

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('webhook signatures (X-Hub-Signature-256)', () => {
  it("matches GitHub's documented test vector", () => {
    expect(webhookSignature("It's a Secret to Everybody", Buffer.from('Hello, World!'))).toBe(
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );
  });

  it('accepts only an exact HMAC-SHA256 of the raw bytes', () => {
    const secret = 'webhook-secret';
    const body = Buffer.from('{"action":"opened"}');
    const header = webhookSignature(secret, body);
    expect(verifyWebhookSignature(secret, body, header)).toBe(true);
    expect(verifyWebhookSignature(secret, body, header.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
    expect(verifyWebhookSignature('other-secret', body, header)).toBe(false);
    expect(verifyWebhookSignature(secret, Buffer.from('{"action":"closed"}'), header)).toBe(false);
    expect(verifyWebhookSignature(secret, Buffer.from('{"action":"opened"} '), header)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header.slice(0, -2))).toBe(false);
  });

  it('never accepts the legacy SHA-1 signature format', () => {
    const body = Buffer.from('{}');
    expect(verifyWebhookSignature('s', body, `sha1=${'a'.repeat(40)}`)).toBe(false);
    expect(verifyWebhookSignature('s', body, 'a'.repeat(64))).toBe(false);
  });
});

describe('App JWT and private key', () => {
  it('signs RS256 JWTs with backdated iat, exp within ten minutes and the client ID as issuer', () => {
    const key = loadAppPrivateKey(PEM);
    const now = 1_800_000_000;
    const { token, expiresAt } = createAppJwt('Iv23liFakeClient', key, now);
    const [header = '', payload = '', signature = ''] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({ iat: now - 60, exp: now + APP_JWT_TTL_SECONDS, iss: 'Iv23liFakeClient' });
    expect(now + APP_JWT_TTL_SECONDS - (now - 60)).toBeLessThanOrEqual(600);
    expect(expiresAt).toBe((now + APP_JWT_TTL_SECONDS) * 1000);
    expect(
      verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey(PEM), Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('rejects unusable keys without echoing key material', () => {
    const garbage = '-----BEGIN PRIVATE KEY-----\nTUlJQ-not-a-key\n-----END PRIVATE KEY-----';
    expect(() => loadAppPrivateKey(garbage)).toThrow(/not a readable PEM private key/);
    try {
      loadAppPrivateKey(garbage);
    } catch (error) {
      expect(String(error)).not.toContain('TUlJQ');
    }
    const { privateKey: ec } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() => loadAppPrivateKey(ec)).toThrow(/must be an RSA key/);
  });
});

describe('response classification', () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  const now = 1_800_000_000_000;

  it('classifies every documented failure', () => {
    expect(classifyGithubResponse(401, headers({}), null, now).kind).toBe('unauthorized');
    expect(classifyGithubResponse(403, headers({}), 'Resource not accessible by integration', now).kind).toBe(
      'forbidden',
    );
    expect(classifyGithubResponse(404, headers({}), null, now).kind).toBe('not_found');
    expect(classifyGithubResponse(410, headers({}), null, now).kind).toBe('gone');
    expect(classifyGithubResponse(422, headers({}), null, now).kind).toBe('invalid_request');
    expect(classifyGithubResponse(500, headers({}), null, now).kind).toBe('unavailable');
    expect(classifyGithubResponse(503, headers({ 'retry-after': '7' }), null, now).retryAfterMs).toBe(7_000);
  });

  it('recognises the primary limit and waits until the reset', () => {
    const reset = Math.floor(now / 1000) + 120;
    const error = classifyGithubResponse(
      403,
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-ratelimit-limit': '5000' }),
      'API rate limit exceeded',
      now,
    );
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(121_000);
    expect(error.rateLimit?.remaining).toBe(0);
    expect(error.retryable).toBe(true);
  });

  it('recognises secondary limits with and without Retry-After', () => {
    expect(classifyGithubResponse(403, headers({ 'retry-after': '30' }), null, now)).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 30_000,
    });
    expect(
      classifyGithubResponse(403, headers({}), 'You have exceeded a secondary rate limit.', now).retryAfterMs,
    ).toBe(SECONDARY_LIMIT_WAIT_MS);
    expect(classifyGithubResponse(429, headers({}), null, now).kind).toBe('rate_limited');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseGithubRetryAfter('5', now)).toBe(5_000);
    expect(parseGithubRetryAfter(new Date(now + 9_000).toUTCString(), now)).toBe(9_000);
    expect(parseGithubRetryAfter('soon', now)).toBeNull();
    expect(parseGithubRetryAfter(null, now)).toBeNull();
  });

  it('persists short codes and marks only transient kinds retryable', () => {
    expect(new GithubApiError('forbidden', 403, 'x').code).toBe('github_forbidden');
    expect(new GithubApiError('timeout', null, 'x').retryable).toBe(true);
    expect(new GithubApiError('not_found', 404, 'x').retryable).toBe(false);
    expect(new GithubApiError('malformed', 200, 'x').retryable).toBe(false);
  });
});

describe('HTTP transport', () => {
  const schema = z.object({ ok: z.boolean() });
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

  function transport(responses: (() => Response | Promise<Response>)[], options: { maxRetries?: number } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const sleeps: number[] = [];
    const http = new GithubHttp({
      fetch: (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next === undefined) {
          throw new Error('unexpected request');
        }
        return Promise.resolve(next());
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: 50,
    });
    return { http, calls, sleeps };
  }

  const get = { method: 'GET' as const, url: 'https://api.github.test/x', schema, idempotent: true };

  it('sends the API version and parses a 200', async () => {
    const { http, calls } = transport([() => json(200, { ok: true }, { 'x-ratelimit-remaining': '4999' })]);
    const result = await http.request(get);
    expect(result.data).toEqual({ ok: true });
    expect(result.rateLimit?.remaining).toBe(4999);
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get('x-github-api-version')).toBe(GITHUB_API_VERSION);
    expect(sent.get('accept')).toBe('application/vnd.github+json');
  });

  it('follows same-origin pagination only', async () => {
    const { http } = transport([
      () => json(200, { ok: true }, { link: '<https://api.github.test/x?page=2>; rel="next"' }),
      () => json(200, { ok: true }, { link: '<https://evil.test/x?page=3>; rel="next"' }),
    ]);
    expect((await http.request(get)).next).toBe('https://api.github.test/x?page=2');
    expect((await http.request(get)).next).toBeNull();
    expect(
      nextPageUrl('<https://a.test/p?page=2>; rel="next", <https://a.test/p?page=9>; rel="last"', 'https://a.test/p'),
    ).toBe('https://a.test/p?page=2');
    expect(nextPageUrl('<not a url>; rel="next"', 'https://a.test/p')).toBeNull();
  });

  it('does not retry 401, 403 or 404', async () => {
    for (const status of [401, 403, 404]) {
      const { http, calls } = transport([() => json(status, { message: 'no' }), () => json(200, { ok: true })]);
      await expect(http.request(get)).rejects.toBeInstanceOf(GithubApiError);
      expect(calls).toHaveLength(1);
    }
  });

  it('retries 5xx with backoff, then succeeds', async () => {
    const { http, calls, sleeps } = transport([() => json(502, {}), () => json(200, { ok: true })]);
    expect((await http.request(get)).data.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([githubBackoffDelay(0, () => 0.5)]);
  });

  it('honours a short Retry-After inline and surfaces a long one as rate_limited', async () => {
    const short = transport([
      () => json(403, { message: 'secondary rate limit' }, { 'retry-after': '2' }),
      () => json(200, { ok: true }),
    ]);
    await short.http.request(get);
    expect(short.sleeps).toEqual([2_000]);
    const long = transport([() => json(403, { message: 'secondary rate limit' }, { 'retry-after': '120' })]);
    await expect(long.http.request(get)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    expect(long.sleeps).toEqual([]);
  });

  it('stops after the retry budget', async () => {
    const { http, calls } = transport([() => json(500, {}), () => json(500, {}), () => json(500, {})], {
      maxRetries: 2,
    });
    await expect(http.request(get)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(calls).toHaveLength(3);
  });

  it('never retries non-idempotent requests', async () => {
    const { http, calls } = transport([() => json(500, {}), () => json(200, { ok: true })]);
    await expect(http.request({ ...get, method: 'POST', idempotent: false })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls).toHaveLength(1);
  });

  it('classifies timeouts and network failures', async () => {
    const timeout = transport(
      [
        () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
      ],
      { maxRetries: 0 },
    );
    await expect(timeout.http.request(get)).rejects.toMatchObject({ kind: 'timeout' });
    const offline = transport(
      [
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      { maxRetries: 0 },
    );
    await expect(offline.http.request(get)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('rejects malformed 2xx bodies instead of accepting them', async () => {
    const html = transport([() => new Response('<html></html>', { status: 200 })]);
    await expect(html.http.request(get)).rejects.toMatchObject({ kind: 'malformed' });
    const shape = transport([() => json(200, { ok: 'yes' })]);
    await expect(shape.http.request(get)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('keeps backoff bounded with jitter', () => {
    expect(githubBackoffDelay(0, () => 0)).toBe(700);
    expect(githubBackoffDelay(0, () => 1)).toBe(1_300);
    expect(githubBackoffDelay(20, () => 1)).toBe(30_000);
  });
});

describe('installation token cache', () => {
  function setup() {
    let clock = Date.parse('2026-10-03T10:00:00Z');
    const fake = new FakeGithub({
      privateKeyPem: PEM,
      appId: '123456',
      clientId: 'Iv23liFakeClient',
      clientSecret: 'fake-secret',
      slug: 'company-ops-test',
      webhookSecret: 'fake-webhook-secret',
      now: () => clock,
    });
    const kv = new InMemoryKeyValueStore(() => clock);
    const cipher = new EnvelopeCipher({ id: 'k1', key: randomBytes(32) });
    const runtime = createGithubRuntime({
      settings: {
        appId: '123456',
        clientId: 'Iv23liFakeClient',
        privateKey: loadAppPrivateKey(PEM),
        clientSecret: null,
        slug: null,
        webhookSecret: null,
        apiBaseUrl: 'http://fake-github.test',
        webBaseUrl: 'http://fake-github.test',
        publicUrl: 'http://localhost:3000',
      },
      fetch: fake.fetch,
      kv,
      cipher,
      http: { sleep: () => Promise.resolve(), maxRetries: 1 },
      now: () => clock,
    });
    return {
      fake,
      kv,
      runtime,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('shares one token between concurrent callers', async () => {
    const { fake, runtime } = setup();
    const tokens = await Promise.all(Array.from({ length: 8 }, () => runtime.tokens.installationToken('1001')));
    expect(new Set(tokens).size).toBe(1);
    expect(fake.tokensIssued).toBe(1);
  });

  it('keeps tokens until shortly before expires_at, whatever their length', async () => {
    const { fake, runtime, advance } = setup();
    const first = await runtime.tokens.installationToken('1001');
    advance(60 * 60 * 1000 - TOKEN_RENEW_MARGIN_MS - 1_000);
    expect(await runtime.tokens.installationToken('1001')).toBe(first);
    advance(2_000);
    const second = await runtime.tokens.installationToken('1001');
    expect(second).not.toBe(first);
    expect(second.length).not.toBe(first.length);
    expect(fake.tokensIssued).toBe(2);
  });

  it('stores tokens only encrypted in the shared cache', async () => {
    const { kv, runtime } = setup();
    const token = await runtime.tokens.installationToken('1001');
    const stored = await kv.get(tokenCacheKey('1001'));
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('ghs_');
  });

  it('renews a token GitHub rejected and drops it on invalidate', async () => {
    const { fake, runtime } = setup();
    const first = await runtime.tokens.installationToken('1001');
    const renewed = await runtime.tokens.installationToken('1001', first);
    expect(renewed).not.toBe(first);
    await runtime.tokens.invalidate('1001');
    expect(await runtime.tokens.installationToken('1001')).not.toBe(renewed);
    expect(fake.tokensIssued).toBe(3);
  });

  it('refuses suspended installations', async () => {
    const { fake, runtime } = setup();
    fake.suspend(1001);
    await expect(runtime.tokens.installationToken('1001')).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('review and check derivation', () => {
  const review = (id: number, login: string, state: string, at: string): ReviewWire => ({
    id,
    user: { login },
    state,
    submitted_at: at,
  });

  it("uses each reviewer's latest decisive review", () => {
    expect(deriveReviewState([], [])).toBe('NONE');
    expect(deriveReviewState([], ['alice'])).toBe('REVIEW_REQUIRED');
    expect(deriveReviewState([review(1, 'a', 'APPROVED', '2026-10-01T00:00:00Z')], [])).toBe('APPROVED');
    expect(
      deriveReviewState(
        [
          review(1, 'a', 'CHANGES_REQUESTED', '2026-10-01T00:00:00Z'),
          review(2, 'a', 'APPROVED', '2026-10-02T00:00:00Z'),
        ],
        [],
      ),
    ).toBe('APPROVED');
    expect(
      deriveReviewState(
        [
          review(1, 'a', 'APPROVED', '2026-10-01T00:00:00Z'),
          review(2, 'b', 'CHANGES_REQUESTED', '2026-10-02T00:00:00Z'),
        ],
        [],
      ),
    ).toBe('CHANGES_REQUESTED');
    expect(
      deriveReviewState(
        [
          review(1, 'a', 'CHANGES_REQUESTED', '2026-10-01T00:00:00Z'),
          review(2, 'a', 'COMMENTED', '2026-10-02T00:00:00Z'),
        ],
        [],
      ),
    ).toBe('CHANGES_REQUESTED');
    expect(
      deriveReviewState(
        [
          review(1, 'a', 'CHANGES_REQUESTED', '2026-10-01T00:00:00Z'),
          review(2, 'a', 'DISMISSED', '2026-10-02T00:00:00Z'),
        ],
        ['b'],
      ),
    ).toBe('REVIEW_REQUIRED');
    expect(deriveReviewState([review(1, 'a', 'APPROVED', '2026-10-01T00:00:00Z')], ['b'])).toBe('REVIEW_REQUIRED');
  });

  it('lists requested users and teams', () => {
    expect(
      requestedReviewerList({ requested_reviewers: [{ login: 'a' }], requested_teams: [{ slug: 'core' }] }),
    ).toEqual(['a', 'team:core']);
  });

  it('summarises check runs and commit statuses with failing over pending over passing', () => {
    const run = (status: string, conclusion: string | null): CheckRunWire => ({ id: 1, status, conclusion });
    expect(deriveChecks([], null)).toEqual({ state: 'UNKNOWN', total: 0, failed: 0, pending: 0 });
    expect(deriveChecks([run('completed', 'success'), run('completed', 'skipped')], null).state).toBe('SUCCESS');
    expect(deriveChecks([run('in_progress', null), run('completed', 'success')], null).state).toBe('PENDING');
    expect(deriveChecks([run('in_progress', null), run('completed', 'timed_out')], null)).toEqual({
      state: 'FAILURE',
      total: 2,
      failed: 1,
      pending: 1,
    });
    expect(
      deriveChecks([run('completed', 'success')], { state: 'failure', total_count: 1, statuses: [{ state: 'error' }] })
        .state,
    ).toBe('FAILURE');
    expect(deriveChecks([], { state: 'pending', total_count: 1, statuses: [{ state: 'pending' }] }).state).toBe(
      'PENDING',
    );
  });
});

describe('Jira key inference', () => {
  it('finds keys in branch (any case), title and body, keeping the strongest source', () => {
    expect(
      inferJiraKeys({ branch: 'feature/ihd-42-login', title: 'IHD-42 and TMP-7: fix', body: 'Refs POS-3 and IHD-42' }),
    ).toEqual([
      { key: 'IHD-42', source: 'BRANCH_NAME' },
      { key: 'TMP-7', source: 'TITLE' },
      { key: 'POS-3', source: 'BODY' },
    ]);
  });

  it('ignores lower-case keys outside the branch and malformed candidates', () => {
    expect(inferJiraKeys({ branch: 'main', title: 'ihd-42 fix', body: 'IHD-0, X-1, IHD-42x, aIHD-5' })).toEqual([]);
  });

  it('scans only the first part of the body and caps the number of keys', () => {
    const late = `${'x'.repeat(BODY_SCAN_LIMIT)} IHD-99`;
    expect(inferJiraKeys({ branch: 'main', title: 'x', body: late })).toEqual([]);
    const many = Array.from({ length: MAX_KEYS_PER_PULL + 10 }, (_, i) => `AB-${String(i + 1)}`).join(' ');
    expect(inferJiraKeys({ branch: 'main', title: 'x', body: many })).toHaveLength(MAX_KEYS_PER_PULL);
  });
});

describe('pull request signals', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const fresh = {
    id: 'repo-1',
    fullName: 'acme-org/ops-platform',
    status: 'AVAILABLE' as 'AVAILABLE' | 'REMOVED' | 'DELETED',
    lastFullSyncAt: new Date('2026-10-03T11:00:00Z') as Date | null,
    lastReconciledAt: null,
  };
  const base = {
    state: 'OPEN' as const,
    draft: false,
    reviewState: 'APPROVED' as const,
    checksState: 'SUCCESS' as const,
    repository: fresh,
  };
  const hour = 60 * 60 * 1000;

  it('flags operational states only (no per-person metrics)', () => {
    expect(pullSignals(base, now, 6 * hour)).toEqual([]);
    expect(pullSignals({ ...base, draft: true, reviewState: 'NONE' }, now, 6 * hour)).toEqual(['DRAFT']);
    expect(pullSignals({ ...base, reviewState: 'REVIEW_REQUIRED' }, now, 6 * hour)).toEqual(['AWAITING_REVIEW']);
    expect(pullSignals({ ...base, reviewState: 'CHANGES_REQUESTED', checksState: 'FAILURE' }, now, 6 * hour)).toEqual([
      'CHANGES_REQUESTED',
      'FAILING_CHECKS',
    ]);
    expect(pullSignals({ ...base, state: 'MERGED', checksState: 'FAILURE' }, now, 6 * hour)).toEqual([]);
  });

  it('marks stale or unavailable repositories', () => {
    expect(repositoryStale(fresh, now, 6 * hour)).toBe(false);
    expect(repositoryStale({ ...fresh, lastFullSyncAt: new Date('2026-10-03T01:00:00Z') }, now, 6 * hour)).toBe(true);
    expect(repositoryStale({ ...fresh, lastFullSyncAt: null }, now, 6 * hour)).toBe(true);
    expect(repositoryStale({ ...fresh, status: 'REMOVED' }, now, 6 * hour)).toBe(true);
    const removed = { ...fresh, status: 'REMOVED' as const };
    expect(pullSignals({ ...base, repository: removed }, now, 6 * hour)).toEqual(['STALE_SYNC']);
  });
});
