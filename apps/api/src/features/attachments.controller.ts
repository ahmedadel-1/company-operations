import { Body, Controller, Delete, Get, Header, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AttachmentService } from '@company-ops/core';
import type { AttachmentView, UploadIntent } from '@company-ops/core';
import {
  attachmentListQuerySchema,
  attachmentListResponseSchema,
  attachmentResponseSchema,
  createUploadIntentRequestSchema,
  downloadUrlResponseSchema,
  idParamsSchema,
  uploadIntentResponseSchema,
} from '@company-ops/validation';
import type { AttachmentListQuery, CreateUploadIntentRequest, IdParams } from '@company-ops/validation';

import { PrincipalRateLimit } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Attachment foundation (P1-14). Bytes never pass through the API: the client uploads to a
 * pre-signed URL, then calls `complete`, which verifies size, type (magic bytes), checksum and
 * scan result. Access is decided by the owner type's policy; invisible attachments are 404.
 */
@ApiTags('attachments')
@Controller({ path: 'attachments', version: '1' })
export class AttachmentsController {
  constructor(
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  /** Available attachments of one owner; the owner must be visible to the caller (else 404). */
  @Get()
  @ApiResult(attachmentListResponseSchema)
  async list(
    @Query({ schema: attachmentListQuerySchema }) query: AttachmentListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: AttachmentView[] }> {
    return {
      data: await this.attachments.listForOwner(await this.actions.create(request), query.ownerType, query.ownerId),
    };
  }

  @Post('upload-intents')
  @PrincipalRateLimit('upload')
  @Header('Cache-Control', 'no-store')
  @ApiResult(uploadIntentResponseSchema, 201)
  async createUploadIntent(
    @Body({ schema: createUploadIntentRequestSchema }) body: CreateUploadIntentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: UploadIntent }> {
    return { data: await this.attachments.createUploadIntent(await this.actions.create(request), body) };
  }

  @Post(':id/complete')
  @ApiResult(attachmentResponseSchema)
  async complete(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: AttachmentView }> {
    return { data: await this.attachments.complete(await this.actions.create(request), params.id) };
  }

  @Get(':id')
  @ApiResult(attachmentResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: AttachmentView }> {
    return { data: await this.attachments.get(await this.actions.create(request), params.id) };
  }

  /** Short-lived pre-signed GET with a safe Content-Disposition; each issue is audited. */
  @Get(':id/download-url')
  @Header('Cache-Control', 'no-store')
  @ApiResult(downloadUrlResponseSchema)
  async downloadUrl(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: { url: string } }> {
    return { data: { url: await this.attachments.downloadUrl(await this.actions.create(request), params.id) } };
  }

  /** Soft delete, when the owner policy allows it (e.g. the reporter of a daily report). */
  @Delete(':id')
  @PrincipalRateLimit('upload')
  @ApiNoContent()
  async delete(@Param({ schema: idParamsSchema }) params: IdParams, @Req() request: HttpRequest): Promise<void> {
    await this.attachments.delete(await this.actions.create(request), params.id);
  }
}
