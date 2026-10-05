import { Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { NotificationService } from '@company-ops/core';
import type { NotificationView } from '@company-ops/core';
import {
  idParamsSchema,
  markAllReadResponseSchema,
  notificationListQuerySchema,
  notificationPageResponseSchema,
  notificationResponseSchema,
  unreadCountResponseSchema,
} from '@company-ops/validation';
import type { IdParams, NotificationListQuery } from '@company-ops/validation';

import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * The caller's own in-app notifications (P1-16 foundation). Always limited to the acting member;
 * another member's notification id is 404. Live updates arrive over `GET /notifications/events/stream`.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(notificationPageResponseSchema)
  async list(
    @Query({ schema: notificationListQuerySchema }) query: NotificationListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: readonly NotificationView[]; page: { nextCursor: string | null } }> {
    const page = await this.notifications.list(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Get('unread-count')
  @ApiResult(unreadCountResponseSchema)
  async unreadCount(@Req() request: HttpRequest): Promise<{ data: { unread: number } }> {
    return { data: { unread: await this.notifications.unreadCount(await this.actions.create(request)) } };
  }

  @Post('read-all')
  @ApiResult(markAllReadResponseSchema)
  async markAllRead(@Req() request: HttpRequest): Promise<{ data: { updated: number } }> {
    return { data: { updated: await this.notifications.markAllRead(await this.actions.create(request)) } };
  }

  @Post(':id/read')
  @ApiResult(notificationResponseSchema)
  async markRead(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: NotificationView }> {
    return { data: await this.notifications.markRead(await this.actions.create(request), params.id) };
  }
}
