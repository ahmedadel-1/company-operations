import { ERROR_CODES } from '@company-ops/shared';
import type { ErrorCode } from '@company-ops/shared';

/**
 * Expected, client-facing failures raised by application code. The HTTP adapter maps `status` and
 * `code` to the error envelope (ARCHITECTURE §8.1); messages must be safe to show to the caller.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Unknown, foreign-tenant or out-of-scope resource (SECURITY §2.2, ADR-0003 invariant 4). */
export class NotFoundError extends DomainError {
  readonly status = 404;
  readonly code = ERROR_CODES.NOT_FOUND;

  constructor(resource: string) {
    super(`${resource} was not found.`);
  }
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
  readonly code = ERROR_CODES.FORBIDDEN;

  constructor(message = 'You do not have permission to perform this action.') {
    super(message);
  }
}

export class ConflictError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.CONFLICT;
}

/** Optimistic-concurrency failure: the resource changed since the caller read `version`. */
export class VersionConflictError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.VERSION_CONFLICT;

  constructor(resource: string) {
    super(`${resource} was changed by someone else. Reload and try again.`);
  }
}

/** A state change that the resource's current state does not allow (e.g. revoking the last administrator). */
export class InvalidTransitionError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.INVALID_TRANSITION;
}

/**
 * Input that passed schema validation but is semantically invalid (unknown cursor, a reference that
 * would create a cycle). `field` names the offending input; the rejected value is never echoed.
 */
export class InvalidInputError extends DomainError {
  readonly status = 400;
  readonly code = ERROR_CODES.VALIDATION_FAILED;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export interface DomainFieldError {
  readonly path: string;
  readonly code: string;
}

/**
 * Several semantically invalid inputs at once (a submitted form, a workflow that cannot be published).
 * Field paths and short codes only; rejected values are never echoed.
 */
export class InvalidFieldsError extends DomainError {
  readonly status = 400;
  readonly code: ErrorCode;
  readonly fieldErrors: readonly DomainFieldError[];

  constructor(
    message: string,
    fieldErrors: readonly DomainFieldError[],
    code: ErrorCode = ERROR_CODES.VALIDATION_FAILED,
  ) {
    super(message);
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Programming error: tenant-owned data was accessed without, or outside, the active tenant context.
 * Never a client error; surfaces as 500 INTERNAL_ERROR without details.
 */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}
