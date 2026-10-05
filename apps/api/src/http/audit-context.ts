import type { AuditRequestContext } from '@company-ops/core';

import type { HttpRequest } from './http-types.js';

/** Request facts recorded on audit rows (SECURITY §7). */
export function auditContext(request: HttpRequest): AuditRequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: typeof request.id === 'string' ? request.id : undefined,
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
}
