import { expiredPendingAttachments } from '@company-ops/core';
import type { AsyncLocalTenantContext, AttachmentService, PrismaClient } from '@company-ops/core';

export const EXPIRE_ATTACHMENTS_JOB = 'attachments.expire';
export const EXPIRE_ATTACHMENTS_EVERY_MS = 15 * 60_000;
const BATCH = 200;

/**
 * Marks upload intents that were never completed as DELETED and removes any orphaned object.
 * The scan is cross-organization (system maintenance); each cleanup runs in a system tenant
 * context of the attachment's own organization.
 */
export async function expirePendingAttachments(deps: {
  readonly prisma: PrismaClient;
  readonly tenant: AsyncLocalTenantContext;
  readonly attachments: AttachmentService;
}): Promise<number> {
  let expired = 0;
  for (const row of await expiredPendingAttachments(deps.prisma, BATCH)) {
    const done = await deps.tenant.run({ organizationId: row.organizationId, memberId: null, userId: null }, () =>
      deps.attachments.expirePendingUpload(row.id),
    );
    if (done) {
      expired += 1;
    }
  }
  return expired;
}
