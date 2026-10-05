/** Liveness probe for the container health check and the reverse proxy; never touches the API. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok', { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
}
