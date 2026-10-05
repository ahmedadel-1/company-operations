import type { RequestEffectMode, RequestEffectStatus } from '@company-ops/db';

import { toDateOnly } from '../projects/business-date.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';

export interface RequestEffectRecord {
  readonly id: string;
  readonly requestId: string;
  readonly mode: RequestEffectMode;
  readonly status: RequestEffectStatus;
  readonly startsOn: string;
  readonly endsOn: string;
}

/**
 * The trusted effect an approval produced (ADR-0021 Phase 7 boundary). Consumers read it by id inside
 * the event's organization; the outbox payload only carries identifiers, never dates or modes, so a
 * consumer can never act on data the request did not record.
 */
export async function loadRequestEffect(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  effectId: string,
): Promise<RequestEffectRecord | null> {
  const row = await db.requestEffect.findFirst({
    where: { organizationId, id: effectId, requestId },
    select: { id: true, requestId: true, mode: true, status: true, startsOn: true, endsOn: true },
  });
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    requestId: row.requestId,
    mode: row.mode,
    status: row.status,
    startsOn: toDateOnly(row.startsOn) ?? '',
    endsOn: toDateOnly(row.endsOn) ?? '',
  };
}
