import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  CommercialDocumentService,
  ContractService,
  GuaranteeService,
  TenderRequirementService,
  TenderReviewService,
  TenderService,
} from '@company-ops/core';
import type {
  BidDecisionView,
  CommercialDocumentView,
  CommercialEventView,
  ContractView,
  GuaranteeView,
  TenderAddendumView,
  TenderClarificationView,
  TenderRequirementView,
  TenderReviewGateView,
  TenderSubmissionView,
  TenderSummaryView,
  TenderView,
  TenderWorkView,
} from '@company-ops/core';
import {
  bidDecisionListResponseSchema,
  bidDecisionRequestSchema,
  clarificationParamsSchema,
  commercialDocumentListResponseSchema,
  commercialDocumentResponseSchema,
  commercialEventPageResponseSchema,
  contractResponseSchema,
  correctSubmissionSchema,
  createAddendumSchema,
  createClarificationSchema,
  createCommercialDocumentSchema,
  createContractFromTenderSchema,
  createGuaranteeSchema,
  createRequirementLinkSchema,
  createRequirementSchema,
  createTenderSchema,
  eventPageQuerySchema,
  guaranteeListResponseSchema,
  guaranteeResponseSchema,
  recordAwardSchema,
  recordLossSchema,
  requestTenderReviewSchema,
  requirementLinkParamsSchema,
  requirementListQuerySchema,
  requirementStatusRequestSchema,
  submitTenderSchema,
  tenderAddendumListResponseSchema,
  tenderClarificationListResponseSchema,
  tenderClarificationResponseSchema,
  tenderIdParamsSchema,
  tenderListQuerySchema,
  tenderPageResponseSchema,
  tenderRequirementListResponseSchema,
  tenderRequirementParamsSchema,
  tenderRequirementResponseSchema,
  tenderResponseSchema,
  tenderReviewDecisionRequestSchema,
  tenderReviewGateListResponseSchema,
  tenderReviewParamsSchema,
  tenderSubmissionListResponseSchema,
  tenderTransitionSchema,
  tenderWorkQuerySchema,
  tenderWorkResponseSchema,
  updateClarificationSchema,
  updateRequirementSchema,
  updateTenderSchema,
  versionQuerySchema,
} from '@company-ops/validation';
import type { SchemaOutput as In } from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { COMMERCIAL_IDEMPOTENCY_HEADER, requiredIdempotencyKey, toPage } from './commercial-http.js';
import type { PageBody } from './commercial-http.js';

type IdParams = In<typeof tenderIdParamsSchema>;
type RequirementParams = In<typeof tenderRequirementParamsSchema>;

/**
 * Tenders (Phase 10, spec §12-§25): lifecycle, bid/no-bid, requirements and readiness, review gates,
 * submission, award/loss, addenda, clarifications, documents, guarantees and the timeline. Read routes
 * carry no route permission because requirement owners and reviewers see the tenders they work on
 * (INVOLVED access); the services resolve FULL or INVOLVED access per tender and answer 404 otherwise.
 */
@ApiTags('tenders')
@Controller({ path: 'tenders', version: '1' })
export class TendersController {
  constructor(
    @Inject(TenderService) private readonly tenders: TenderService,
    @Inject(TenderRequirementService) private readonly requirements: TenderRequirementService,
    @Inject(TenderReviewService) private readonly reviews: TenderReviewService,
    @Inject(CommercialDocumentService) private readonly documents: CommercialDocumentService,
    @Inject(GuaranteeService) private readonly guarantees: GuaranteeService,
    @Inject(ContractService) private readonly contracts: ContractService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(tenderPageResponseSchema)
  async list(
    @Query({ schema: tenderListQuerySchema }) query: In<typeof tenderListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<TenderSummaryView>> {
    return toPage(await this.tenders.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('tender.create')
  @ApiResult(tenderResponseSchema, 201)
  async create(
    @Body({ schema: createTenderSchema }) body: In<typeof createTenderSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.create(await this.actions.create(request), body) };
  }

  /** The caller's own requirements, reviews and owned tenders ("My Tender Work"). */
  @Get('my-work')
  @ApiResult(tenderWorkResponseSchema)
  async myWork(
    @Query({ schema: tenderWorkQuerySchema }) query: In<typeof tenderWorkQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderWorkView }> {
    return { data: await this.requirements.work(await this.actions.create(request), query) };
  }

  @Get(':id')
  @ApiResult(tenderResponseSchema)
  async get(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('tender.edit')
  @ApiResult(tenderResponseSchema)
  async update(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: updateTenderSchema }) body: In<typeof updateTenderSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.update(await this.actions.create(request), params.id, body) };
  }

  /** Drafts only; anything later is cancelled or archived instead (history is kept). */
  @Delete(':id')
  @RequirePermission('tender.delete_draft')
  @PrincipalRateLimit('sensitive')
  @ApiNoContent()
  async delete(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Query({ schema: versionQuerySchema }) query: In<typeof versionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.tenders.delete(await this.actions.create(request), params.id, query.version);
  }

  @Post(':id/transition')
  @RequirePermission('tender.edit')
  @ApiResult(tenderResponseSchema)
  async transition(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: tenderTransitionSchema }) body: In<typeof tenderTransitionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.transition(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/bid-decision')
  @RequirePermission('tender.approve')
  @ApiResult(tenderResponseSchema)
  async decideBid(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: bidDecisionRequestSchema }) body: In<typeof bidDecisionRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.decideBid(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/bid-decisions')
  @ApiResult(bidDecisionListResponseSchema)
  async listBidDecisions(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: BidDecisionView[] }> {
    return { data: await this.tenders.listBidDecisions(await this.actions.create(request), params.id) };
  }

  // ---- Requirements ----

  @Get(':id/requirements')
  @ApiResult(tenderRequirementListResponseSchema)
  async listRequirements(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Query({ schema: requirementListQuerySchema }) query: In<typeof requirementListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView[] }> {
    return { data: await this.requirements.list(await this.actions.create(request), params.id, query) };
  }

  @Post(':id/requirements')
  @RequirePermission('tender.manage_requirements')
  @ApiResult(tenderRequirementResponseSchema, 201)
  async createRequirement(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createRequirementSchema }) body: In<typeof createRequirementSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return { data: await this.requirements.create(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/requirements/:requirementId')
  @ApiResult(tenderRequirementResponseSchema)
  async getRequirement(
    @Param({ schema: tenderRequirementParamsSchema }) params: RequirementParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return { data: await this.requirements.get(await this.actions.create(request), params.id, params.requirementId) };
  }

  /** Managers edit everything; the requirement owner edits the response notes. */
  @Patch(':id/requirements/:requirementId')
  @ApiResult(tenderRequirementResponseSchema)
  async updateRequirement(
    @Param({ schema: tenderRequirementParamsSchema }) params: RequirementParams,
    @Body({ schema: updateRequirementSchema }) body: In<typeof updateRequirementSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return {
      data: await this.requirements.update(await this.actions.create(request), params.id, params.requirementId, body),
    };
  }

  @Delete(':id/requirements/:requirementId')
  @RequirePermission('tender.manage_requirements')
  @ApiNoContent()
  async deleteRequirement(
    @Param({ schema: tenderRequirementParamsSchema }) params: RequirementParams,
    @Query({ schema: versionQuerySchema }) query: In<typeof versionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.requirements.delete(await this.actions.create(request), params.id, params.requirementId, query.version);
  }

  /** Owner, reviewer and manager steps of the requirement workflow; each transition names its actor. */
  @Post(':id/requirements/:requirementId/status')
  @ApiResult(tenderRequirementResponseSchema)
  async changeRequirementStatus(
    @Param({ schema: tenderRequirementParamsSchema }) params: RequirementParams,
    @Body({ schema: requirementStatusRequestSchema }) body: In<typeof requirementStatusRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return {
      data: await this.requirements.changeStatus(
        await this.actions.create(request),
        params.id,
        params.requirementId,
        body,
      ),
    };
  }

  @Post(':id/requirements/:requirementId/links')
  @ApiResult(tenderRequirementResponseSchema, 201)
  async addRequirementLink(
    @Param({ schema: tenderRequirementParamsSchema }) params: RequirementParams,
    @Body({ schema: createRequirementLinkSchema }) body: In<typeof createRequirementLinkSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return {
      data: await this.requirements.addLink(await this.actions.create(request), params.id, params.requirementId, body),
    };
  }

  @Delete(':id/requirements/:requirementId/links/:linkId')
  @ApiResult(tenderRequirementResponseSchema)
  async removeRequirementLink(
    @Param({ schema: requirementLinkParamsSchema }) params: In<typeof requirementLinkParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderRequirementView }> {
    return {
      data: await this.requirements.removeLink(
        await this.actions.create(request),
        params.id,
        params.requirementId,
        params.linkId,
      ),
    };
  }

  // ---- Review gates ----

  @Get(':id/reviews')
  @ApiResult(tenderReviewGateListResponseSchema)
  async listReviews(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderReviewGateView[] }> {
    return { data: await this.reviews.list(await this.actions.create(request), params.id) };
  }

  @Post(':id/reviews')
  @RequirePermission('tender.edit')
  @ApiResult(tenderReviewGateListResponseSchema, 201)
  async requestReview(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: requestTenderReviewSchema }) body: In<typeof requestTenderReviewSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderReviewGateView[] }> {
    return { data: await this.reviews.request(await this.actions.create(request), params.id, body) };
  }

  /** Only the assigned reviewer decides; the final gate additionally needs `tender.approve`. */
  @Post(':id/reviews/:reviewId/decision')
  @ApiResult(tenderReviewGateListResponseSchema)
  async decideReview(
    @Param({ schema: tenderReviewParamsSchema }) params: In<typeof tenderReviewParamsSchema>,
    @Body({ schema: tenderReviewDecisionRequestSchema }) body: In<typeof tenderReviewDecisionRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderReviewGateView[] }> {
    return { data: await this.reviews.decide(await this.actions.create(request), params.id, params.reviewId, body) };
  }

  // ---- Submission and outcome ----

  @Post(':id/submission')
  @RequirePermission('tender.submit')
  @PrincipalRateLimit('sensitive')
  @ApiHeader(COMMERCIAL_IDEMPOTENCY_HEADER)
  @ApiResult(tenderResponseSchema)
  async submit(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: submitTenderSchema }) body: In<typeof submitTenderSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    const key = requiredIdempotencyKey(request);
    return { data: await this.tenders.submit(await this.actions.create(request), params.id, body, key) };
  }

  /** Corrections append a new submission record; the original is never edited. */
  @Post(':id/submission/corrections')
  @RequirePermission('tender.submit')
  @PrincipalRateLimit('sensitive')
  @ApiHeader(COMMERCIAL_IDEMPOTENCY_HEADER)
  @ApiResult(tenderResponseSchema)
  async correctSubmission(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: correctSubmissionSchema }) body: In<typeof correctSubmissionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    const key = requiredIdempotencyKey(request);
    return { data: await this.tenders.correctSubmission(await this.actions.create(request), params.id, body, key) };
  }

  @Get(':id/submissions')
  @ApiResult(tenderSubmissionListResponseSchema)
  async listSubmissions(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderSubmissionView[] }> {
    return { data: await this.tenders.listSubmissions(await this.actions.create(request), params.id) };
  }

  @Post(':id/award')
  @RequirePermission('tender.record_award')
  @PrincipalRateLimit('sensitive')
  @ApiResult(tenderResponseSchema)
  async recordAward(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: recordAwardSchema }) body: In<typeof recordAwardSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.recordAward(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/loss')
  @RequirePermission('tender.record_loss')
  @PrincipalRateLimit('sensitive')
  @ApiResult(tenderResponseSchema)
  async recordLoss(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: recordLossSchema }) body: In<typeof recordLossSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    return { data: await this.tenders.recordLoss(await this.actions.create(request), params.id, body) };
  }

  /** Awarded tenders become contracts explicitly; a retry with the same key returns the same contract. */
  @Post(':id/contract')
  @RequirePermission('contract.create')
  @PrincipalRateLimit('sensitive')
  @ApiHeader(COMMERCIAL_IDEMPOTENCY_HEADER)
  @ApiResult(contractResponseSchema, 201)
  async createContract(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createContractFromTenderSchema }) body: In<typeof createContractFromTenderSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    const key = requiredIdempotencyKey(request);
    return { data: await this.contracts.createFromTender(await this.actions.create(request), params.id, body, key) };
  }

  // ---- Addenda and clarifications ----

  @Get(':id/addenda')
  @ApiResult(tenderAddendumListResponseSchema)
  async listAddenda(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderAddendumView[] }> {
    return { data: await this.tenders.listAddenda(await this.actions.create(request), params.id) };
  }

  @Post(':id/addenda')
  @RequirePermission('tender.edit')
  @ApiResult(tenderResponseSchema, 201)
  async createAddendum(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createAddendumSchema }) body: In<typeof createAddendumSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderView }> {
    const action = await this.actions.create(request);
    await this.tenders.createAddendum(action, params.id, body);
    return { data: await this.tenders.get(action, params.id) };
  }

  @Get(':id/clarifications')
  @ApiResult(tenderClarificationListResponseSchema)
  async listClarifications(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderClarificationView[] }> {
    return { data: await this.tenders.listClarifications(await this.actions.create(request), params.id) };
  }

  @Post(':id/clarifications')
  @RequirePermission('tender.edit')
  @ApiResult(tenderClarificationResponseSchema, 201)
  async createClarification(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createClarificationSchema }) body: In<typeof createClarificationSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderClarificationView }> {
    return { data: await this.tenders.createClarification(await this.actions.create(request), params.id, body) };
  }

  @Patch(':id/clarifications/:clarificationId')
  @RequirePermission('tender.edit')
  @ApiResult(tenderClarificationResponseSchema)
  async updateClarification(
    @Param({ schema: clarificationParamsSchema }) params: In<typeof clarificationParamsSchema>,
    @Body({ schema: updateClarificationSchema }) body: In<typeof updateClarificationSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TenderClarificationView }> {
    return {
      data: await this.tenders.updateClarification(
        await this.actions.create(request),
        params.id,
        params.clarificationId,
        body,
      ),
    };
  }

  // ---- Documents, guarantees, timeline ----

  /** Restricted documents the caller may not open are neither listed nor counted. */
  @Get(':id/documents')
  @ApiResult(commercialDocumentListResponseSchema)
  async listDocuments(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: { items: CommercialDocumentView[] } }> {
    return { data: await this.documents.listForTender(await this.actions.create(request), params.id) };
  }

  @Post(':id/documents')
  @RequirePermission('tender.edit')
  @ApiResult(commercialDocumentResponseSchema, 201)
  async createDocument(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createCommercialDocumentSchema }) body: In<typeof createCommercialDocumentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CommercialDocumentView }> {
    return { data: await this.documents.createForTender(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/guarantees')
  @ApiResult(guaranteeListResponseSchema)
  async listGuarantees(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView[] }> {
    return { data: await this.guarantees.listForTender(await this.actions.create(request), params.id) };
  }

  @Post(':id/guarantees')
  @RequirePermission('tender.edit')
  @ApiResult(guaranteeResponseSchema, 201)
  async createGuarantee(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Body({ schema: createGuaranteeSchema }) body: In<typeof createGuaranteeSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView }> {
    return { data: await this.guarantees.createForTender(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/timeline')
  @ApiResult(commercialEventPageResponseSchema)
  async timeline(
    @Param({ schema: tenderIdParamsSchema }) params: IdParams,
    @Query({ schema: eventPageQuerySchema }) query: In<typeof eventPageQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<CommercialEventView>> {
    return toPage(
      await this.tenders.timeline(await this.actions.create(request), params.id, query.cursor, query.limit),
    );
  }
}
