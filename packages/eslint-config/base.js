import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export const ignoredPaths = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/src/generated/**',
  '**/next-env.d.ts',
];

const unsafeRawSql = [
  {
    property: '$queryRawUnsafe',
    message: 'Unsafe raw SQL is banned (ARCHITECTURE §10). Use tagged $queryRaw in packages/core/src/platform/db/sql/.',
  },
  {
    property: '$executeRawUnsafe',
    message:
      'Unsafe raw SQL is banned (ARCHITECTURE §10). Use tagged $executeRaw in packages/core/src/platform/db/sql/.',
  },
  {
    object: 'Prisma',
    property: 'raw',
    message: 'Prisma.raw() splices strings into SQL (ARCHITECTURE §10). Use Prisma.sql template values.',
  },
];

const rawSqlOutsideSqlModule = [
  {
    property: '$queryRaw',
    message: 'Raw SQL is only allowed in packages/core/src/platform/db/sql/ (ARCHITECTURE §10).',
  },
  {
    property: '$executeRaw',
    message: 'Raw SQL is only allowed in packages/core/src/platform/db/sql/ (ARCHITECTURE §10).',
  },
];

/**
 * Shared type-aware base. Inline `eslint-disable` comments are switched off entirely: any justified
 * exception must be configured here or in a package config, where it is reviewed.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function baseConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores(ignoredPaths),
    {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: 'error',
      },
    },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
    },
    {
      plugins: { 'import-x': importX },
      settings: {
        'import-x/resolver-next': [createNodeResolver({ extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] })],
      },
      rules: {
        'import-x/first': 'error',
        'import-x/no-duplicates': 'error',
        'import-x/no-self-import': 'error',
        'import-x/newline-after-import': 'error',
      },
    },
    {
      rules: {
        'no-empty': ['error', { allowEmptyCatch: false }],
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/ban-ts-comment': [
          'error',
          {
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-expect-error': 'allow-with-description',
            minimumDescriptionLength: 10,
          },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        // Rest destructuring is how an optional property is dropped without type assertions.
        '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
        'no-restricted-properties': ['error', ...unsafeRawSql, ...rawSqlOutsideSqlModule],
      },
    },
    {
      files: ['**/src/platform/db/sql/**/*.ts'],
      rules: {
        'no-restricted-properties': ['error', ...unsafeRawSql],
      },
    },
    {
      // Security tests call the unsafe raw APIs to prove the runtime tenant guard rejects them.
      files: ['**/test/**/*.security.int.test.ts'],
      rules: {
        'no-restricted-properties': ['error', ...rawSqlOutsideSqlModule],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    prettier,
  );
}
