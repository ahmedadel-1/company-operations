// Post-deploy smoke test (docs/runbooks/deploy.md §Smoke). Read-only: it signs nobody in and changes
// nothing. Runs with Node 24 native type stripping:
//
//   node scripts/release/smoke.ts --url https://ops.example.com [--http-port 80]
//        [--resolve <ip>] [--ca <pem file>]
//
// --resolve sends every request for the URL's host to <ip> (rehearsals without DNS); --ca trusts an extra
// CA (self-signed rehearsal certificates). Prints one line per check and exits 1 if any check fails.
// Output never contains cookies, tokens or response bodies.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import { connect } from 'node:tls';
import type { SecureVersion } from 'node:tls';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'http-port': { type: 'string' },
    resolve: { type: 'string' },
    ca: { type: 'string' },
  },
});
if (values.url === undefined) {
  console.error(
    'usage: node scripts/release/smoke.ts --url https://<host> [--http-port 80] [--resolve <ip>] [--ca <file>]',
  );
  process.exit(2);
}
const base = new URL(values.url);
const origin = base.origin;
const host = base.hostname;
const port = Number(base.port === '' ? 443 : base.port);
const ca = values.ca === undefined ? undefined : readFileSync(values.ca, 'utf8');
const resolveTo = values.resolve;
const lookup: LookupFunction | undefined =
  resolveTo === undefined
    ? undefined
    : (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all === true) {
          callback(null, [{ address: resolveTo, family: 4 }]);
        } else {
          callback(null, resolveTo, 4);
        }
      };

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function get(
  path: string,
  options: { readonly scheme?: 'http' | 'https'; readonly httpPort?: number } = {},
): Promise<Reply> {
  const scheme = options.scheme ?? 'https';
  const send = scheme === 'https' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host,
        port: scheme === 'https' ? port : options.httpPort,
        path,
        method: 'GET',
        servername: host,
        headers: { host: scheme === 'https' && port !== 443 ? `${host}:${String(port)}` : host },
        ...(lookup === undefined ? {} : { lookup }),
        ...(ca === undefined ? {} : { ca }),
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function tlsHandshake(servername: string, maxVersion?: SecureVersion): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: resolveTo ?? host,
      port,
      servername,
      ...(ca === undefined ? {} : { ca }),
      ...(maxVersion === undefined ? {} : { maxVersion, minVersion: 'TLSv1' }),
      timeout: 10_000,
    });
    socket.once('secureConnect', () => {
      const protocol = socket.getProtocol() ?? 'unknown';
      socket.end();
      resolve(protocol);
    });
    socket.once('timeout', () => {
      socket.destroy(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

const header = (reply: Reply, name: string): string => {
  const value = reply.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
};

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const problem = await run();
    results.push({ name, ok: problem === undefined, detail: problem ?? '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : 'failed' });
  }
}

await check('TLS 1.2+ negotiated with a trusted certificate', async () => {
  const protocol = await tlsHandshake(host);
  return protocol === 'TLSv1.2' || protocol === 'TLSv1.3' ? undefined : `negotiated ${protocol}`;
});
await check('TLS 1.1 and older refused', async () => {
  try {
    await tlsHandshake(host, 'TLSv1.1');
    return 'a TLS 1.1 handshake succeeded';
  } catch {
    return undefined;
  }
});
await check('unknown server names refused during the handshake', async () => {
  try {
    await tlsHandshake('unknown-host.invalid');
    return 'handshake for an unknown name succeeded';
  } catch {
    return undefined;
  }
});
if (values['http-port'] !== undefined) {
  const httpPort = Number(values['http-port']);
  await check('plain HTTP redirects permanently to the canonical HTTPS origin', async () => {
    const reply = await get('/projects?x=1', { scheme: 'http', httpPort });
    const location = header(reply, 'location');
    return reply.status === 308 && location.startsWith(`https://${host}`) && location.endsWith('/projects?x=1')
      ? undefined
      : `status ${String(reply.status)}`;
  });
}
await check('web liveness through the proxy, with HSTS', async () => {
  const reply = await get('/healthz');
  const hsts = /max-age=(\d+)/.exec(header(reply, 'strict-transport-security'));
  if (reply.status !== 200) return `status ${String(reply.status)}`;
  return hsts !== null && Number(hsts[1]) >= 31_536_000 ? undefined : 'HSTS missing or shorter than one year';
});
await check('API readiness: database and Redis up', async () => {
  const reply = await get('/api/v1/health/ready');
  const body = JSON.parse(reply.body) as { info?: Record<string, { status?: string }> };
  return reply.status === 200 && body.info?.database?.status === 'up' && body.info.redis?.status === 'up'
    ? undefined
    : `status ${String(reply.status)}`;
});
await check('API responses: request id, nosniff, no X-Powered-By', async () => {
  const reply = await get('/api/v1/health/live');
  if (!/^[0-9a-f-]{36}$/.test(header(reply, 'x-request-id'))) return 'no request id';
  if (header(reply, 'x-content-type-options') !== 'nosniff') return 'nosniff missing';
  return header(reply, 'x-powered-by') === '' ? undefined : 'X-Powered-By present';
});
await check('sign-in page: nonce CSP without unsafe-eval, frame and content-type protections', async () => {
  const reply = await get('/sign-in');
  const csp = header(reply, 'content-security-policy');
  if (reply.status !== 200) return `status ${String(reply.status)}`;
  if (!/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp)) return 'script-src is not nonce-based';
  if (csp.includes('unsafe-eval')) return 'unsafe-eval present';
  if (!csp.includes("frame-ancestors 'none'") || !csp.includes("object-src 'none'"))
    return 'frame/object rules missing';
  if (header(reply, 'x-content-type-options') !== 'nosniff') return 'nosniff missing';
  if (header(reply, 'referrer-policy') === '' || header(reply, 'permissions-policy') === '')
    return 'referrer/permissions policy missing';
  return header(reply, 'x-powered-by') === '' ? undefined : 'X-Powered-By present';
});
await check('static assets are immutable', async () => {
  const page = await get('/sign-in');
  const asset = /\/_next\/static\/[^"'\s)]+\.(?:js|css)/.exec(page.body)?.[0];
  if (asset === undefined) return 'no static asset referenced';
  const reply = await get(asset);
  return reply.status === 200 && header(reply, 'cache-control').includes('immutable')
    ? undefined
    : `status ${String(reply.status)}`;
});
await check('sign-in starts an OIDC code flow with PKCE at the public issuer', async () => {
  const reply = await get('/api/v1/auth/login');
  const location = header(reply, 'location');
  const cookie = header(reply, 'set-cookie');
  if (reply.status !== 302) return `status ${String(reply.status)}`;
  if (!location.startsWith(`${origin}/auth/realms/company-ops/protocol/openid-connect/auth?`))
    return 'unexpected redirect target';
  const params = new URL(location).searchParams;
  if (params.get('code_challenge_method') !== 'S256' || params.get('state') === null || params.get('nonce') === null) {
    return 'PKCE, state or nonce missing';
  }
  return /__Host-ops_oidc=[^;]*;.*Secure/i.test(cookie) && /HttpOnly/i.test(cookie) && cookie.includes('Path=/')
    ? undefined
    : 'transaction cookie is not __Host-, Secure, HttpOnly';
});
await check('identity provider discovery names the public issuer', async () => {
  const reply = await get('/auth/realms/company-ops/.well-known/openid-configuration');
  const issuer = (JSON.parse(reply.body) as { issuer?: string }).issuer;
  return reply.status === 200 && issuer === `${origin}/auth/realms/company-ops`
    ? undefined
    : `issuer ${String(issuer)}`;
});
await check('administration and API docs are not reachable from outside', async () => {
  for (const path of ['/auth/admin/', '/auth/admin/master/console/', '/auth/realms/master/', '/api/v1/docs']) {
    const reply = await get(path);
    if (reply.status !== 404) return `${path} answered ${String(reply.status)}`;
  }
  return undefined;
});
await check('protected API refuses anonymous callers', async () => {
  const reply = await get('/api/v1/me');
  return reply.status === 401 ? undefined : `status ${String(reply.status)}`;
});

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : ` (${result.detail})`}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${String(results.length - failed)}/${String(results.length)} smoke checks passed`);
process.exit(failed === 0 ? 0 : 1);
