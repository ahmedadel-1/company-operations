import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import type { Options } from 'pino-http';
import { describe, expect, it } from 'vitest';

import type { ApiEnv } from '../src/config/api-env.js';
import { createLoggerParams, requestLogLevel } from '../src/infrastructure/logging.js';

/**
 * Runs the real request-logging configuration (SECURITY §7) against an HTTP request that carries
 * every kind of secret a browser or identity provider sends, and inspects the emitted log lines.
 */
describe('request logging never writes secrets', () => {
  it('omits cookies, authorization, CSRF tokens, OIDC codes and Set-Cookie values', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const params = createLoggerParams({ LOG_LEVEL: 'info' } as ApiEnv);
    if (params.pinoHttp === undefined || Array.isArray(params.pinoHttp)) {
      throw new Error('expected pino-http options');
    }
    // Same construction as nestjs-pino: pino-http builds the logger from these options.
    const logger = pinoHttp(params.pinoHttp as Options, sink);

    const server = createServer((req, res) => {
      logger(req, res);
      req.log.info({ token: 'nested-token-value', password: 'nested-password' }, 'handling');
      res.setHeader('Set-Cookie', '__Host-ops_sid=set-cookie-session-value; Path=/; HttpOnly; Secure');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${String(port)}/api/v1/auth/callback?code=oidc-code-value&state=oidc-state-value`, {
        headers: {
          cookie: '__Host-ops_sid=cookie-session-value',
          authorization: 'Bearer authorization-value',
          'x-csrf-token': 'csrf-token-value',
        },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    const output = lines.join('');
    expect(output).toContain('/api/v1/auth/callback');
    expect(output).toContain('request completed');
    const records = output
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => ({ line, record: JSON.parse(line) as Record<string, unknown> }));
    expect(records.map(({ record }) => record.msg)).toEqual(['handling', 'request completed']);
    for (const { line, record } of records) {
      expect(typeof record.requestId).toBe('string');
      expect(line.split('"requestId":').length - 1, line).toBe(1);
    }
    for (const secret of [
      'cookie-session-value',
      'set-cookie-session-value',
      'authorization-value',
      'csrf-token-value',
      'oidc-code-value',
      'oidc-state-value',
      'nested-token-value',
      'nested-password',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('scrubs secrets inside messages and errors: invitations, keys, tokens, credentials, coordinates', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const params = createLoggerParams({ LOG_LEVEL: 'info' } as ApiEnv);
    if (params.pinoHttp === undefined || Array.isArray(params.pinoHttp)) {
      throw new Error('expected pino-http options');
    }
    const { logger } = pinoHttp(params.pinoHttp as Options, sink);
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl'; // gitleaks:allow
    logger.info(`Send this link: https://ops.example.com/api/v1/auth/login?invitation=invite-secret-value`);
    logger.warn(`GitHub said 401 for token ghs_installationTokenValue1234567890 and ${jwt}`);
    logger.error(
      new Error(
        'connect failed postgresql://ops_app:db-password-value@db:5432/company_ops with Bearer bearer-secret-value',
      ),
    );
    logger.error(
      { err: new Error('-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body\n-----END RSA PRIVATE KEY-----') },
      'key load failed',
    );
    logger.info({ payload: { connection: { privateKey: 'nested-private-key', webhookSecret: 'hook-secret' } } });
    logger.info('check-in at latitude=30.044420 longitude=31.235712');
    logger.info({ event: { accuracyMeters: 12, location: { latitude: 30.04442 } } }, 'evidence');

    const output = lines.join('');
    for (const secret of [
      'invite-secret-value',
      'ghs_installationTokenValue1234567890',
      jwt,
      'db-password-value',
      'bearer-secret-value',
      'private-key-body',
      'nested-private-key',
      'hook-secret',
      '30.044420',
      '31.235712',
      '30.04442',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('https://ops.example.com/api/v1/auth/login?invitation=[REDACTED]');
    expect(output).toContain('postgresql://ops_app:[REDACTED]@db:5432/company_ops');
    expect(output).toContain('key load failed');
  });
});

describe('request log levels', () => {
  it('logs successful health probes at debug and keeps failures and other requests visible', () => {
    expect(requestLogLevel('/api/v1/health/live', 200, undefined)).toBe('debug');
    expect(requestLogLevel('/api/v1/health/ready?probe=1', 200, undefined)).toBe('debug');
    expect(requestLogLevel('/api/v1/health/ready', 503, undefined)).toBe('error');
    expect(requestLogLevel('/api/v1/health/live', 200, new Error('boom'))).toBe('error');
    expect(requestLogLevel('/api/v1/me', 200, undefined)).toBe('info');
    expect(requestLogLevel('/api/v1/me', 401, undefined)).toBe('info');
    expect(requestLogLevel('/api/v1/health/live/extra', 200, undefined)).toBe('info');
  });
});
