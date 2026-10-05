import { describe, expect, it } from 'vitest';

import { ApiError, request } from '../src/lib/api';

const response = (status: number) => new Response(null, { status });

describe('request()', () => {
  it('returns data and turns error envelopes into ApiError', async () => {
    await expect(request(() => Promise.resolve({ data: { ok: true }, response: response(200) }))).resolves.toEqual({
      ok: true,
    });
    const failure = request(() =>
      Promise.resolve({
        error: { error: { code: 'FORBIDDEN', message: 'no', requestId: 'r1', fieldErrors: [] } },
        response: response(403),
      }),
    );
    await expect(failure).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', requestId: 'r1' });
  });

  it('keeps an API error raised before the request is sent (e.g. CSRF token fetch with an ended session)', async () => {
    const ended = new ApiError(401, 'UNAUTHENTICATED', 'signed out', 'r2', []);
    await expect(request(() => Promise.reject(ended))).rejects.toBe(ended);
  });

  it('reports transport failures as NETWORK_ERROR', async () => {
    await expect(request(() => Promise.reject(new TypeError('fetch failed')))).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });
});
