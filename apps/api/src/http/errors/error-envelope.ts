import { HttpException, HttpStatus } from '@nestjs/common';

import { DomainError, InvalidFieldsError, InvalidInputError } from '@company-ops/core';
import { defaultErrorCodeForStatus, ERROR_CODES } from '@company-ops/shared';
import type { ErrorCode } from '@company-ops/shared';
import type { ErrorEnvelope, FieldError } from '@company-ops/validation';

import { isDependencyFailure } from './dependency-failure.js';

const knownCodes: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

const defaultMessages: Readonly<Partial<Record<ErrorCode, string>>> = {
  VALIDATION_FAILED: 'The request is invalid.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  SESSION_EXPIRED: 'Your session has ended. Sign in again.',
  MFA_REQUIRED: 'Multi-factor authentication is required for this action.',
  CSRF_INVALID: 'The request could not be verified.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  DEPENDENCY_UNAVAILABLE: 'A required service is temporarily unavailable.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

export interface ErrorEnvelopeResult {
  status: number;
  body: ErrorEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldErrorList(value: unknown): value is FieldError[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.path === 'string' && typeof item.code === 'string')
  );
}

/**
 * Maps any thrown value to the API error envelope (ARCHITECTURE §8.1). Domain errors carry
 * caller-safe messages at any status (e.g. 503 JIRA_UNAVAILABLE); other `HttpException`s expose their
 * message only below 500, and unexpected errors never leak internal details.
 */
export function toErrorEnvelope(exception: unknown, requestId: string): ErrorEnvelopeResult {
  if (exception instanceof DomainError) {
    const error: ErrorEnvelope['error'] = { code: exception.code, message: exception.message, requestId };
    if (exception.details !== undefined) {
      error.details = { ...exception.details };
    }
    if (exception instanceof InvalidInputError) {
      error.fieldErrors = [{ path: exception.field, code: 'invalid' }];
    }
    if (exception instanceof InvalidFieldsError) {
      error.fieldErrors = exception.fieldErrors.map((field) => ({ path: field.path, code: field.code }));
    }
    return { status: exception.status, body: { error } };
  }
  if (!(exception instanceof HttpException) && isDependencyFailure(exception)) {
    const code = ERROR_CODES.DEPENDENCY_UNAVAILABLE;
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { error: { code, message: defaultMessages[code] ?? '', requestId } },
    };
  }
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const payload: unknown = exception instanceof HttpException ? exception.getResponse() : undefined;
  const fields = isRecord(payload) ? payload : {};

  const requestedCode = fields.code;
  const code: ErrorCode =
    typeof requestedCode === 'string' && knownCodes.has(requestedCode)
      ? (requestedCode as ErrorCode)
      : defaultErrorCodeForStatus(status);

  const fallbackMessage = defaultMessages[code] ?? defaultMessages.INTERNAL_ERROR ?? '';
  const exposedMessage = typeof fields.message === 'string' ? fields.message : undefined;
  const message = status < 500 && exposedMessage !== undefined ? exposedMessage : fallbackMessage;

  const error: ErrorEnvelope['error'] = { code, message, requestId };
  const details = fields.details;
  if (isRecord(details) && (status < 500 || code === ERROR_CODES.DEPENDENCY_UNAVAILABLE)) {
    error.details = details;
  }
  const fieldErrors = fields.fieldErrors;
  if (isFieldErrorList(fieldErrors)) {
    error.fieldErrors = fieldErrors;
  }

  return { status, body: { error } };
}
