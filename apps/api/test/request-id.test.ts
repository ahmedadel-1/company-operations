import { describe, expect, it } from 'vitest';

import { requestIdSchema } from '@company-ops/validation';

import { resolveRequestId } from '../src/http/request-id.js';

describe('resolveRequestId', () => {
  it('echoes a valid client UUID', () => {
    const id = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10';
    expect(resolveRequestId(id)).toBe(id);
  });

  it('uses the first value of a repeated header', () => {
    const id = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10';
    expect(resolveRequestId([id, 'other'])).toBe(id);
  });

  it.each([undefined, '', 'not-a-uuid', '<script>'])('generates a UUID for %j', (header) => {
    const id = resolveRequestId(header);
    expect(id).not.toBe(header);
    expect(requestIdSchema.safeParse(id).success).toBe(true);
  });
});
