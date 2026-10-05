import { createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Parses the App private key once (PEM, PKCS#1 or PKCS#8). Throws a message without key material
 * when the value is not a usable RSA private key.
 */
export function loadAppPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a readable PEM private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('GITHUB_APP_PRIVATE_KEY must be an RSA key (GitHub signs App JWTs with RS256).');
  }
  return key;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** App JWT lifetime; GitHub accepts at most 10 minutes. */
export const APP_JWT_TTL_SECONDS = 540;
/** `iat` is backdated to absorb clock drift (GitHub's recommendation). */
const CLOCK_SKEW_SECONDS = 60;

/**
 * RS256 App JWT (docs "Generating a JSON Web Token (JWT) for a GitHub App", checked 2026-10-03):
 * `iat` = now − 60 s, `exp` ≤ 10 minutes, `iss` = the app's client ID (recommended) or app ID.
 */
export function createAppJwt(issuer: string, key: KeyObject, nowSeconds: number): { token: string; expiresAt: number } {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const exp = nowSeconds + APP_JWT_TTL_SECONDS;
  const payload = base64url(JSON.stringify({ iat: nowSeconds - CLOCK_SKEW_SECONDS, exp, iss: issuer }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return { token: `${header}.${payload}.${base64url(signature)}`, expiresAt: exp * 1000 };
}

/** `sha256=<hex>` HMAC of the raw body (the value GitHub sends in `X-Hub-Signature-256`). */
export function webhookSignature(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * Verifies `X-Hub-Signature-256` over the exact raw bytes with a constant-time comparison (docs
 * "Validating webhook deliveries"). The legacy SHA-1 `X-Hub-Signature` header is never consulted.
 */
export function verifyWebhookSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  const match = header === undefined ? null : SIGNATURE.exec(header.trim().toLowerCase());
  const received = match?.[1];
  if (received === undefined) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(received, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
