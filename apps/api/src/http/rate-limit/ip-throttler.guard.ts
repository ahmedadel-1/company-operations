import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

import type { HttpResponse } from '../http-types.js';

/**
 * Per-IP limits (SECURITY §5). The library names the header after the throttler (`Retry-After-auth`)
 * for every limiter except `default`; clients and proxies only understand `Retry-After`, so it is set
 * for all of them.
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<HttpResponse>()
      .setHeader('Retry-After', String(throttlerLimitDetail.timeToBlockExpire));
    await super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
