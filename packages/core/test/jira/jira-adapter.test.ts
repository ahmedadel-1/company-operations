import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemoryKeyValueStore, JiraCoordination, LockBusyError } from '../../src/modules/jira/jira-coordination.js';
import {
  classifyJiraResponse,
  JiraApiError,
  JiraReauthRequiredError,
  JiraRequestRejectedError,
  JiraUnavailableError,
  parseRetryAfter,
  toJiraDomainError,
} from '../../src/modules/jira/jira-errors.js';
import { backoffDelay, JiraHttp } from '../../src/modules/jira/jira-http.js';
import type { FetchLike } from '../../src/modules/jira/jira-http.js';
import {
  importJql,
  isIssueKey,
  jqlString,
  linkSearchJql,
  minutesSince,
  reconcileJql,
  webhookJql,
} from '../../src/modules/jira/jira-jql.js';
import { issueDescriptionAdf } from '../../src/modules/jira/jira-links.service.js';
import {
  isBlockedStatus,
  issueBrowseUrl,
  parseJiraTimestamp,
  snapshotHash,
  toSnapshot,
  toStatusCategory,
} from '../../src/modules/jira/jira-mapper.js';
import { jiraRedirectUri, JiraOAuthClient, jiraWebhookUrl } from '../../src/modules/jira/jira-oauth.js';
import { canRegisterWebhooks, usesTestDouble } from '../../src/modules/jira/jira-runtime.js';
import { encryptTokens, tokenAad } from '../../src/modules/jira/jira-tokens.js';
import { signWebhookJwt, verifyWebhookJwt } from '../../src/modules/jira/jira-webhook-jwt.js';
import { createMetaIssueTypesSchema, issueSchema, webhookRefreshSchema } from '../../src/modules/jira/jira-wire.js';
import type { JiraIssueWire } from '../../src/modules/jira/jira-wire.js';
import { NotFoundError } from '../../src/platform/errors.js';
import { EnvelopeCipher } from '../../src/platform/crypto/envelope-cipher.js';
import { FakeJira, parseFakeJql } from '../../src/testing/fake-jira.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that answers from a queue and records every call. */
function scripted(responses: (Response | Error)[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const next = responses.shift();
      if (next === undefined) {
        return Promise.reject(new Error('no scripted response left'));
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const okSchema = z.object({ ok: z.literal(true) });

function http(
  fetch: FetchLike,
  sleeps: number[] = [],
  overrides: { maxRetries?: number; maxInlineWaitMs?: number } = {},
): JiraHttp {
  return new JiraHttp({
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...overrides,
  });
}

const issueWire = (overrides: Partial<JiraIssueWire['fields']> = {}): JiraIssueWire =>
  issueSchema.parse({
    id: '10001',
    key: 'OPS-1',
    fields: {
      summary: 'Login fails',
      issuetype: { name: 'Bug' },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'High' },
      assignee: { accountId: 'acc-1', displayName: 'Dev One' },
      reporter: { displayName: 'Reporter' },
      created: '2026-10-01T10:00:00.000+0000',
      updated: '2026-10-02T12:30:00.000+0200',
      duedate: '2026-10-10',
      resolution: null,
      resolutiondate: null,
      labels: ['web'],
      parent: null,
      project: { id: '20001', key: 'OPS' },
      ...overrides,
    },
  });

describe('Jira error classification', () => {
  it('classifies statuses the way the retry and re-auth logic expects', () => {
    const headers = new Headers();
    expect(classifyJiraResponse(429, headers).kind).toBe('rate_limited');
    expect(classifyJiraResponse(503, new Headers({ 'retry-after': '7' })).kind).toBe('rate_limited');
    expect(classifyJiraResponse(503, headers).kind).toBe('unavailable');
    expect(classifyJiraResponse(500, headers).kind).toBe('unavailable');
    expect(classifyJiraResponse(401, headers).kind).toBe('unauthorized');
    expect(classifyJiraResponse(403, headers).kind).toBe('forbidden');
    expect(classifyJiraResponse(404, headers).kind).toBe('not_found');
    expect(classifyJiraResponse(400, headers, ['summary']).fields).toEqual(['summary']);
    expect(classifyJiraResponse(429, new Headers({ 'retry-after': '3' })).retryAfterMs).toBe(3000);
  });

  it('marks only rate limits, outages and timeouts as retryable and exposes short codes', () => {
    expect(new JiraApiError('rate_limited', 429, 'x').retryable).toBe(true);
    expect(new JiraApiError('timeout', null, 'x').retryable).toBe(true);
    expect(new JiraApiError('unavailable', 502, 'x').retryable).toBe(true);
    expect(new JiraApiError('malformed', 200, 'x').retryable).toBe(false);
    expect(new JiraApiError('invalid_request', 400, 'x').retryable).toBe(false);
    expect(new JiraApiError('reauth_required', null, 'x').code).toBe('jira_reauth_required');
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-03T10:00:00Z');
    expect(parseRetryAfter('10', now)).toBe(10_000);
    expect(parseRetryAfter('Sat, 03 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 03 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });

  it('maps adapter failures to caller-facing domain errors without leaking details', () => {
    expect(toJiraDomainError(new JiraApiError('rate_limited', 429, 'x', { retryAfterMs: 2500 }))).toBeInstanceOf(
      JiraUnavailableError,
    );
    expect(toJiraDomainError(new JiraApiError('rate_limited', 429, 'x', { retryAfterMs: 2500 })).details).toEqual({
      retryAfterSeconds: 3,
    });
    expect(toJiraDomainError(new JiraApiError('malformed', 200, 'x'))).toBeInstanceOf(JiraUnavailableError);
    expect(toJiraDomainError(new JiraApiError('unauthorized', 401, 'x'))).toBeInstanceOf(JiraReauthRequiredError);
    expect(toJiraDomainError(new JiraApiError('not_found', 404, 'x'))).toBeInstanceOf(NotFoundError);
    const rejected = toJiraDomainError(new JiraApiError('invalid_request', 400, 'x', { fields: ['summary'] }));
    expect(rejected).toBeInstanceOf(JiraRequestRejectedError);
    expect(rejected.details).toEqual({ fields: ['summary'] });
  });
});

describe('Jira HTTP transport', () => {
  it('retries idempotent requests on outages with jittered backoff', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted([json(502, {}), json(500, {}), json(200, { ok: true })]);
    await expect(
      http(fetch, sleeps).request({ method: 'GET', url: 'https://j.test/a', schema: okSchema, idempotent: true }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([backoffDelay(0, () => 0.5), backoffDelay(1, () => 0.5)]);
  });

  it('never retries non-idempotent requests (issue create, code exchange)', async () => {
    const { fetch, calls } = scripted([json(503, {}), json(200, { ok: true })]);
    await expect(
      http(fetch).request({
        method: 'POST',
        url: 'https://j.test/issue',
        body: {},
        schema: okSchema,
        idempotent: false,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('honours a short Retry-After inline and surfaces a long one as rate_limited', async () => {
    const sleeps: number[] = [];
    const short = scripted([json(429, {}, { 'retry-after': '2' }), json(200, { ok: true })]);
    await http(short.fetch, sleeps).request({
      method: 'GET',
      url: 'https://j.test/a',
      schema: okSchema,
      idempotent: true,
    });
    expect(sleeps).toEqual([2000]);
    const long = scripted([json(429, {}, { 'retry-after': '120' })]);
    await expect(
      http(long.fetch).request({ method: 'GET', url: 'https://j.test/a', schema: okSchema, idempotent: true }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 120_000,
    });
  });

  it('stops after the retry budget', async () => {
    const { fetch, calls } = scripted([json(500, {}), json(500, {}), json(500, {})]);
    await expect(
      http(fetch, [], { maxRetries: 2 }).request({
        method: 'GET',
        url: 'https://j.test/a',
        schema: okSchema,
        idempotent: true,
      }),
    ).rejects.toBeInstanceOf(JiraApiError);
    expect(calls).toHaveLength(3);
  });

  it('rejects malformed 2xx bodies instead of accepting partial data', async () => {
    const wrongShape = scripted([json(200, { ok: 'yes' })]);
    await expect(
      http(wrongShape.fetch).request({ method: 'GET', url: 'https://j.test/a', schema: okSchema, idempotent: true }),
    ).rejects.toMatchObject({ kind: 'malformed' });
    const notJson = scripted([new Response('<html>', { status: 200 })]);
    await expect(
      http(notJson.fetch).request({ method: 'GET', url: 'https://j.test/a', schema: okSchema, idempotent: true }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('classifies network failures and timeouts', async () => {
    const down = scripted([new TypeError('fetch failed')]);
    await expect(
      http(down.fetch, [], { maxRetries: 0 }).request({
        method: 'GET',
        url: 'https://j.test/a',
        schema: okSchema,
        idempotent: true,
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const slow = scripted([new DOMException('timed out', 'TimeoutError')]);
    await expect(
      http(slow.fetch, [], { maxRetries: 0 }).request({
        method: 'GET',
        url: 'https://j.test/a',
        schema: okSchema,
        idempotent: true,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports rejected field names but never the error messages Jira returned', async () => {
    const { fetch } = scripted([
      json(400, {
        errors: { summary: 'Secret customer text is too long', 'bad key!': 'x' },
        errorMessages: ['internal'],
      }),
    ]);
    const error: unknown = await http(fetch)
      .request({ method: 'POST', url: 'https://j.test/issue', body: {}, schema: okSchema, idempotent: false })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraApiError);
    expect(error).toMatchObject({ kind: 'invalid_request', fields: ['summary'] });
    expect(JSON.stringify(error)).not.toContain('Secret customer text');
    expect(error instanceof Error ? error.message : '').not.toContain('Secret');
  });

  it('caps the backoff and keeps jitter inside 0.7–1.3', () => {
    expect(backoffDelay(0, () => 0)).toBe(700);
    expect(backoffDelay(0, () => 1)).toBe(1300);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
  });
});

describe('JQL builders', () => {
  it('only accepts numeric project ids', () => {
    expect(importJql('20001', null)).toBe('project = 20001 ORDER BY created ASC, key ASC');
    expect(importJql('20001', 15)).toBe('project = 20001 AND created >= -15m ORDER BY created ASC, key ASC');
    expect(reconcileJql('20001', 70)).toBe('project = 20001 AND updated >= -70m ORDER BY updated ASC, key ASC');
    expect(webhookJql(['20002', '20001'])).toBe('project in (20001, 20002)');
    expect(() => importJql('20001 OR 1=1', null)).toThrow();
    expect(() => webhookJql([])).toThrow();
  });

  it('keeps user text from becoming JQL syntax', () => {
    expect(linkSearchJql(['20001'], 'ops-12')).toBe('project = 20001 AND issuekey = "OPS-12" ORDER BY updated DESC');
    expect(linkSearchJql(['20001'], '')).toBe('project = 20001 ORDER BY updated DESC');
    const hostile = linkSearchJql(['20001', '20002'], 'login" OR project = 99999 ORDER BY key -- \\');
    expect(hostile).toBe(
      'project in (20001, 20002) AND text ~ "login OR project 99999 ORDER BY key" ORDER BY updated DESC',
    );
    expect(jqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(linkSearchJql(['20001'], 'x'.repeat(500)).length).toBeLessThan(200);
    expect(isIssueKey(' OPS-1 ')).toBe(true);
    expect(isIssueKey('OPS 1')).toBe(false);
  });

  it('computes relative windows with overlap and never negative', () => {
    const now = new Date('2026-10-03T10:00:00Z');
    expect(minutesSince(new Date('2026-10-03T09:00:30Z'), now, 10)).toBe(70);
    expect(minutesSince(new Date('2026-10-03T11:00:00Z'), now, 2)).toBe(2);
  });

  it('produces queries the deterministic Jira double understands', () => {
    expect(parseFakeJql(importJql('20001', 30))).toMatchObject({
      projectIds: ['20001'],
      createdWithinMinutes: 30,
      order: 'created_asc',
    });
    expect(parseFakeJql(reconcileJql('20001', 5))).toMatchObject({ updatedWithinMinutes: 5, order: 'updated_asc' });
    expect(parseFakeJql(linkSearchJql(['20001', '20002'], 'OPS-3'))).toMatchObject({
      projectIds: ['20001', '20002'],
      issueKey: 'OPS-3',
    });
    expect(parseFakeJql(linkSearchJql(['20001'], 'login safari'))).toMatchObject({
      text: 'login safari',
      order: 'updated_desc',
    });
    expect(parseFakeJql('project = 1 OR assignee = currentUser()')).toBeNull();
  });
});

describe('Issue mapping', () => {
  it('maps status categories and timestamps with numeric offsets', () => {
    expect(toStatusCategory('new')).toBe('TODO');
    expect(toStatusCategory('indeterminate')).toBe('IN_PROGRESS');
    expect(toStatusCategory('done')).toBe('DONE');
    expect(toStatusCategory(undefined)).toBe('TODO');
    expect(parseJiraTimestamp('2026-10-02T12:30:00.000+0200')?.toISOString()).toBe('2026-10-02T10:30:00.000Z');
    expect(parseJiraTimestamp('not a date')).toBeNull();
  });

  it('builds a snapshot with clipped fields and a site deep link', () => {
    const snapshot = toSnapshot(issueWire({ summary: 'x'.repeat(2000) }), 'https://acme.atlassian.net/');
    expect(snapshot).toMatchObject({
      jiraIssueId: '10001',
      issueKey: 'OPS-1',
      jiraProjectId: '20001',
      statusCategory: 'IN_PROGRESS',
      priorityName: 'High',
      assigneeDisplayName: 'Dev One',
      url: 'https://acme.atlassian.net/browse/OPS-1',
    });
    expect(snapshot?.summary).toHaveLength(1000);
    expect(snapshot?.dueDate?.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(toSnapshot(issueWire({ updated: 'garbage' }), 'https://acme.atlassian.net')).toBeNull();
    expect(issueBrowseUrl('https://a.test', 'A B-1')).toBe('https://a.test/browse/A%20B-1');
  });

  it('decides blocked statuses from the mapping list, else by name', () => {
    expect(isBlockedStatus('Blocked', [])).toBe(true);
    expect(isBlockedStatus('Waiting for vendor', [])).toBe(false);
    expect(isBlockedStatus('waiting for vendor', ['Waiting for Vendor'])).toBe(true);
    expect(isBlockedStatus('Blocked', ['On hold'])).toBe(false);
  });

  it('changes the content hash only when a cached field changes', () => {
    const a = toSnapshot(issueWire(), 'https://acme.atlassian.net');
    const b = toSnapshot(
      issueWire({ status: { name: 'Done', statusCategory: { key: 'done' } } }),
      'https://acme.atlassian.net',
    );
    if (a === null || b === null) {
      throw new Error('fixture must map');
    }
    expect(snapshotHash(a, 'm1', false)).toBe(snapshotHash({ ...a }, 'm1', false));
    expect(snapshotHash(a, 'm1', false)).not.toBe(snapshotHash(b, 'm1', false));
    expect(snapshotHash(a, 'm1', false)).not.toBe(snapshotHash(a, 'm2', false));
    expect(snapshotHash(a, 'm1', false)).not.toBe(snapshotHash(a, 'm1', true));
  });

  it('accepts both documented createmeta shapes and epoch or ISO webhook expiry', () => {
    expect(createMetaIssueTypesSchema.parse({ issueTypes: [{ id: '1', name: 'Bug' }] })).toEqual([
      { id: '1', name: 'Bug' },
    ]);
    expect(createMetaIssueTypesSchema.parse({ values: [{ id: 2, name: 'Task' }] })).toEqual([
      { id: '2', name: 'Task' },
    ]);
    expect(webhookRefreshSchema.parse({ expirationDate: 1_790_000_000_000 }).expirationDate.getTime()).toBe(
      1_790_000_000_000,
    );
    expect(webhookRefreshSchema.safeParse({ expirationDate: 'never' }).success).toBe(false);
  });
});

describe('Webhook JWT verification', () => {
  const secret = 'client-secret-for-tests-only';
  const now = 1_790_000_000;

  it('accepts HS256 tokens signed with the client secret', () => {
    const token = signWebhookJwt({ iss: 'app', exp: now + 60 }, secret);
    expect(verifyWebhookJwt(`Bearer ${token}`, secret, now)).toMatchObject({ ok: true, claims: { iss: 'app' } });
  });

  it('rejects missing, malformed, forged, unsigned and expired tokens', () => {
    const token = signWebhookJwt({ exp: now + 60 }, secret);
    expect(verifyWebhookJwt(undefined, secret, now)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyWebhookJwt(`Basic ${token}`, secret, now)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyWebhookJwt('Bearer a.b', secret, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyWebhookJwt(`Bearer ${'a'.repeat(9000)}`, secret, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyWebhookJwt(`Bearer ${signWebhookJwt({ exp: now + 60 }, 'another-secret')}`, secret, now)).toEqual({
      ok: false,
      reason: 'signature',
    });
    const [header = '', , signature = ''] = token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify({ exp: now + 9999 })).toString('base64url')}.${signature}`;
    expect(verifyWebhookJwt(`Bearer ${tampered}`, secret, now)).toEqual({ ok: false, reason: 'signature' });
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    expect(verifyWebhookJwt(`Bearer ${none}`, secret, now)).toEqual({ ok: false, reason: 'algorithm' });
    expect(verifyWebhookJwt(`Bearer ${signWebhookJwt({ exp: now - 120 }, secret)}`, secret, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyWebhookJwt(`Bearer ${signWebhookJwt({ nbf: now + 600 }, secret)}`, secret, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyWebhookJwt(`Bearer ${signWebhookJwt({ exp: now - 30 }, secret)}`, secret, now).ok).toBe(true);
  });
});

describe('Connection-wide coordination', () => {
  it('lets one holder run at a time and only the holder release the lock', async () => {
    const store = new InMemoryKeyValueStore();
    const coordination = new JiraCoordination(store);
    const first = await coordination.tryLock('k', 10_000);
    expect(first).not.toBeNull();
    expect(await coordination.tryLock('k', 10_000)).toBeNull();
    await store.deleteIfEquals('k', 'someone-else');
    expect(await coordination.tryLock('k', 10_000)).toBeNull();
    await first?.release();
    expect(await coordination.tryLock('k', 10_000)).not.toBeNull();
  });

  it('times out waiting for a busy lock and releases after errors', async () => {
    const coordination = new JiraCoordination(new InMemoryKeyValueStore());
    await coordination.withLock('k', { ttlMs: 5_000, waitMs: 0 }, async () => {
      await expect(
        coordination.withLock('k', { ttlMs: 5_000, waitMs: 0 }, () => Promise.resolve(1)),
      ).rejects.toBeInstanceOf(LockBusyError);
    });
    await expect(
      coordination.withLock('k', { ttlMs: 5_000, waitMs: 0 }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(coordination.withLock('k', { ttlMs: 5_000, waitMs: 0 }, () => Promise.resolve(2))).resolves.toBe(2);
  });

  it('expires locks after their TTL so a crashed holder cannot block forever', async () => {
    let clock = 1_000;
    const coordination = new JiraCoordination(new InMemoryKeyValueStore(() => clock), () => clock);
    expect(await coordination.tryLock('k', 100)).not.toBeNull();
    clock += 101;
    expect(await coordination.tryLock('k', 100)).not.toBeNull();
  });

  it('keeps the longest pause and forgets it once it passed', async () => {
    let clock = 10_000;
    const coordination = new JiraCoordination(new InMemoryKeyValueStore(() => clock), () => clock);
    await coordination.pause('c', clock + 5_000);
    await coordination.pause('c', clock + 1_000);
    expect(await coordination.pausedUntil('c')).toBe(15_000);
    expect(await coordination.pausedUntil('other')).toBeNull();
    clock = 15_001;
    expect(await coordination.pausedUntil('c')).toBeNull();
  });
});

describe('Token envelopes', () => {
  const key = (id: string) => ({ id, key: randomBytes(32) });

  it('binds each token to its organization, connection and field', () => {
    const cipher = new EnvelopeCipher(key('k1'));
    const tokens = encryptTokens(
      cipher,
      'org-a',
      'conn-1',
      { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600 },
      new Date(0),
    );
    expect(tokens.tokenExpiresAt.toISOString()).toBe('1970-01-01T01:00:00.000Z');
    expect(tokens.encryptionKeyId).toBe('k1');
    expect(tokens.accessTokenEnc).not.toContain('at.');
    expect(cipher.decrypt(tokens.accessTokenEnc, tokenAad('org-a', 'conn-1', 'access_token'))).toBe('at');
    expect(() => cipher.decrypt(tokens.accessTokenEnc, tokenAad('org-b', 'conn-1', 'access_token'))).toThrow();
    expect(() => cipher.decrypt(tokens.accessTokenEnc, tokenAad('org-a', 'conn-2', 'access_token'))).toThrow();
    expect(() => cipher.decrypt(tokens.accessTokenEnc, tokenAad('org-a', 'conn-1', 'refresh_token'))).toThrow();
  });

  it('decrypts envelopes of a retired key and flags them for re-encryption', () => {
    const old = key('k1');
    const before = new EnvelopeCipher(old);
    const envelope = before.encrypt('refresh', tokenAad('o', 'c', 'refresh_token'));
    const after = new EnvelopeCipher(key('k2'), [old]);
    expect(after.needsRotation(envelope)).toBe(true);
    expect(after.decrypt(envelope, tokenAad('o', 'c', 'refresh_token'))).toBe('refresh');
    expect(after.needsRotation(after.encrypt('x', 'aad'))).toBe(false);
    expect(() => new EnvelopeCipher(key('k3')).decrypt(envelope, tokenAad('o', 'c', 'refresh_token'))).toThrow();
  });
});

describe('OAuth client', () => {
  const settings = {
    clientId: 'client-1',
    clientSecret: 'secret-secret-secret',
    authBaseUrl: 'https://auth.atlassian.com',
    apiBaseUrl: 'https://api.atlassian.com',
    publicUrl: 'https://ops.example.com',
  };

  it('requests exactly the documented scopes with consent and the derived redirect URI', () => {
    const url = new URL(new JiraOAuthClient(settings, http(scripted([]).fetch)).authorizeUrl('state-1'));
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('scope')).toBe('read:jira-work write:jira-work manage:jira-webhook offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ops.example.com/api/v1/integrations/jira/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(jiraRedirectUri(settings)).toBe('https://ops.example.com/api/v1/integrations/jira/callback');
    expect(jiraWebhookUrl(settings, 'c-1')).toBe('https://ops.example.com/api/v1/webhooks/jira/c-1');
  });

  it('treats a rejected refresh as a lost grant and a rejected code as an invalid request', async () => {
    const refresh = new JiraOAuthClient(settings, http(scripted([json(403, { error: 'invalid_grant' })]).fetch));
    await expect(refresh.refresh('rt')).rejects.toMatchObject({ kind: 'reauth_required' });
    const exchange = new JiraOAuthClient(settings, http(scripted([json(400, { error: 'invalid_grant' })]).fetch));
    await expect(exchange.exchangeCode('code')).rejects.toMatchObject({ kind: 'invalid_request' });
    const outage = new JiraOAuthClient(settings, http(scripted([json(500, {})]).fetch, [], { maxRetries: 0 }));
    await expect(outage.refresh('rt')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('only relaxes https rules for the test double', () => {
    expect(usesTestDouble(settings)).toBe(false);
    expect(canRegisterWebhooks(settings)).toBe(true);
    expect(canRegisterWebhooks({ ...settings, publicUrl: 'http://localhost:3000' })).toBe(false);
    expect(canRegisterWebhooks({ apiBaseUrl: 'http://127.0.0.1:9999', publicUrl: 'http://localhost:3000' })).toBe(true);
  });
});

describe('Issue description sent to Jira', () => {
  it('keeps paragraphs and line breaks and appends the ticket backlink', () => {
    const adf = issueDescriptionAdf('First line\nsecond line\n\n\nNext paragraph', {
      ticketKey: 'SUP-7',
      url: 'https://ops.test/support/tickets/t1',
    });
    expect(adf).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Next paragraph' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Support ticket SUP-7: ' },
            {
              type: 'text',
              text: 'https://ops.test/support/tickets/t1',
              marks: [{ type: 'link', attrs: { href: 'https://ops.test/support/tickets/t1' } }],
            },
          ],
        },
      ],
    });
    expect(issueDescriptionAdf('   ', { ticketKey: 'SUP-1', url: 'u' }).content).toHaveLength(1);
  });
});

describe('Deterministic Jira double', () => {
  it('pages search results with tokens that expire, like Jira', async () => {
    const fake = new FakeJira({ clientId: 'c', clientSecret: 'secret-secret-secret' });
    const token = await fakeToken(fake);
    const search = (body: unknown) =>
      fake.fetch('https://api.atlassian.com/ex/jira/fake-cloud-1/rest/api/3/search/jql', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = await search({ jql: importJql('20001', null), maxResults: 2 });
    const page: unknown = await first.json();
    const parsed = z.object({ issues: z.array(z.unknown()), nextPageToken: z.string() }).parse(page);
    expect(parsed.issues).toHaveLength(2);
    fake.expirePageTokens();
    expect(
      (await search({ jql: importJql('20001', null), maxResults: 2, nextPageToken: parsed.nextPageToken })).status,
    ).toBe(400);
    expect((await search({ jql: 'project = 20001 OR 1=1', maxResults: 2 })).status).toBe(400);
  });
});

async function fakeToken(fake: FakeJira): Promise<string> {
  const authorize = await fake.fetch(
    `https://auth.atlassian.com/authorize?client_id=c&redirect_uri=${encodeURIComponent('https://ops.test/cb')}&state=s&response_type=code`,
    { redirect: 'manual' },
  );
  const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const response = await fake.fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: 'c',
      client_secret: 'secret-secret-secret',
      code,
      redirect_uri: 'https://ops.test/cb',
    }),
  });
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}
