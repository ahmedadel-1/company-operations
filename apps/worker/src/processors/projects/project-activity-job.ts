import { UnrecoverableError } from 'bullmq';

import type {
  ActivityWriteResult,
  AsyncLocalTenantContext,
  DashboardInvalidator,
  ProjectActivityWriter,
} from '@company-ops/core';
import { outboxJobDataSchema, projectActivityRecordedPayloadSchema } from '@company-ops/validation';

export const PROJECT_ACTIVITY_RECORD_JOB = 'project-activity.record';

/**
 * Handles one `project-activity.record` job: appends a project timeline entry inside a system
 * tenant context of the outbox event's own organization (never taken from the payload). Malformed
 * data or a project outside that organization is a permanent failure; re-delivery is safe because
 * the writer is idempotent by the outbox event id.
 */
export async function handleProjectActivityJob(
  jobName: string,
  data: unknown,
  deps: {
    readonly tenant: AsyncLocalTenantContext;
    readonly writer: ProjectActivityWriter;
    readonly invalidate?: DashboardInvalidator;
  },
): Promise<ActivityWriteResult> {
  if (jobName !== PROJECT_ACTIVITY_RECORD_JOB) {
    throw new UnrecoverableError(`Unknown job "${jobName}" on the projects queue.`);
  }
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== 'project.activity.recorded') {
    throw new UnrecoverableError('Invalid project activity job data.');
  }
  const payload = projectActivityRecordedPayloadSchema.safeParse(job.data.payload);
  if (!payload.success) {
    throw new UnrecoverableError('Invalid project activity payload.');
  }
  const { eventId, organizationId } = job.data;
  const result = await deps.tenant.run({ organizationId, memberId: null, userId: null }, () =>
    deps.writer.record(eventId, payload.data),
  );
  if (result.kind === 'project_not_found') {
    throw new UnrecoverableError('The project does not belong to the event organization.');
  }
  // Project changes (health, status, staffing, daily reports) are announced through their activity.
  await deps.invalidate?.(organizationId, ['projects']);
  return result;
}
