import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { fromDateOnly } from '../projects/business-date.js';
import type { NormalizedData } from './engine/conditions.js';
import { attendanceEffect, resolveApprovers } from './engine/workflow.js';
import type { ApproverDirectory } from './engine/workflow.js';
import type { LoadedVersion } from './request-config.js';
import { recordRequestEvent } from './request-history.js';
import { delegatesOf, notifyRequestRecipients, requestAdminMemberIds } from './request-notify.js';

const HOUR_MS = 3_600_000;

export interface RequestRef {
  readonly id: string;
  readonly requesterMemberId: string;
  readonly requestTypeId: string;
}

export interface WorkflowRun {
  readonly db: TenantDb;
  readonly organizationId: string;
  readonly now: Date;
  /** Null for system changes. */
  readonly actorMemberId: string | null;
}

/**
 * Activates an approval step: resolves its approvers now and freezes them as assignments (ADR-0021).
 * When nobody can be resolved the step stays active and unassigned and request administrators are told;
 * nothing is ever approved automatically. The caller has locked the request row and set its
 * `current_step_order`.
 */
export async function activateApprovalStep(
  run: WorkflowRun,
  request: RequestRef,
  version: LoadedVersion,
  order: number,
  data: NormalizedData,
  directory: ApproverDirectory,
): Promise<{ readonly approverIds: readonly string[] }> {
  const step = version.stepsByOrder.get(order);
  if (step?.kind !== 'APPROVAL') {
    throw new Error(`Step ${String(order)} is not an approval step.`);
  }
  const resolution = resolveApprovers(step, data, directory);
  const approverIds = resolution.ok ? resolution.memberIds : [];
  if (approverIds.length === 0) {
    const eventId = await recordRequestEvent(run.db, run.organizationId, request.id, {
      type: 'STEP_UNASSIGNED',
      actorMemberId: null,
      stepOrder: order,
      metadata: { reason: resolution.ok ? 'NO_CANDIDATE' : resolution.reason },
    });
    await notifyRequestRecipients(
      run.db,
      run.organizationId,
      request.id,
      await requestAdminMemberIds(run.db, run.organizationId),
      { type: 'REQUEST_APPROVAL_UNASSIGNED', severity: 'WARNING', email: true, causeId: eventId },
      null,
      run.now,
    );
    return { approverIds };
  }
  const dueAt = step.slaHours === null ? null : new Date(run.now.getTime() + step.slaHours * HOUR_MS);
  await run.db.requestApproval.createMany({
    data: approverIds.map((approverMemberId) => ({
      organizationId: run.organizationId,
      requestId: request.id,
      stepId: step.id,
      stepOrder: order,
      approverMemberId,
      dueAt,
    })),
  });
  const eventId = await recordRequestEvent(run.db, run.organizationId, request.id, {
    type: 'STEP_ACTIVATED',
    actorMemberId: null,
    stepOrder: order,
    metadata: { approverMemberIds: approverIds },
  });
  const delegates = await delegatesOf(run.db, run.organizationId, approverIds, request.requestTypeId, run.now);
  await notifyRequestRecipients(
    run.db,
    run.organizationId,
    request.id,
    [...approverIds, ...delegates],
    {
      type: 'REQUEST_APPROVAL_ASSIGNED',
      severity: 'INFO',
      email: version.notifications.emailApprovers,
      causeId: eventId,
    },
    run.actorMemberId,
    run.now,
  );
  return { approverIds };
}

/**
 * Final approval: records the trusted effect declared by the pinned version (one per request and kind,
 * tied to the decision event) and emits `request.approved` for later modules. The caller has moved the
 * request to APPROVED.
 */
export async function onRequestApproved(
  run: WorkflowRun,
  request: RequestRef,
  version: LoadedVersion,
  data: NormalizedData,
  decisionEventId: string,
  hasFulfillment: boolean,
): Promise<void> {
  const effect = attendanceEffect(version.effects, data);
  if (effect !== null) {
    const created = await run.db.requestEffect.create({
      data: {
        organizationId: run.organizationId,
        requestId: request.id,
        kind: 'ATTENDANCE',
        mode: effect.mode,
        startsOn: fromDateOnly(effect.startsOn),
        endsOn: fromDateOnly(effect.endsOn),
        startsAtMinute: effect.startsAtMinute,
        endsAtMinute: effect.endsAtMinute,
        workflowVersionId: version.id,
        decisionEventId,
      },
      select: { id: true },
    });
    await recordRequestEvent(run.db, run.organizationId, request.id, {
      type: 'EFFECT_RECORDED',
      actorMemberId: null,
      metadata: { effectId: created.id },
    });
    await enqueueOutboxEvent(run.db, run.organizationId, {
      eventType: 'request.approved',
      aggregateType: 'request',
      aggregateId: request.id,
      payload: { requestId: request.id, effectId: created.id },
    });
  }
  await notifyRequestRecipients(
    run.db,
    run.organizationId,
    request.id,
    [request.requesterMemberId],
    {
      type: 'REQUEST_APPROVED',
      severity: 'INFO',
      email: version.notifications.emailRequester,
      causeId: decisionEventId,
    },
    run.actorMemberId,
    run.now,
  );
  if (hasFulfillment) {
    await notifyRequestRecipients(
      run.db,
      run.organizationId,
      request.id,
      await fulfillerMemberIds(run.db, run.organizationId),
      { type: 'REQUEST_FULFILLMENT_REQUIRED', severity: 'INFO', email: false, causeId: decisionEventId },
      run.actorMemberId,
      run.now,
    );
  }
}

/** Revokes a recorded effect (administrator cancellation of an approved request). */
export async function revokeEffects(run: WorkflowRun, requestId: string, causeEventId: string): Promise<void> {
  const effects = await run.db.requestEffect.findMany({
    where: { organizationId: run.organizationId, requestId, status: 'RECORDED' },
    select: { id: true },
  });
  for (const effect of effects) {
    const revoked = await run.db.requestEffect.updateMany({
      where: { organizationId: run.organizationId, id: effect.id, status: 'RECORDED' },
      data: { status: 'REVOKED', revokedAt: run.now, revokeEventId: causeEventId },
    });
    if (revoked.count === 0) continue;
    await recordRequestEvent(run.db, run.organizationId, requestId, {
      type: 'EFFECT_REVOKED',
      actorMemberId: run.actorMemberId,
      metadata: { effectId: effect.id },
    });
    await enqueueOutboxEvent(run.db, run.organizationId, {
      eventType: 'request.effect.revoked',
      aggregateType: 'request',
      aggregateId: requestId,
      payload: { requestId, effectId: effect.id },
    });
  }
}

/** Members holding `request.fulfill` (bounded audience for "fulfillment required"). */
async function fulfillerMemberIds(db: TenantDb, organizationId: string): Promise<string[]> {
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      userId: { not: null },
      roles: { some: { role: { permissions: { some: { permissionKey: 'request.fulfill' } } } } },
    },
    orderBy: { id: 'asc' },
    take: 50,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
