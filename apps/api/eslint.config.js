import { nodeConfig } from '@company-ops/eslint-config/node';

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // openid-client marks allowInsecureRequests deprecated on purpose (dev-only http issuer).
    // This single file wraps it; everywhere else the rule stays on.
    files: ['src/auth/oidc/insecure-dev-transport.ts'],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
];
