import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';

import { AsyncLocalTenantContext, ProjectActivityWriter } from '@company-ops/core';
import type { DashboardInvalidator } from '@company-ops/core';

import { DASHBOARD_INVALIDATOR } from '../../worker-tokens.js';
import { handleProjectActivityJob } from './project-activity-job.js';

@Processor('projects')
export class ProjectsProcessor extends WorkerHost {
  constructor(
    @Inject(AsyncLocalTenantContext) private readonly tenant: AsyncLocalTenantContext,
    @Inject(ProjectActivityWriter) private readonly writer: ProjectActivityWriter,
    @Inject(DASHBOARD_INVALIDATOR) private readonly invalidate: DashboardInvalidator,
  ) {
    super();
  }

  async process(job: Job): Promise<{ kind: string }> {
    const result = await handleProjectActivityJob(job.name, job.data, {
      tenant: this.tenant,
      writer: this.writer,
      invalidate: this.invalidate,
    });
    return { kind: result.kind };
  }
}
