import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { ERROR_CODES } from '@company-ops/shared';

import type { HttpRequest } from '../http/http-types.js';
import { RealtimeHub } from './realtime-hub.js';

/**
 * Refuses a new live-update stream with `429` while the user already has the maximum open. It runs
 * as a guard because an `@Sse()` handler's own errors arrive after the `200` stream headers.
 */
@Injectable()
export class StreamCapacityGuard implements CanActivate {
  constructor(@Inject(RealtimeHub) private readonly hub: RealtimeHub) {}

  canActivate(context: ExecutionContext): boolean {
    const userId = context.switchToHttp().getRequest<HttpRequest>().auth?.session.userId;
    if (userId !== undefined && !this.hub.hasCapacity(userId)) {
      throw new HttpException(
        { code: ERROR_CODES.RATE_LIMITED, message: 'Too many open live-update connections.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
