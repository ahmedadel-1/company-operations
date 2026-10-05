import { join } from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// `/api/*` is forwarded to the API by src/proxy.ts at request time (not a build-time rewrite).
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server for the production image and the E2E stack (DEPLOYMENT §5). Tracing starts at
  // the workspace root so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
  agentRules: false,
  // Source-only workspace packages (shadcn/ui components and message catalogs).
  transpilePackages: ['@company-ops/ui', '@company-ops/i18n', '@company-ops/api-client'],
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },
};

export default withNextIntl(nextConfig);
