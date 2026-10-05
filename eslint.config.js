import { globalIgnores } from 'eslint/config';

import { nodeConfig } from '@company-ops/eslint-config/node';

// Root-level files only; every workspace package runs ESLint with its own config via Turborepo.
export default [
  globalIgnores(['apps/**', 'packages/**', 'docs/**', 'infra/**']),
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
];
