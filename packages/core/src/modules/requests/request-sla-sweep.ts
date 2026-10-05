import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { delegatesOf, notifyRequestRecipients } from './request-notify.js';

export const REQUEST_SLA_SWEEP_BATCH_SIZE = 200;

export interface RequestSlaSweepResult {
  readonly overdue: number;
  readonly reminded: number;
}

/**
 * Approval reminders (`request.sla.sweep`, `requests` queue) for the organization of the active system
 * tenant context. Each overdue pending assignment is reminded once: `reminded_at` is set with a
 * conditional update (still PENDING and not reminded), so retries and overlapping runs never notify
 * twice. Reminders go to the approver and their active delegates; nothing is decided automatically.
 */
export class RequestSlaSweep {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async run(now: Date): Promise<RequestSlaSweepResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    let overdue = 0;
    let reminded = 0;
    let after: string | null = null;
    for (;;) {
      const rows: { id: string; requestId: string; approverMemberId: string; request: { requestTypeId: string } }[] =
        await this.db.requestApproval.findMany({
          where: {
            organizationId,
            status: 'PENDING',
            remindedAt: null,
            dueAt: { lte: now },
            request: { is: { status: 'PENDING_APPROVAL' } },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: REQUEST_SLA_SWEEP_BATCH_SIZE,
          select: { id: true, requestId: true, approverMemberId: true, request: { select: { requestTypeId: true } } },
        });
      for (const row of rows) {
        overdue += 1;
        const sent = await this.db.$transaction(async (tx) => {
          const marked = await tx.requestApproval.updateMany({
            where: { organizationId, id: row.id, status: 'PENDING', remindedAt: null },
            data: { remindedAt: now },
          });
          if (marked.count === 0) {
            return false;
          }
          const delegates = await delegatesOf(
            tx,
            organizationId,
            [row.approverMemberId],
            row.request.requestTypeId,
            now,
          );
          await notifyRequestRecipients(
            tx,
            organizationId,
            row.requestId,
            [row.approverMemberId, ...delegates],
            { type: 'REQUEST_APPROVAL_OVERDUE', severity: 'WARNING', email: true, causeId: row.id },
            null,
            now,
          );
          return true;
        });
        reminded += sent ? 1 : 0;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < REQUEST_SLA_SWEEP_BATCH_SIZE) {
        break;
      }
      after = last.id;
    }
    return { overdue, reminded };
  }
}
