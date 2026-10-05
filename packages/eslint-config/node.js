import { defineConfig } from 'eslint/config';
import globals from 'globals';

import { baseConfig } from './base.js';

/**
 * Node.js packages and NestJS runtime adapters.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function nodeConfig(options) {
  return defineConfig(baseConfig(options), {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // NestJS modules are decorated classes without members.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  });
}
