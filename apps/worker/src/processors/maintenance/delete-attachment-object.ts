import { UnrecoverableError } from 'bullmq';

import type { AsyncLocalTenantContext, AttachmentService } from '@company-ops/core';
import { attachmentObjectDeletePayloadSchema, outboxJobDataSchema } from '@company-ops/validation';

export const DELETE_ATTACHMENT_OBJECT_JOB = 'attachment-object.delete';

/**
 * Handles one `attachment-object.delete` job: removes the stored object of an attachment deleted
 * in the outbox event's own organization (never taken from the payload). A storage failure throws
 * so BullMQ retries; malformed data is a permanent failure. Re-delivery is safe because deleting an
 * absent object succeeds.
 */
export async function handleDeleteAttachmentObjectJob(
  data: unknown,
  deps: { readonly tenant: AsyncLocalTenantContext; readonly attachments: AttachmentService },
): Promise<{ deleted: boolean }> {
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== 'attachment.object.delete') {
    throw new UnrecoverableError('Invalid attachment deletion job data.');
  }
  const payload = attachmentObjectDeletePayloadSchema.safeParse(job.data.payload);
  if (!payload.success) {
    throw new UnrecoverableError('Invalid attachment deletion payload.');
  }
  const deleted = await deps.tenant.run({ organizationId: job.data.organizationId, memberId: null, userId: null }, () =>
    deps.attachments.deleteStoredObject(payload.data.attachmentId),
  );
  return { deleted };
}
