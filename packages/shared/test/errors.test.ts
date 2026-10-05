import { describe, expect, it } from 'vitest';

import { defaultErrorCodeForStatus, ERROR_CODES } from '../src/index.js';

describe('defaultErrorCodeForStatus', () => {
  it.each([
    [400, ERROR_CODES.VALIDATION_FAILED],
    [401, ERROR_CODES.UNAUTHENTICATED],
    [403, ERROR_CODES.FORBIDDEN],
    [404, ERROR_CODES.NOT_FOUND],
    [409, ERROR_CODES.CONFLICT],
    [429, ERROR_CODES.RATE_LIMITED],
    [503, ERROR_CODES.DEPENDENCY_UNAVAILABLE],
    [500, ERROR_CODES.INTERNAL_ERROR],
    [418, ERROR_CODES.INTERNAL_ERROR],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(defaultErrorCodeForStatus(status)).toBe(code);
  });
});
