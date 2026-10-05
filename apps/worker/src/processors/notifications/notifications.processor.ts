import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, NotificationDeliveryService, NotificationWriter } from '@company-ops/core';
import type { DashboardInvalidator, RealtimePublisher, TenantScopedClient } from '@company-ops/core';

import { DASHBOARD_INVALIDATOR, REALTIME_PUBLISHER, TENANT_DB } from '../../worker-tokens.js';
import { handleNotificationJob } from './notification-job.js';
import type { NotificationJobResult } from './notification-job.js';

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
    @Inject(TENANT_DB) private readonly db: TenantScopedClient,
    @Inject(NotificationWriter) private readonly writer: NotificationWriter,
    @Inject(NotificationDeliveryService) private readonly delivery: NotificationDeliveryService,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
    @Inject(DASHBOARD_INVALIDATOR) private readonly invalidate: DashboardInvalidator,
  ) {
    super();
  }

  async process(job: Job): Promise<NotificationJobResult> {
    return handleNotificationJob(job.name, job.data, {
      tenant: this.tenant,
      db: this.db,
      writer: this.writer,
      delivery: this.delivery,
      realtime: this.realtime,
      invalidate: this.invalidate,
      onRealtimeError: (error) => {
        this.logger.warn({ err: error, jobId: job.id }, 'Real-time publish failed');
      },
    });
  }
}
