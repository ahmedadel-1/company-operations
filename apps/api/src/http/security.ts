import type { IncomingMessage, ServerResponse } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import type { ApiEnv } from '../config/api-env.js';
import { githubRawBody } from './github-raw-body.js';

/** Browser origins allowed to send credentialed, state-changing requests (CORS + CSRF Origin check). */
export function allowedOrigins(env: Pick<ApiEnv, 'APP_PUBLIC_URL' | 'CORS_ORIGINS'>): ReadonlySet<string> {
  return new Set([new URL(env.APP_PUBLIC_URL).origin, ...env.CORS_ORIGINS]);
}

const strictHelmet = helmet({
  // JSON API: nothing may be rendered, framed or loaded from responses.
  contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-origin' },
});
/** Swagger UI needs scripts/styles from its own origin. Only mounted when SWAGGER_ENABLED. */
const docsHelmet = helmet();

/**
 * HTTP hardening (SECURITY §4): security headers, no `x-powered-by`, explicit proxy trust, CORS
 * allow-list (credentials only for listed origins), and bounded request bodies.
 */
export function applyHttpSecurity(app: INestApplication, env: ApiEnv, docsPath: string): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  express.set('trust proxy', env.TRUST_PROXY_HOPS);
  express.use((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const handler = (req.url ?? '').startsWith(`/${docsPath}`) ? docsHelmet : strictHelmet;
    handler(req, res, next);
  });
  // Must precede the JSON parser: the webhook signature covers the raw bytes.
  express.use(githubRawBody(env.GITHUB_WEBHOOK_MAX_BYTES));
  express.useBodyParser('json', { limit: '1mb' });
  // Only OIDC back-channel logout posts form data.
  express.useBodyParser('urlencoded', { limit: '16kb', extended: false });

  const corsOrigins = new Set(env.CORS_ORIGINS);
  express.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      callback(null, origin !== undefined && corsOrigins.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
}
