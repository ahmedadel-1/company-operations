import { describe, expect, it } from 'vitest';

import { loginQuerySchema, returnToPathSchema, switchOrganizationRequestSchema } from '../src/index.js';

describe('returnToPathSchema', () => {
  it.each(['/', '/dashboard', '/projects/1?tab=team', '/a/b#c'])('accepts same-origin path %s', (value) => {
    expect(returnToPathSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'dashboard',
    '/path with space',
    '/\u0000',
    'javascript:alert(1)',
    `/${'a'.repeat(600)}`,
  ])('rejects open-redirect candidate %j', (value) => {
    expect(returnToPathSchema.safeParse(value).success).toBe(false);
  });
});

describe('strict request schemas', () => {
  it('rejects unknown query parameters on login', () => {
    expect(loginQuerySchema.safeParse({ returnTo: '/x', organizationId: 'x' }).success).toBe(false);
  });

  it('rejects extra properties on organization switch', () => {
    const organizationId = '0191f6d0-7c1e-7b8a-9a59-3f2d4c1b6e10';
    expect(switchOrganizationRequestSchema.safeParse({ organizationId }).success).toBe(true);
    expect(switchOrganizationRequestSchema.safeParse({ organizationId, role: 'ORG_ADMIN' }).success).toBe(false);
    expect(switchOrganizationRequestSchema.safeParse({ organizationId: 'not-a-uuid' }).success).toBe(false);
  });
});
