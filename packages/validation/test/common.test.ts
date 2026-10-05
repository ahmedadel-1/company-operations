import { describe, expect, it } from 'vitest';

import { errorEnvelopeSchema, requestIdSchema } from '../src/index.js';

describe('requestIdSchema', () => {
  it('accepts UUIDs', () => {
    expect(requestIdSchema.safeParse('0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10').success).toBe(true);
  });

  it.each(['', 'abc', '../../etc/passwd', 'a'.repeat(36)])('rejects %j', (value) => {
    expect(requestIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('errorEnvelopeSchema', () => {
  it('accepts the documented envelope shape', () => {
    const result = errorEnvelopeSchema.safeParse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed.',
        fieldErrors: [{ path: 'reason', code: 'too_small' }],
        requestId: '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope without a code', () => {
    const result = errorEnvelopeSchema.safeParse({ error: { message: 'x', requestId: 'r' } });
    expect(result.success).toBe(false);
  });
});
