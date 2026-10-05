import { describe, expect, it } from 'vitest';

import { LOG_REDACT_PATHS, redactSecrets, serializeErrorForLog } from '../src/index.js';

describe('LOG_REDACT_PATHS', () => {
  it('redacts credentials and attendance coordinates at the top level and two levels down', () => {
    for (const key of ['password', 'token', 'privateKey', 'webhookSecret', 'latitude', 'longitude', 'location']) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.${key}`);
    }
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(LOG_REDACT_PATHS).not.toContain('code');
    expect(LOG_REDACT_PATHS).not.toContain('state');
  });
});

describe('redactSecrets', () => {
  it.each([
    ['https://h/api/v1/auth/login?invitation=abc_DEF-123', 'https://h/api/v1/auth/login?invitation=[REDACTED]'],
    ['/callback?code=c0de&state=st4te&x=1', '/callback?code=[REDACTED]&state=[REDACTED]&x=1'],
    [
      'GET https://s3/b/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA%2F',
      'GET https://s3/b/k?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]',
    ],
    ['redis://default:r3dis-pass@redis:6379', 'redis://default:[REDACTED]@redis:6379'],
    ['smtps://mailer:smtp-pass@smtp.example.com:465', 'smtps://mailer:[REDACTED]@smtp.example.com:465'],
    ['Authorization: Bearer abcdefghijkl', 'Authorization: Bearer [REDACTED]'],
    ['token ghs_abcdefghijklmnopqrstuvwxyz', 'token [REDACTED]'],
    ['github_pat_11ABCDEFGHIJKLMNOPQRSTUV_x', '[REDACTED]'],
    ['cookie __Host-ops_sid=s3ss10n; other=1', 'cookie __Host-ops_sid=[REDACTED]; other=1'],
    ['{"latitude":30.044420,"lng":-31.2357}', '{"latitude":[REDACTED],"lng":[REDACTED]}'],
  ])('scrubs %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('removes JWTs and whole private keys, even truncated ones', () => {
    expect(redactSecrets('jwt eyJhbGciOi.eyJzdWIiOiJ4In0.c2ln end')).toBe('jwt [REDACTED] end');
    expect(redactSecrets('a -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- b')).toBe('a [REDACTED] b'); // gitleaks:allow
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEtruncated')).toBe('[REDACTED]');
  });

  it('leaves ordinary operational text alone', () => {
    const text = 'Ticket SUP-12 moved to IN_PROGRESS; code=ATTENDANCE_NOT_CHECKED_IN; 3 retries in 1.5s';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('serializeErrorForLog', () => {
  it('keeps type, code and scrubbed message and stack, nothing else', () => {
    const error = Object.assign(new Error('failed for https://x/?invitation=secret-invite'), {
      code: 'E_FAIL',
      config: { headers: { authorization: 'Bearer leaked-value' } },
    });
    const serialized = JSON.stringify(serializeErrorForLog(error));
    expect(serialized).toContain('E_FAIL');
    expect(serialized).toContain('invitation=[REDACTED]');
    expect(serialized).not.toContain('secret-invite');
    expect(serialized).not.toContain('leaked-value');
  });

  it('scrubs errors that arrive already serialized as plain objects', () => {
    const serialized = JSON.stringify(
      serializeErrorForLog({ type: 'Error', message: 'redis://u:pw-secret@h:6379', raw: { token: 'raw-token' } }),
    );
    expect(serialized).toContain('redis://u:[REDACTED]@h:6379');
    expect(serialized).not.toContain('pw-secret');
    expect(serialized).not.toContain('raw-token');
  });
});
