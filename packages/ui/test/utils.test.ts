import { describe, expect, it } from 'vitest';

import { cn } from '../src/lib/utils.js';

describe('cn', () => {
  it('drops falsy values', () => {
    expect(cn('p-2', false, undefined, 'text-sm')).toBe('p-2 text-sm');
  });

  it('lets later Tailwind utilities win', () => {
    expect(cn('ps-2 text-sm', 'ps-4')).toBe('text-sm ps-4');
  });
});
