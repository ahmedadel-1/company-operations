import { UnrecoverableError } from 'bullmq';

import {
  AttendanceEffectConsumer,
  AttendanceJobRejectedError,
  organizationsWithOverdueApprovals,
  RequestSlaSweep,
} from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  EffectSignal,
  PrismaClient,
  TenantScopedClient,
} from '@company-ops/core';
import { outboxJobDataSchema, requestEffectPayloadSchema } from '@company-ops/validation';

export const REQUEST_SLA_SWEEP_JOB = 'request.sla.sweep';
export const REQUEST_EFFECT_RECORDED_JOB = 'request.effect.recorded';
export const REQUEST_EFFECT_REVOKED_JOB = 'request.effect.revoked';

const EFFECT_EVENTS: Readonly<Record<string, { readonly eventType: string; readonly signal: EffectSignal }>> = {
  [REQUEST_EFFECT_RECORDED_JOB]: { eventType: 'request.approved', signal: 'RECORDED' },
  [REQUEST_EFFECT_REVOKED_JOB]: { eventType: 'request.effect.revoked', signal: 'REVOKED' },
};

export interface RequestJobDeps {
  readonly prisma: PrismaClient;
  readonly db: TenantScopedClient;
  readonly tenant: AsyncLocalTenantContext;
  readonly onOrganizationError: (organizationId: string, error: unknown) => void;
  readonly invalidate?: DashboardInvalidator;
}

export type RequestJobResult =
  | {
      readonly kind: 'sweep';
      readonly organizations: number;
      readonly reminded: number;
      readonly failedOrganizations: number;
    }
  | {
      readonly kind: 'effect';
      readonly effectId: string;
      readonly outcome: 'APPLIED' | 'REVERTED' | 'SKIPPED';
      readonly dates: number;
    };

const systemContext = (organizationId: string) => ({ organizationId, memberId: null, userId: null });

/**
 * The `requests` queue:
 * - `request.sla.sweep` (scheduled): one approval reminder per overdue assignment, per organization in
 *   its own system tenant context; a failing organization does not stop the others.
 * - `request.effect.recorded` / `request.effect.revoked` (outbox): the attendance consumer applies or
 *   reverts the trusted effect inside the event's organization (ADR-0022). Every system event it writes
 *   has a deterministic idempotency key, so re-delivery is harmless; a forged or mismatched job is
 *   rejected without retries.
 */
export async function handleRequestJob(
  jobName: string,
  data: unknown,
  deps: RequestJobDeps,
  now: Date,
): Promise<RequestJobResult> {
  if (jobName === REQUEST_SLA_SWEEP_JOB) {
    const organizations = await organizationsWithOverdueApprovals(deps.prisma, now);
    const sweep = new RequestSlaSweep(deps.db, deps.tenant);
    let reminded = 0;
    let failedOrganizations = 0;
    for (const organizationId of organizations) {
      try {
        const result = await deps.tenant.run(systemContext(organizationId), () => sweep.run(now));
        reminded += result.reminded;
      } catch (error) {
        failedOrganizations += 1;
        deps.onOrganizationError(organizationId, error);
      }
    }
    return { kind: 'sweep', organizations: organizations.length, reminded, failedOrganizations };
  }
  const route = EFFECT_EVENTS[jobName];
  if (route === undefined) {
    throw new UnrecoverableError(`Unknown job "${jobName}" on the requests queue.`);
  }
  const job = outboxJobDataSchema.safeParse(data);
  if (!job.success || job.data.eventType !== route.eventType) {
    throw new UnrecoverableError('Invalid request effect job data.');
  }
  const payload = requestEffectPayloadSchema.safeParse(job.data.payload);
  if (!payload.success) {
    throw new UnrecoverableError('Invalid request effect payload.');
  }
  const { organizationId } = job.data;
  const consumer = new AttendanceEffectConsumer(deps.db, deps.tenant);
  try {
    const result = await deps.tenant.run(systemContext(organizationId), () =>
      consumer.handle(route.signal, payload.data.requestId, payload.data.effectId, now),
    );
    if (result.outcome !== 'SKIPPED') {
      await deps.invalidate?.(organizationId, ['attendance', 'requests']);
    }
    return { kind: 'effect', ...result };
  } catch (error) {
    if (error instanceof AttendanceJobRejectedError) throw new UnrecoverableError(error.message);
    throw error;
  }
}
