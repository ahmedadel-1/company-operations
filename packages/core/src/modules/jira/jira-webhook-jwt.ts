import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookJwtResult =
  | { readonly ok: true; readonly claims: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'algorithm' | 'signature' | 'expired' };

const LEEWAY_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Verifies the `Authorization: Bearer <JWT>` Jira sends with webhooks for OAuth 2.0 apps
 * (developer.atlassian.com/cloud/jira/platform/webhooks, "Authentication", checked 2026-10-03):
 * HS256, signed with the app's client secret. Only HS256 is accepted (no `none`, no algorithm
 * confusion), the signature is compared in constant time, and `exp`/`nbf` are enforced when present.
 * Atlassian does not publish further claims, so none are required; the endpoint additionally binds
 * deliveries to a connection and its registered webhook ids, and processing re-reads Jira.
 */
export function verifyWebhookJwt(
  authorization: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookJwtResult {
  if (!authorization?.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing' };
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart);
  if (header === null || claims === null) {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'HS256') {
    return { ok: false, reason: 'algorithm' };
  }
  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'signature' };
  }
  if (typeof claims.exp === 'number' && claims.exp + LEEWAY_SECONDS < nowSeconds) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > nowSeconds) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}

/** Signs a webhook JWT the way Jira does (test double and tests only). */
export function signWebhookJwt(claims: Readonly<Record<string, unknown>>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
