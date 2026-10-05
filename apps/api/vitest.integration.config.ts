import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Real PostgreSQL, Redis and Keycloak containers (Testcontainers); nothing under test is mocked.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Suites start their own containers; run them one after another to bound resource use.
    fileParallelism: false,
  },
});
