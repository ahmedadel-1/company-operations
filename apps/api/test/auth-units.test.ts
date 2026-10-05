import { describe, expect, it } from 'vitest';

import { NotFoundError, TenantIsolationError } from '@company-ops/core';

import { readCookie, SESSION_COOKIE } from '../src/auth/session/cookies.js';
import { parseSessionRecord } from '../src/auth/session/session.types.js';
import { toErrorEnvelope } from '../src/http/errors/error-envelope.js';
import { stripQuery } from '../src/infrastructure/logging.js';

const ID = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('readCookie', () => {
  it('reads the session cookie and rejects malformed or duplicated values', () => {
    expect(readCookie({ headers: { cookie: `a=1; ${SESSION_COOKIE}=${ID}` } }, SESSION_COOKIE)).toBe(ID);
    expect(readCookie({ headers: {} }, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie({ headers: { cookie: `${SESSION_COOKIE}=short` } }, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie({ headers: { cookie: `${SESSION_COOKIE}=${ID}!` } }, SESSION_COOKIE)).toBeUndefined();
    expect(
      readCookie({ headers: { cookie: `${SESSION_COOKIE}=${ID}; ${SESSION_COOKIE}=${ID}x` } }, SESSION_COOKIE),
    ).toBeUndefined();
  });
});

describe('parseSessionRecord', () => {
  const valid = {
    v: 1,
    userId: 'u',
    organizationId: 'o',
    memberId: 'm',
    authzVersion: 1,
    roleKeys: ['EMPLOYEE'],
    permissions: { 'employee.view': ['ORG'] },
    acr: 'pwd',
    mfaAuthenticatedAt: null,
    idpSessionId: null,
    idTokenEnc: null,
    csrfToken: 't',
    createdAt: 1,
    lastSeenAt: 1,
    absoluteExpiresAt: 2,
  };

  it('accepts a well-formed record and rejects anything else', () => {
    expect(parseSessionRecord(JSON.stringify(valid))).toEqual(valid);
    expect(parseSessionRecord('not json')).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ ...valid, v: 2 }))).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ ...valid, organizationId: 7 }))).toBeNull();
    expect(parseSessionRecord(JSON.stringify({ ...valid, permissions: { x: 'ORG' } }))).toBeNull();
  });
});

describe('log redaction helpers', () => {
  it('drops query strings (OIDC code and state) from logged URLs', () => {
    expect(stripQuery('/api/v1/auth/callback?code=secret&state=abc')).toBe('/api/v1/auth/callback');
    expect(stripQuery('/api/v1/me')).toBe('/api/v1/me');
    expect(stripQuery(undefined)).toBe('');
  });
});

describe('error envelope for domain errors', () => {
  it('maps NotFoundError to 404 and hides tenant-guard violations as 500', () => {
    expect(toErrorEnvelope(new NotFoundError('Member'), 'r1')).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Member was not found.', requestId: 'r1' } },
    });
    const internal = toErrorEnvelope(new TenantIsolationError('Tenant guard rejected Role.findMany: org xyz'), 'r2');
    expect(internal.status).toBe(500);
    expect(internal.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(internal.body)).not.toContain('Tenant guard');
  });
});
