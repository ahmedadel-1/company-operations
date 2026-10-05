import type { Params } from 'nestjs-pino';

import { pinoSecurityOptions } from '@company-ops/shared';

import type { ApiEnv } from '../config/api-env.js';
import type { HttpRequest } from '../http/http-types.js';
import { resolveRequestId } from '../http/request-id.js';

/** Query strings can carry OIDC codes and state (callback); logs keep the path only. */
export function stripQuery(url: unknown): string {
  const value = typeof url === 'string' ? url : '';
  const index = value.indexOf('?');
  return index < 0 ? value : value.slice(0, index);
}

/** `SessionGuard` attaches the authenticated state to the request object. */
function authOf(req: object): HttpRequest['auth'] {
  const auth: unknown = Reflect.get(req, 'auth');
  return typeof auth === 'object' && auth !== null && 'tenant' in auth ? (auth as HttpRequest['auth']) : undefined;
}

const HEALTH_PATH = /^\/api\/v1\/health\/(live|ready)$/;

/**
 * Successful container health probes (every few seconds per replica) log at debug; failing probes and
 * every other request keep the usual levels.
 */
export function requestLogLevel(url: unknown, statusCode: number, error: unknown): 'debug' | 'info' | 'error' {
  if (error !== undefined || statusCode >= 500) {
    return 'error';
  }
  return statusCode < 400 && HEALTH_PATH.test(stripQuery(url)) ? 'debug' : 'info';
}

export function createLoggerParams(env: ApiEnv): Params {
  const security = pinoSecurityOptions();
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      ...security,
      genReqId: (req, res) => {
        const requestId = resolveRequestId(req.headers['x-request-id']);
        res.setHeader('X-Request-Id', requestId);
        return requestId;
      },
      // No headers (cookies, CSRF tokens) and no query strings in request logs (SECURITY §7).
      serializers: {
        ...security.serializers,
        req: (req: { id?: unknown; method?: unknown; url?: unknown }) => ({
          id: req.id,
          method: req.method,
          url: stripQuery(req.url),
        }),
        res: (res: { statusCode?: unknown }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (req, res, error) => requestLogLevel(req.url, res.statusCode, error),
      // The request id is bound once per request (application and completion lines). Custom props are
      // evaluated again on completion, so they must not repeat it or the line carries the key twice.
      quietReqLogger: true,
      customAttributeKeys: { reqId: 'requestId' },
      customProps: (req) => {
        const tenant = authOf(req)?.tenant;
        return { orgId: tenant?.organizationId, userId: tenant?.userId };
      },
    },
  };
}
