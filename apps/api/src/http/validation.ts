import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';
import type { StandardSchemaValidationPipeOptions } from '@nestjs/common';

import { ERROR_CODES } from '@company-ops/shared';
import type { FieldError } from '@company-ops/validation';

type Issues = Parameters<NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>>[0];

function issuePath(issue: Issues[number]): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
}

/** Field paths and codes only; never the rejected values (they may contain secrets). */
export function toFieldErrors(issues: Issues): FieldError[] {
  return issues.map((issue) => ({ path: issuePath(issue), code: 'invalid' }));
}

/** Validates every `@Body/@Query/@Param({ schema })` against the shared Zod contracts (ADR-0004). */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new BadRequestException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'The request is invalid.',
        fieldErrors: toFieldErrors(issues),
      }),
  });
}
