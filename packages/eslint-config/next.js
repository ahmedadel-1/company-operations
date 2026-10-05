import eslintReact from '@eslint-react/eslint-plugin';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import { baseConfig } from './base.js';

/**
 * Next.js app (ADR-0014): @next/eslint-plugin-next, react-hooks and @eslint-react on top of the
 * shared base. `eslint-config-next` is intentionally not used.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function nextConfig(options) {
  return defineConfig(
    baseConfig(options),
    {
      languageOptions: {
        globals: { ...globals.browser, ...globals.node },
      },
    },
    {
      files: ['**/*.{ts,tsx}'],
      extends: [eslintReact.configs['recommended-type-checked']],
    },
    reactHooks.configs.flat.recommended,
    {
      plugins: { '@next/next': nextPlugin },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
      },
    },
    {
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@company-ops/core', '@company-ops/core/*', '@company-ops/db', '@company-ops/db/*'],
                message: 'apps/web must not import packages/core or packages/db (ARCHITECTURE §4).',
              },
            ],
          },
        ],
      },
    },
  );
}
