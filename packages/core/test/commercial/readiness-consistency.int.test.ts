import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { readinessCounters } from '../../src/modules/commercial/engine/readiness.js';
import type { ReadinessCounters } from '../../src/modules/commercial/engine/readiness.js';
import {
  TenderRequirementService,
  recomputeTenderReadiness,
} from '../../src/modules/commercial/tender-requirement.service.js';
import { TenderService } from '../../src/modules/commercial/tender.service.js';
import { InvalidTransitionError, VersionConflictError } from '../../src/platform/errors.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Readiness is stored on the tender as counters (ADR-0026) and read by the detail, the list, the
 * list's readiness filter (which the dashboard's "not ready" metric counts with) and the reports.
 * After every kind of requirement change, including failed and concurrent ones, the stored counters
 * must equal the counters recomputed from the canonical requirement rows, and every reader must
 * agree. A corrupted projection is rebuilt deterministically from the rows.
 */
const RUN = randomUUID().slice(0, 8);
const COUNTERS = {
  requirementsTotal: true,
  mandatoryApplicable: true,
  mandatoryApproved: true,
  optionalApplicable: true,
  optionalApproved: true,
  blockedRequirements: true,
  unassignedRequirements: true,
} as const satisfies Record<keyof ReadinessCounters, true>;
const BUCKET = { READY: 'ready', NOT_READY: 'not_ready', NO_MANDATORY: 'no_mandatory' } as const;

let s: SeededDatabase;
let tenders: TenderService;
let requirements: TenderRequirementService;
let gm: ActionContext;
let ownerMemberId: string;
let tender: { id: string; title: string };

async function stored(tenderId: string): Promise<ReadinessCounters> {
  return s.prisma.tender.findUniqueOrThrow({ where: { id: tenderId }, select: COUNTERS });
}

async function canonical(tenderId: string): Promise<ReadinessCounters> {
  const rows = await s.prisma.tenderRequirement.findMany({
    where: { tenderId },
    select: { status: true, mandatory: true, ownerMemberId: true, dueDate: true },
  });
  return readinessCounters(rows.map((row) => ({ ...row, dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null })));
}

/** Canonical rows = stored projection = detail = list row = the one matching readiness bucket. */
async function expectConsistent(expected: { state: keyof typeof BUCKET; percent: number | null }): Promise<void> {
  const counters = await canonical(tender.id);
  expect(await stored(tender.id)).toEqual(counters);

  const detail = (await s.as(gm, () => tenders.get(gm, tender.id))).readiness;
  expect(detail).toMatchObject({
    ...expected,
    mandatoryApplicable: counters.mandatoryApplicable,
    mandatoryApproved: counters.mandatoryApproved,
    mandatoryMissing: counters.mandatoryApplicable - counters.mandatoryApproved,
    optionalApplicable: counters.optionalApplicable,
    optionalApproved: counters.optionalApproved,
    total: counters.requirementsTotal,
    blocked: counters.blockedRequirements,
    unassigned: counters.unassignedRequirements,
  });
  const page = await s.as(gm, () => tenders.list(gm, { q: tender.title, limit: 10 }));
  const row = page.items.find((item) => item.id === tender.id);
  expect(row?.readiness).toEqual({ ...detail, inProgress: null, overdue: null });

  for (const [state, readiness] of Object.entries(BUCKET)) {
    const bucket = await s.as(gm, () => tenders.list(gm, { q: tender.title, readiness, limit: 10 }));
    expect(
      bucket.items.some((item) => item.id === tender.id),
      `${tender.title} in the ${readiness} bucket`,
    ).toBe(state === expected.state);
  }
}

async function requirement(id: string): Promise<{ id: string; version: number }> {
  return s.prisma.tenderRequirement.findUniqueOrThrow({ where: { id }, select: { id: true, version: true } });
}

async function move(id: string, status: 'READY_FOR_REVIEW' | 'APPROVED' | 'NOT_APPLICABLE' | 'NOT_STARTED') {
  const current = await requirement(id);
  return s.as(gm, () => requirements.changeStatus(gm, tender.id, id, { version: current.version, status }));
}

async function add(title: string, mandatory: boolean, owner: string | null): Promise<string> {
  const created = await s.as(gm, () =>
    requirements.create(gm, tender.id, {
      category: 'ADMINISTRATIVE',
      title: `${title} ${RUN}`,
      mandatory,
      ...(owner === null ? {} : { ownerMemberId: owner }),
    }),
  );
  return created.id;
}

beforeAll(async () => {
  s = await startSeededDatabase();
  tenders = new TenderService(s.tenantDb, s.tenant);
  requirements = new TenderRequirementService(s.tenantDb, s.tenant);
  gm = await s.actionFor('EMP-00002');
  ownerMemberId = (await s.employee('EMP-00004')).memberId;
  const created = await s.as(gm, () =>
    tenders.create(gm, {
      title: `Readiness projection ${RUN}`,
      tenderType: 'RFQ',
      ownerMemberId: gm.principal.memberId,
      status: 'NEW',
      submissionDeadlineAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      submissionDeadlineTimeZone: 'Africa/Cairo',
    }),
  );
  tender = { id: created.id, title: created.title };
}, 300_000);

afterAll(async () => {
  await s.stop();
});

describe('readiness projection', () => {
  it('stays equal to the requirement rows through every change, failure and concurrent update', async () => {
    await expectConsistent({ state: 'NO_MANDATORY', percent: null });

    // Create: two mandatory (one unassigned) and one optional.
    const first = await add('Registration', true, ownerMemberId);
    const second = await add('Bank letter', true, null);
    const optional = await add('Brochure', false, ownerMemberId);
    await expectConsistent({ state: 'NOT_READY', percent: 0 });

    // Status change.
    await move(first, 'READY_FOR_REVIEW');
    await expectConsistent({ state: 'NOT_READY', percent: 0 });
    await move(first, 'APPROVED');
    await expectConsistent({ state: 'NOT_READY', percent: 50 });
    await move(optional, 'READY_FOR_REVIEW');
    await move(optional, 'APPROVED');
    await expectConsistent({ state: 'NOT_READY', percent: 50 });

    // Mandatory toggle, both ways.
    const toggle = async (mandatory: boolean) => {
      const current = await requirement(second);
      await s.as(gm, () => requirements.update(gm, tender.id, second, { version: current.version, mandatory }));
    };
    await toggle(false);
    await expectConsistent({ state: 'READY', percent: 100 });
    await toggle(true);
    await expectConsistent({ state: 'NOT_READY', percent: 50 });

    // NOT_APPLICABLE leaves every denominator; reopening brings it back.
    await move(second, 'NOT_APPLICABLE');
    await expectConsistent({ state: 'READY', percent: 100 });
    await move(second, 'NOT_STARTED');
    await expectConsistent({ state: 'NOT_READY', percent: 50 });

    // Deletion.
    await s.as(gm, async () => {
      const current = await requirement(second);
      await requirements.delete(gm, tender.id, second, current.version);
    });
    await expectConsistent({ state: 'READY', percent: 100 });

    // Rejected changes leave the projection untouched: a stale version and an invalid transition.
    const before = await stored(tender.id);
    const stale = (await requirement(first)).version - 1;
    await expect(
      s.as(gm, () => requirements.changeStatus(gm, tender.id, first, { version: stale, status: 'NOT_STARTED' })),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const extra = await add('Site visit', true, ownerMemberId);
    const afterAdd = await stored(tender.id);
    await expect(move(extra, 'APPROVED')).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await stored(tender.id)).toEqual(afterAdd);
    expect(afterAdd.mandatoryApplicable).toBe(before.mandatoryApplicable + 1);
    await expectConsistent({ state: 'NOT_READY', percent: 50 });

    // A transaction that rewrote rows and the projection, then failed, rolls both back.
    await expect(
      s.as(gm, () =>
        s.tenantDb.$transaction(async (tx) => {
          await tx.tenderRequirement.updateMany({
            where: { organizationId: s.demoId, tenderId: tender.id, id: extra },
            data: { status: 'APPROVED' },
          });
          await recomputeTenderReadiness(tx, s.demoId, tender.id);
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    expect(await stored(tender.id)).toEqual(afterAdd);
    await expectConsistent({ state: 'NOT_READY', percent: 50 });

    // Concurrent: several requirements approved in parallel, and two racing writes on one requirement.
    const parallel = await Promise.all(
      ['Tax card', 'Insurance', 'Profile', 'References'].map((t) => add(t, true, null)),
    );
    await expectConsistent({ state: 'NOT_READY', percent: 16 });
    const ready = await Promise.allSettled([extra, ...parallel].map((id) => move(id, 'READY_FOR_REVIEW')));
    expect(ready.map((result) => result.status)).toEqual(Array.from({ length: 5 }, () => 'fulfilled'));
    const approvals = await Promise.allSettled([extra, ...parallel].map((id) => move(id, 'APPROVED')));
    expect(approvals.map((result) => result.status)).toEqual(Array.from({ length: 5 }, () => 'fulfilled'));
    await expectConsistent({ state: 'READY', percent: 100 });

    const racing = await requirement(parallel[0] ?? '');
    const race = await Promise.allSettled(
      (['NOT_STARTED', 'READY_FOR_REVIEW'] as const).map((status) =>
        s.as(gm, () => requirements.changeStatus(gm, tender.id, racing.id, { version: racing.version, status })),
      ),
    );
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expectConsistent({ state: 'NOT_READY', percent: 83 });
  });

  it('rebuilds a corrupted projection deterministically from the requirement rows', async () => {
    const truth = await canonical(tender.id);
    await s.prisma.tender.update({
      where: { id: tender.id },
      data: { requirementsTotal: 42, mandatoryApplicable: 40, mandatoryApproved: 40, unassignedRequirements: 7 },
    });
    expect(await stored(tender.id)).not.toEqual(truth);
    expect((await s.as(gm, () => tenders.get(gm, tender.id))).readiness.state).toBe('READY');

    for (let run = 0; run < 2; run += 1) {
      await s.as(gm, () => s.tenantDb.$transaction((tx) => recomputeTenderReadiness(tx, s.demoId, tender.id)));
      expect(await stored(tender.id)).toEqual(truth);
    }
    await expectConsistent({ state: 'NOT_READY', percent: 83 });
  });
});
