import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@company-ops/validation';

import { toErrorEnvelope } from '../src/http/errors/error-envelope.js';

const requestId = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10';

describe('toErrorEnvelope', () => {
  it('hides internal error details', () => {
    const result = toErrorEnvelope(new Error('connection string postgres://user:pw@db'), requestId);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId },
    });
    expect(errorEnvelopeSchema.safeParse(result.body).success).toBe(true);
  });

  it('maps Nest HTTP exceptions to default codes', () => {
    const result = toErrorEnvelope(new NotFoundException('Cannot GET /api/v1/nope'), requestId);
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NOT_FOUND');
    expect(result.body.error.message).toBe('Cannot GET /api/v1/nope');
  });

  it('keeps explicit codes, details and field errors for client errors', () => {
    const result = toErrorEnvelope(
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Validation failed.',
        details: { limit: 100 },
        fieldErrors: [{ path: 'limit', code: 'too_big' }],
      }),
      requestId,
    );
    expect(result.body.error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Validation failed.',
      details: { limit: 100 },
      fieldErrors: [{ path: 'limit', code: 'too_big' }],
      requestId,
    });
  });

  it('ignores unknown codes', () => {
    const result = toErrorEnvelope(new BadRequestException({ code: 'MADE_UP' }), requestId);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('exposes dependency details but not free-form messages for 503', () => {
    const result = toErrorEnvelope(
      new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'internal text',
        details: { redis: { status: 'down' } },
      }),
      requestId,
    );
    expect(result.status).toBe(503);
    expect(result.body.error.message).toBe('A required service is temporarily unavailable.');
    expect(result.body.error.details).toEqual({ redis: { status: 'down' } });
  });

  it('maps unreachable PostgreSQL or Redis to 503 DEPENDENCY_UNAVAILABLE without leaking driver text', () => {
    const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });
    const coded = (code: string, message = 'x'): Error => Object.assign(new Error(message), { code });
    const failures = [
      named('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 1).'),
      new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      new Error('Connection is closed.'),
      named('PrismaClientInitializationError', "Can't reach database server at postgres:5432"),
      coded('P1001'),
      coded('P2024'),
      coded('57P01', 'terminating connection due to administrator command'),
      new Error('query failed', { cause: coded('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:5432') }),
      new Error('outer', { cause: new Error('middle', { cause: coded('ENOTFOUND', 'getaddrinfo ENOTFOUND redis') }) }),
    ];
    for (const failure of failures) {
      const result = toErrorEnvelope(failure, requestId);
      expect(result.status, failure.message).toBe(503);
      expect(result.body.error).toEqual({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable.',
        requestId,
      });
    }
  });

  it('keeps ordinary errors, unique violations and HTTP exceptions out of the dependency mapping', () => {
    const unique = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    expect(toErrorEnvelope(unique, requestId).status).toBe(500);
    expect(toErrorEnvelope(new TypeError('x is undefined'), requestId).status).toBe(500);
    expect(toErrorEnvelope('ECONNREFUSED', requestId).status).toBe(500);
    const http = Object.assign(new NotFoundException('gone'), {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    });
    expect(toErrorEnvelope(http, requestId).status).toBe(404);
  });
});
