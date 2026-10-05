import { applyDecorators, HttpCode } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { ApiResponseCommonMetadata } from '@nestjs/swagger';

import { errorEnvelopeSchema } from '@company-ops/validation';

type ResponseSchema = NonNullable<ApiResponseCommonMetadata['standardSchema']>;

const errorResponse = ApiResponse({
  status: 'default',
  description: 'Error envelope (ARCHITECTURE §8.1)',
  standardSchema: errorEnvelopeSchema,
});

/** Documents the success body from its shared Zod schema plus the common error envelope. */
export const ApiResult = (schema: ResponseSchema, status = 200): MethodDecorator =>
  applyDecorators(
    HttpCode(status),
    ApiResponse({ status, description: status === 201 ? 'Created' : 'OK', standardSchema: schema }),
    errorResponse,
  );

/** Browser-facing redirect endpoints (OIDC flow); failures redirect to `/?authError=<reason>`. */
export const ApiRedirect = (description: string): MethodDecorator =>
  applyDecorators(ApiResponse({ status: 302, description }), errorResponse);

/** `200` without a body (protocol endpoints whose caller ignores the body). */
export const ApiEmptyOk = (): MethodDecorator =>
  applyDecorators(HttpCode(200), ApiResponse({ status: 200, description: 'OK' }), errorResponse);

/** A CSV download (`text/csv`, attachment) plus the common error envelope. */
export const ApiCsv = (): MethodDecorator =>
  applyDecorators(
    HttpCode(200),
    ApiResponse({
      status: 200,
      description: 'CSV file (UTF-8 with byte order mark)',
      content: { 'text/csv': { schema: { type: 'string' } } },
    }),
    errorResponse,
  );

/** `204 No Content` plus the common error envelope. */
export const ApiNoContent = (): MethodDecorator =>
  applyDecorators(HttpCode(204), ApiResponse({ status: 204, description: 'No Content' }), errorResponse);
