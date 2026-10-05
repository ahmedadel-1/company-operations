import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GITHUB_WEBHOOK_PATH, githubRawBody } from '../src/http/github-raw-body.js';
import type { GithubRawBodyRequest } from '../src/http/github-raw-body.js';

const MAX = 64;
let server: Server;
let base: string;

/** Echoes what the middleware handed on: the raw body (hex) or that nothing was buffered. */
beforeAll(async () => {
  const middleware = githubRawBody(MAX);
  server = createServer((req: IncomingMessage & GithubRawBodyRequest, res) => {
    middleware(req, res, (error?: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : null,
          raw: req.githubRawBody === undefined ? null : req.githubRawBody.toString('hex'),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const post = (path: string, body: NonNullable<RequestInit['body']>, extra: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, { ...extra, method: 'POST', body });

describe('githubRawBody', () => {
  it('keeps the exact signed bytes, including whitespace and non-UTF-8 sequences', async () => {
    const bytes = Buffer.concat([Buffer.from('{ "a" :\r\n 1 }'), Buffer.from([0xff, 0xfe])]);
    const response = await post(GITHUB_WEBHOOK_PATH, bytes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: null, raw: bytes.toString('hex') });
  });

  it('applies to the webhook path with a query string, and to nothing else', async () => {
    expect(((await (await post(`${GITHUB_WEBHOOK_PATH}?x=1`, 'ab')).json()) as { raw: unknown }).raw).toBe('6162');
    for (const path of ['/api/v1/webhooks/github/x', '/api/v1/webhooks/githubx', '/api/v1/webhooks/jira']) {
      expect(((await (await post(path, 'ab')).json()) as { raw: unknown }).raw).toBeNull();
    }
    const get = await fetch(`${base}${GITHUB_WEBHOOK_PATH}`);
    expect(((await get.json()) as { raw: unknown }).raw).toBeNull();
  });

  it('accepts a body of exactly the limit', async () => {
    const response = await post(GITHUB_WEBHOOK_PATH, 'x'.repeat(MAX));
    expect(((await response.json()) as { raw: string }).raw).toHaveLength(MAX * 2);
  });

  it('refuses a declared oversize body with 413 and the error envelope', async () => {
    const response = await post(GITHUB_WEBHOOK_PATH, 'x'.repeat(MAX + 1));
    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).not.toContain('x'.repeat(8));
    expect(body.error.requestId).toMatch(/.+/);
  });

  it('refuses an undeclared (chunked) oversize body once the limit is crossed', async () => {
    const encoder = new TextEncoder();
    const parts = [encoder.encode('x'.repeat(40)), encoder.encode('x'.repeat(40))];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(next);
        }
      },
    });
    const response = await post(GITHUB_WEBHOOK_PATH, stream, { duplex: 'half' }).catch(() => null);
    // The server may close the connection before the client finishes sending; either way no body reaches the handler.
    if (response !== null) {
      expect(response.status).toBe(413);
    }
  });
});
