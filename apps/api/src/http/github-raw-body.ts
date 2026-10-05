import type { IncomingMessage, ServerResponse } from 'node:http';

import { ERROR_CODES } from '@company-ops/shared';

import { resolveRequestId } from './request-id.js';

export const GITHUB_WEBHOOK_PATH = '/api/v1/webhooks/github';

/** The exact bytes GitHub signed; set only on `POST /api/v1/webhooks/github`. */
export interface GithubRawBodyRequest {
  githubRawBody?: Buffer | undefined;
}

function pathOf(url: string | undefined): string {
  const raw = url ?? '';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({
    error: {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'The webhook payload is too large.',
      requestId: resolveRequestId(req.headers['x-request-id']),
    },
  });
  res.statusCode = 413;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('connection', 'close');
  res.end(body);
}

/**
 * Buffers the GitHub webhook body unparsed so the HMAC is computed over exactly the bytes GitHub
 * signed (re-serialized JSON would not match). Registered before the JSON parser, which then skips
 * the already-consumed request. Bodies above `maxBytes` are refused with 413 before any parsing or
 * signature work; nothing of the body is logged.
 */
export function githubRawBody(maxBytes: number) {
  return (req: IncomingMessage & GithubRawBodyRequest, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== 'POST' || pathOf(req.url) !== GITHUB_WEBHOOK_PATH) {
      next();
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      tooLarge(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        tooLarge(req, res);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) {
        req.githubRawBody = Buffer.concat(chunks, size);
        next();
      }
    });
    req.on('error', (error: Error) => {
      if (!rejected) {
        rejected = true;
        next(error);
      }
    });
  };
}
