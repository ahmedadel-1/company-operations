import { describe, expect, it } from 'vitest';

import { TimeoutError, withTimeout } from '../src/index.js';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'fast')).resolves.toBe('ok');
  });

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'failing')).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the promise is too slow', async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withTimeout(never, 20, 'slow')).rejects.toBeInstanceOf(TimeoutError);
  });
});
