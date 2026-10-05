import { nodeConfig } from '@company-ops/eslint-config/node';

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Playwright fixtures must destructure their dependencies; `{}` declares "none".
    files: ['support/test.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    // Specs must use the fixture-extended `test` so the seeded baseline is restored per file.
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              importNames: ['test', 'expect'],
              message:
                "Import { test, expect } from '../support/test.js' (restores the seeded baseline per spec file).",
            },
          ],
        },
      ],
    },
  },
];
