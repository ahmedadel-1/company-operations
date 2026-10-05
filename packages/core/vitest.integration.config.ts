import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
