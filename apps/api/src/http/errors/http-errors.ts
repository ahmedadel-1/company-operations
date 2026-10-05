import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { ERROR_CODES } from '@company-ops/shared';

export const unauthenticated = (): UnauthorizedException =>
  new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Authentication is required.' });

export const sessionExpired = (): UnauthorizedException =>
  new UnauthorizedException({ code: ERROR_CODES.SESSION_EXPIRED, message: 'Your session has ended. Sign in again.' });

export const mfaRequired = (): UnauthorizedException =>
  new UnauthorizedException({
    code: ERROR_CODES.MFA_REQUIRED,
    message: 'Multi-factor authentication is required for this action.',
  });

export const csrfInvalid = (): ForbiddenException =>
  new ForbiddenException({ code: ERROR_CODES.CSRF_INVALID, message: 'The request could not be verified.' });
