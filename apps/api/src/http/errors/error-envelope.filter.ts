import { Catch, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';

import { resolveRequestId } from '../request-id.js';
import { toErrorEnvelope } from './error-envelope.js';

interface RequestLike {
  id?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();

    const requestId = typeof request.id === 'string' ? request.id : resolveRequestId(request.headers['x-request-id']);
    const { status, body } = toErrorEnvelope(exception, requestId);

    if (status >= 500) {
      this.logger.error({ err: exception, requestId, code: body.error.code }, 'Request failed');
    }

    response.status(status).json(body);
  }
}
