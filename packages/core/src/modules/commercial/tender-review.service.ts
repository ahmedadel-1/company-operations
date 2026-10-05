import type { TenderReviewGateType, TenderReviewStatus } from '@company-ops/db';
import type { RequestTenderReviewRequest, TenderReviewDecisionRequest } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockCommercialAggregate } from '../../platform/db/sql/locks.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import { canAccessResource } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { stepOutcome } from '../requests/index.js';
import { assertCan, loadTenderForAccess, loadVisibleTender } from './commercial-access.js';
import type { LoadedTender } from './commercial-access.js';
import {
  announceCommercialChange,
  appendTenderEvent,
  isoOrNull,
  memberRefSelect,
  notifyMembers,
  toPersonRef,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { readinessState } from './engine/readiness.js';
import { tenderKey } from './engine/tender-state.js';
import { supersedeOpenReviews } from './tender.service.js';

export interface TenderReviewGateView {
  readonly id: string;
  readonly round: number;
  readonly gate: TenderReviewGateType;
  readonly mode: 'ANY_ONE' | 'ALL';
  readonly status: 'WAITING' | 'OPEN' | 'APPROVED' | 'CHANGES_REQUIRED' | 'REJECTED' | 'SUPERSEDED';
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly reviews: {
    readonly id: string;
    readonly reviewer: PersonRef;
    readonly status: TenderReviewStatus;
    readonly comment: string | null;
    readonly decidedAt: string | null;
    readonly canDecide: boolean;
  }[];
}

/** Reviewers of the FINAL gate approve the tender; the other gates need the review permission. */
function gatePermission(gate: TenderReviewGateType): 'tender.approve' | 'tender.review' {
  return gate === 'FINAL' ? 'tender.approve' : 'tender.review';
}

/**
 * Internal tender review (spec §23, ADR-0026). A review request opens one round of gates: the
 * TECHNICAL / COMMERCIAL / LEGAL gates open together and the FINAL gate (always present) opens when
 * they are all approved. Each gate completes with the Phase 6 step semantics (`stepOutcome`: ANY_ONE
 * or ALL, any negative decision closes it) without creating requests. FINAL approval moves the tender
 * to READY_FOR_SUBMISSION after re-checking readiness; CHANGES_REQUIRED or REJECTED returns it to
 * PREPARING and supersedes the rest of the round.
 */
export class TenderReviewService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, tenderId: string): Promise<TenderReviewGateView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    if (tender.level !== 'FULL') return [];
    const gates = await this.db.tenderReviewGate.findMany({
      where: { organizationId, tenderId },
      orderBy: [{ round: 'desc' }, { gate: 'asc' }],
      take: 200,
      select: {
        id: true,
        round: true,
        gate: true,
        mode: true,
        status: true,
        openedAt: true,
        closedAt: true,
        reviews: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            comment: true,
            decidedAt: true,
            reviewerMemberId: true,
            reviewer: { select: memberRefSelect },
          },
        },
      },
    });
    const me = action.principal.memberId;
    return gates.map((gate) => ({
      id: gate.id,
      round: gate.round,
      gate: gate.gate,
      mode: gate.mode,
      status: gate.status,
      openedAt: isoOrNull(gate.openedAt),
      closedAt: isoOrNull(gate.closedAt),
      reviews: gate.reviews.map((review) => ({
        id: review.id,
        reviewer: toPersonRef(review.reviewer),
        status: review.status,
        comment: review.comment,
        decidedAt: isoOrNull(review.decidedAt),
        canDecide:
          review.reviewerMemberId === me &&
          review.status === 'PENDING' &&
          gate.status === 'OPEN' &&
          tender.row.status === 'INTERNAL_REVIEW' &&
          tender.can(gatePermission(gate.gate)),
      })),
    }));
  }

  async request(
    action: ActionContext,
    tenderId: string,
    input: RequestTenderReviewRequest,
  ): Promise<TenderReviewGateView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const gateTypes = input.gates.map((gate) => gate.gate);
    if (new Set(gateTypes).size !== gateTypes.length)
      throw new InvalidInputError('gates', 'Each gate can appear once.');
    if (!gateTypes.includes('FINAL')) throw new InvalidInputError('gates', 'The final management gate is required.');
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.edit');
      await lockCommercialAggregate(tx, organizationId, 'tender', tenderId);
      if (tender.row.status !== 'PREPARING') {
        throw new InvalidTransitionError(
          `A review is requested while preparing the bid, not while ${tender.row.status}.`,
        );
      }
      const counters = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: { mandatoryApplicable: true, mandatoryApproved: true, reviewRound: true },
      });
      if (readinessState(counters) === 'NOT_READY') {
        throw new ConflictError('Every applicable mandatory requirement must be approved before review.');
      }
      await this.assertReviewers(tx, organizationId, tender, input.gates);
      const round = counters.reviewRound + 1;
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, status: 'PREPARING', version: input.version },
        data: { status: 'INTERNAL_REVIEW', reviewRound: round, version: { increment: 1 } },
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      const now = this.clock();
      const finalOnly = input.gates.length === 1;
      const opened: string[] = [];
      for (const gate of input.gates) {
        const open = gate.gate !== 'FINAL' || finalOnly;
        const created = await tx.tenderReviewGate.create({
          data: {
            organizationId,
            tenderId,
            round,
            gate: gate.gate,
            mode: gate.mode,
            status: open ? 'OPEN' : 'WAITING',
            openedAt: open ? now : null,
          },
          select: { id: true },
        });
        await tx.tenderReview.createMany({
          data: [...new Set(gate.reviewerMemberIds)].map((reviewerMemberId) => ({
            organizationId,
            tenderId,
            gateId: created.id,
            reviewerMemberId,
          })),
        });
        if (open) opened.push(created.id);
      }
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.review_requested', action.principal.memberId, {
        round,
        gates: gateTypes.join(','),
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.review_requested',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { round, gates: gateTypes },
        context: action.request,
      });
      await this.notifyGateReviewers(tx, organizationId, tender, opened, action.principal.memberId);
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.list(action, tenderId);
  }

  async decide(
    action: ActionContext,
    tenderId: string,
    reviewId: string,
    input: TenderReviewDecisionRequest,
  ): Promise<TenderReviewGateView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (input.decision !== 'APPROVED' && input.comment === undefined) {
      throw new InvalidInputError('comment', 'Explain the decision.');
    }
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      await lockCommercialAggregate(tx, organizationId, 'tender', tenderId);
      const review = await tx.tenderReview.findFirst({
        where: { organizationId, tenderId, id: reviewId },
        select: {
          status: true,
          reviewerMemberId: true,
          gate: { select: { id: true, gate: true, mode: true, status: true, round: true } },
        },
      });
      const me = action.principal.memberId;
      if (review?.reviewerMemberId !== me) throw new NotFoundError('Review');
      if (review.status === input.decision) return;
      if (review.status !== 'PENDING') throw new ConflictError('This review was already decided.');
      if (review.gate.status !== 'OPEN' || tender.row.status !== 'INTERNAL_REVIEW') {
        throw new InvalidTransitionError('This review gate is not open.');
      }
      if (!tender.can(gatePermission(review.gate.gate))) throw new ForbiddenError();
      const now = this.clock();
      const decided = await tx.tenderReview.updateMany({
        where: { organizationId, id: reviewId, status: 'PENDING' },
        data: {
          status: input.decision,
          comment: input.comment ?? null,
          decidedAt: now,
          tenderVersion: tender.row.version,
        },
      });
      if (decided.count === 0) throw new ConflictError('This review was already decided.');
      const reviews = await tx.tenderReview.findMany({
        where: { organizationId, gateId: review.gate.id },
        select: { id: true, status: true },
      });
      const outcome = stepOutcome(
        review.gate.mode,
        reviews.map((row) => ({ id: row.id, status: row.status === 'CHANGES_REQUIRED' ? 'REJECTED' : row.status })),
      );
      const key = tenderKey(tender.row.year, tender.row.number);
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.review_decided', me, {
        round: review.gate.round,
        gate: review.gate.gate,
        decision: input.decision,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.review_decided',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { reviewId, gate: review.gate.gate, round: review.gate.round, decision: input.decision },
        context: action.request,
      });
      if (outcome.kind === 'OPEN') return;
      if (outcome.supersede.length > 0) {
        await tx.tenderReview.updateMany({
          where: { organizationId, id: { in: [...outcome.supersede] }, status: 'PENDING' },
          data: { status: 'SUPERSEDED' },
        });
      }
      if (outcome.kind === 'REJECTED') {
        await tx.tenderReviewGate.updateMany({
          where: { organizationId, id: review.gate.id },
          data: { status: input.decision === 'REJECTED' ? 'REJECTED' : 'CHANGES_REQUIRED', closedAt: now },
        });
        await supersedeOpenReviews(tx, organizationId, tenderId, now);
        await this.moveTender(tx, organizationId, tender, 'PREPARING');
        await appendTenderEvent(tx, organizationId, tenderId, 'tender.review_completed', me, {
          round: review.gate.round,
          gate: review.gate.gate,
          outcome: input.decision,
        });
        await this.notifyTenderPeople(tx, organizationId, tender, {
          type: input.decision === 'REJECTED' ? 'TENDER_REVIEW_REJECTED' : 'TENDER_REVIEW_CHANGES_REQUIRED',
          severity: 'WARNING',
          key,
          dedupeKey: `TENDER_REVIEW_RETURNED:${review.gate.id}`,
          actorMemberId: me,
        });
        await announceCommercialChange(tx, organizationId, 'tender', tenderId);
        return;
      }
      await tx.tenderReviewGate.updateMany({
        where: { organizationId, id: review.gate.id },
        data: { status: 'APPROVED', closedAt: now },
      });
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.review_completed', me, {
        round: review.gate.round,
        gate: review.gate.gate,
        outcome: 'APPROVED',
      });
      const roundGates = await tx.tenderReviewGate.findMany({
        where: { organizationId, tenderId, round: review.gate.round },
        select: { id: true, gate: true, status: true },
      });
      const othersApproved = roundGates
        .filter((gate) => gate.gate !== 'FINAL')
        .every((gate) => gate.status === 'APPROVED');
      if (review.gate.gate !== 'FINAL') {
        const final = roundGates.find((gate) => gate.gate === 'FINAL');
        if (othersApproved && final?.status === 'WAITING') {
          await tx.tenderReviewGate.updateMany({
            where: { organizationId, id: final.id, status: 'WAITING' },
            data: { status: 'OPEN', openedAt: now },
          });
          await this.notifyGateReviewers(tx, organizationId, tender, [final.id], me);
        }
        await announceCommercialChange(tx, organizationId, 'tender', tenderId);
        return;
      }
      const counters = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: { mandatoryApplicable: true, mandatoryApproved: true },
      });
      if (!othersApproved || readinessState(counters) === 'NOT_READY') {
        throw new ConflictError('The tender no longer meets the submission prerequisites.');
      }
      await this.moveTender(tx, organizationId, tender, 'READY_FOR_SUBMISSION');
      await this.notifyTenderPeople(tx, organizationId, tender, {
        type: 'TENDER_READY_FOR_SUBMISSION',
        severity: 'INFO',
        key,
        dedupeKey: `TENDER_READY_FOR_SUBMISSION:${review.gate.id}`,
        actorMemberId: me,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.list(action, tenderId);
  }

  // ---- internals ----

  private async moveTender(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    to: 'PREPARING' | 'READY_FOR_SUBMISSION',
  ): Promise<void> {
    const result = await tx.tender.updateMany({
      where: { organizationId, id: tender.row.id, status: 'INTERNAL_REVIEW' },
      data: { status: to, version: { increment: 1 } },
    });
    if (result.count === 0) throw new VersionConflictError('Tender');
    await appendTenderEvent(tx, organizationId, tender.row.id, 'tender.status_changed', null, {
      from: 'INTERNAL_REVIEW',
      to,
    });
  }

  /** Reviewers must be active members holding the gate's permission on this tender. */
  private async assertReviewers(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    gates: RequestTenderReviewRequest['gates'],
  ): Promise<void> {
    const ids = [...new Set(gates.flatMap((gate) => gate.reviewerMemberIds))];
    const access = await loadMemberAccess(tx, organizationId, ids);
    for (const gate of gates) {
      for (const memberId of gate.reviewerMemberIds) {
        const member = access.get(memberId);
        if (
          member === undefined ||
          member.employmentStatus === 'TERMINATED' ||
          !canAccessResource(member.principal, gatePermission(gate.gate), tender.facts)
        ) {
          throw new InvalidInputError('gates', `A ${gate.gate} reviewer cannot review this tender.`);
        }
      }
    }
  }

  private async notifyGateReviewers(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    gateIds: readonly string[],
    actorMemberId: string,
  ): Promise<void> {
    if (gateIds.length === 0) return;
    const reviews = await tx.tenderReview.findMany({
      where: { organizationId, gateId: { in: [...gateIds] }, status: 'PENDING' },
      select: { reviewerMemberId: true, gate: { select: { id: true, gate: true } } },
    });
    for (const review of reviews) {
      const type = review.gate.gate === 'FINAL' ? 'TENDER_FINAL_APPROVAL_REQUESTED' : 'TENDER_REVIEW_REQUESTED';
      await notifyMembers(
        tx,
        organizationId,
        [review.reviewerMemberId],
        {
          type,
          severity: 'INFO',
          entityType: 'tender',
          entityId: tender.row.id,
          params: {
            tenderKey: tenderKey(tender.row.year, tender.row.number),
            tenderTitle: tender.row.title,
            gate: review.gate.gate,
          },
          dedupeKey: `${type}:${review.gate.id}`,
          email: true,
        },
        (principal: Principal) => canAccessResource(principal, gatePermission(review.gate.gate), tender.facts),
        actorMemberId,
      );
    }
  }

  private async notifyTenderPeople(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    notification: { type: string; severity: 'INFO' | 'WARNING'; key: string; dedupeKey: string; actorMemberId: string },
  ): Promise<void> {
    await notifyMembers(
      tx,
      organizationId,
      [tender.row.ownerMemberId, tender.row.technicalLeadMemberId, tender.row.commercialLeadMemberId],
      {
        type: notification.type,
        severity: notification.severity,
        entityType: 'tender',
        entityId: tender.row.id,
        params: { tenderKey: notification.key, tenderTitle: tender.row.title },
        dedupeKey: notification.dedupeKey,
      },
      async (principal) => (await loadTenderForAccess(tx, principal, organizationId, tender.row.id)) !== null,
      notification.actorMemberId,
    );
  }
}
