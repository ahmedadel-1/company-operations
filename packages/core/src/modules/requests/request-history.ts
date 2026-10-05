import type { Prisma } from '@company-ops/db';
import { requestEventTypeSchema } from '@company-ops/validation';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';

export const REQUEST_EVENT_TYPES = requestEventTypeSchema.options;
export type RequestEventType = (typeof REQUEST_EVENT_TYPES)[number];

/** Metadata kept on history rows: identifiers, enum values and short human notes only. */
export interface RequestEventMetadata {
  readonly from?: string;
  readonly to?: string;
  /** Decision comment, cancellation or reassignment reason, fulfillment note. */
  readonly note?: string;
  /** The approver a delegate acted for, or the member a step was (re)assigned to. */
  readonly subjectMemberId?: string;
  readonly approvalId?: string;
  readonly delegationId?: string;
  readonly approverMemberIds?: readonly string[];
  readonly workflowVersionId?: string;
  readonly effectId?: string;
  readonly reason?: string;
}

/**
 * Appends one entry to the request's history (append-only by trigger and grants; separate from the
 * audit log). Returns the event id, used as the cause of notifications and effects.
 */
export async function recordRequestEvent(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  event: {
    readonly type: RequestEventType;
    readonly actorMemberId: string | null;
    readonly stepOrder?: number | null;
    readonly metadata?: RequestEventMetadata;
  },
): Promise<string> {
  const metadata: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    if (value !== undefined) {
      metadata[key] = Array.isArray(value) ? [...(value as readonly string[])] : (value as string);
    }
  }
  const row = await db.requestEvent.create({
    data: {
      organizationId,
      requestId,
      actorMemberId: event.actorMemberId,
      type: event.type,
      stepOrder: event.stepOrder ?? null,
      metadata,
    },
    select: { id: true },
  });
  return row.id;
}
