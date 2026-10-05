import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ERROR_CODES } from '@company-ops/shared';
import type { PermissionKey } from '@company-ops/shared';

import { mfaRequired } from '../../http/errors/http-errors.js';
import type { HttpRequest } from '../../http/http-types.js';
import { AuthService } from '../auth.service.js';
import { REQUIRED_PERMISSION } from '../decorators.js';

/**
 * Route-level authorization (SECURITY §2.2): the member must hold the permission at some scope.
 * Privileged permissions (§2.3) additionally require a fresh MFA authentication (MfaGuard role):
 * `401 MFA_REQUIRED` tells the web app to start step-up. Resource scope is enforced by services.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<PermissionKey | undefined>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (permission === undefined) {
      return true;
    }
    const session = context.switchToHttp().getRequest<HttpRequest>().auth?.session;
    const decision =
      session === undefined ? { granted: false, mfaMissing: false } : this.auth.checkPermission(session, permission);
    if (!decision.granted) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You do not have permission to perform this action.',
      });
    }
    if (decision.mfaMissing) {
      throw mfaRequired();
    }
    return true;
  }
}
