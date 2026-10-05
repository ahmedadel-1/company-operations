import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  AmendmentService,
  CommercialDocumentService,
  ContractService,
  ContractWorkService,
  GuaranteeService,
} from '@company-ops/core';
import type {
  AmendmentView,
  CommercialDocumentView,
  CommercialEventView,
  ContractSummaryView,
  ContractView,
  GuaranteeView,
  MilestoneView,
  ObligationView,
  OccurrenceView,
  RenewalActionView,
} from '@company-ops/core';
import {
  amendmentActionSchema,
  amendmentParamsSchema,
  commercialDocumentListResponseSchema,
  commercialDocumentResponseSchema,
  commercialEventPageResponseSchema,
  contractAmendmentListResponseSchema,
  contractAmendmentResponseSchema,
  contractIdParamsSchema,
  contractListQuerySchema,
  contractMilestoneListResponseSchema,
  contractMilestoneResponseSchema,
  contractObligationListResponseSchema,
  contractObligationResponseSchema,
  contractPageResponseSchema,
  contractResponseSchema,
  contractTransitionSchema,
  createAmendmentSchema,
  createCommercialDocumentSchema,
  createContractSchema,
  createGuaranteeSchema,
  createMilestoneSchema,
  createObligationSchema,
  eventPageQuerySchema,
  guaranteeListResponseSchema,
  guaranteeResponseSchema,
  milestoneParamsSchema,
  milestoneStatusRequestSchema,
  obligationOccurrenceResponseSchema,
  obligationParamsSchema,
  occurrenceListQuerySchema,
  occurrenceListResponseSchema,
  occurrenceParamsSchema,
  occurrenceStatusRequestSchema,
  renewalActionListResponseSchema,
  renewalActionRequestSchema,
  updateAmendmentSchema,
  updateContractSchema,
  updateMilestoneSchema,
  updateObligationSchema,
  versionBodySchema,
} from '@company-ops/validation';
import type { SchemaOutput as In } from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { COMMERCIAL_IDEMPOTENCY_HEADER, requiredIdempotencyKey, toPage } from './commercial-http.js';
import type { PageBody } from './commercial-http.js';

type IdParams = In<typeof contractIdParamsSchema>;

/**
 * Contracts (Phase 10, spec §30-§46): lifecycle, obligations and their occurrences, milestones,
 * guarantees, amendments (the effective projection), renewal decisions, documents and the timeline.
 * Owners of obligations, occurrences, milestones and guarantees see the contracts they work on
 * (INVOLVED access, never financial values); the services resolve access per contract and answer 404
 * for contracts outside it.
 */
@ApiTags('contracts')
@Controller({ path: 'contracts', version: '1' })
export class ContractsController {
  constructor(
    @Inject(ContractService) private readonly contracts: ContractService,
    @Inject(ContractWorkService) private readonly work: ContractWorkService,
    @Inject(AmendmentService) private readonly amendments: AmendmentService,
    @Inject(CommercialDocumentService) private readonly documents: CommercialDocumentService,
    @Inject(GuaranteeService) private readonly guarantees: GuaranteeService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(contractPageResponseSchema)
  async list(
    @Query({ schema: contractListQuerySchema }) query: In<typeof contractListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ContractSummaryView>> {
    return toPage(await this.contracts.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('contract.create')
  @ApiResult(contractResponseSchema, 201)
  async create(
    @Body({ schema: createContractSchema }) body: In<typeof createContractSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    return { data: await this.contracts.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @ApiResult(contractResponseSchema)
  async get(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    return { data: await this.contracts.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('contract.edit')
  @ApiResult(contractResponseSchema)
  async update(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: updateContractSchema }) body: In<typeof updateContractSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    return { data: await this.contracts.update(await this.actions.create(request), params.id, body) };
  }

  /** Lifecycle changes; each transition names its own permission (edit or approve), checked by the service. */
  @Post(':id/transition')
  @PrincipalRateLimit('sensitive')
  @ApiResult(contractResponseSchema)
  async transition(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: contractTransitionSchema }) body: In<typeof contractTransitionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    return { data: await this.contracts.transition(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/timeline')
  @ApiResult(commercialEventPageResponseSchema)
  async timeline(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Query({ schema: eventPageQuerySchema }) query: In<typeof eventPageQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<CommercialEventView>> {
    return toPage(
      await this.contracts.timeline(await this.actions.create(request), params.id, query.cursor, query.limit),
    );
  }

  // ---- Renewal ----

  @Get(':id/renewal-actions')
  @ApiResult(renewalActionListResponseSchema)
  async listRenewalActions(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: RenewalActionView[] }> {
    return { data: await this.contracts.listRenewalActions(await this.actions.create(request), params.id) };
  }

  /** Renewals are explicit decisions, never silent; a retry with the same key is not applied twice. */
  @Post(':id/renewal-actions')
  @RequirePermission('contract.manage_renewal')
  @PrincipalRateLimit('sensitive')
  @ApiHeader(COMMERCIAL_IDEMPOTENCY_HEADER)
  @ApiResult(contractResponseSchema, 201)
  async recordRenewalAction(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: renewalActionRequestSchema }) body: In<typeof renewalActionRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ContractView }> {
    const key = requiredIdempotencyKey(request);
    return { data: await this.contracts.recordRenewalAction(await this.actions.create(request), params.id, body, key) };
  }

  // ---- Obligations and occurrences ----

  @Get(':id/obligations')
  @ApiResult(contractObligationListResponseSchema)
  async listObligations(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ObligationView[] }> {
    return { data: await this.work.listObligations(await this.actions.create(request), params.id) };
  }

  @Post(':id/obligations')
  @RequirePermission('contract.manage_obligations')
  @ApiResult(contractObligationResponseSchema, 201)
  async createObligation(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: createObligationSchema }) body: In<typeof createObligationSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ObligationView }> {
    return { data: await this.work.createObligation(await this.actions.create(request), params.id, body) };
  }

  @Patch(':id/obligations/:obligationId')
  @RequirePermission('contract.manage_obligations')
  @ApiResult(contractObligationResponseSchema)
  async updateObligation(
    @Param({ schema: obligationParamsSchema }) params: In<typeof obligationParamsSchema>,
    @Body({ schema: updateObligationSchema }) body: In<typeof updateObligationSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ObligationView }> {
    return {
      data: await this.work.updateObligation(await this.actions.create(request), params.id, params.obligationId, body),
    };
  }

  /** Cancels the obligation and its open future occurrences; completed history is kept. */
  @Post(':id/obligations/:obligationId/cancel')
  @RequirePermission('contract.manage_obligations')
  @ApiResult(contractObligationResponseSchema)
  async cancelObligation(
    @Param({ schema: obligationParamsSchema }) params: In<typeof obligationParamsSchema>,
    @Body({ schema: versionBodySchema }) body: In<typeof versionBodySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: ObligationView }> {
    return {
      data: await this.work.cancelObligation(
        await this.actions.create(request),
        params.id,
        params.obligationId,
        body.version,
      ),
    };
  }

  @Get(':id/occurrences')
  @ApiResult(occurrenceListResponseSchema)
  async listOccurrences(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Query({ schema: occurrenceListQuerySchema }) query: In<typeof occurrenceListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: OccurrenceView[] }> {
    return { data: await this.work.listOccurrences(await this.actions.create(request), params.id, query) };
  }

  /** The occurrence or obligation owner works it; waiving is a contract manager decision. */
  @Post(':id/occurrences/:occurrenceId/status')
  @ApiResult(obligationOccurrenceResponseSchema)
  async changeOccurrenceStatus(
    @Param({ schema: occurrenceParamsSchema }) params: In<typeof occurrenceParamsSchema>,
    @Body({ schema: occurrenceStatusRequestSchema }) body: In<typeof occurrenceStatusRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: OccurrenceView }> {
    return {
      data: await this.work.changeOccurrenceStatus(
        await this.actions.create(request),
        params.id,
        params.occurrenceId,
        body,
      ),
    };
  }

  // ---- Milestones ----

  @Get(':id/milestones')
  @ApiResult(contractMilestoneListResponseSchema)
  async listMilestones(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: MilestoneView[] }> {
    return { data: await this.work.listMilestones(await this.actions.create(request), params.id) };
  }

  @Post(':id/milestones')
  @RequirePermission('contract.manage_milestones')
  @ApiResult(contractMilestoneResponseSchema, 201)
  async createMilestone(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: createMilestoneSchema }) body: In<typeof createMilestoneSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: MilestoneView }> {
    return { data: await this.work.createMilestone(await this.actions.create(request), params.id, body) };
  }

  @Patch(':id/milestones/:milestoneId')
  @RequirePermission('contract.manage_milestones')
  @ApiResult(contractMilestoneResponseSchema)
  async updateMilestone(
    @Param({ schema: milestoneParamsSchema }) params: In<typeof milestoneParamsSchema>,
    @Body({ schema: updateMilestoneSchema }) body: In<typeof updateMilestoneSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: MilestoneView }> {
    return {
      data: await this.work.updateMilestone(await this.actions.create(request), params.id, params.milestoneId, body),
    };
  }

  /** The owner submits; acceptance and rejection need `contract.approve`. */
  @Post(':id/milestones/:milestoneId/status')
  @ApiResult(contractMilestoneResponseSchema)
  async changeMilestoneStatus(
    @Param({ schema: milestoneParamsSchema }) params: In<typeof milestoneParamsSchema>,
    @Body({ schema: milestoneStatusRequestSchema }) body: In<typeof milestoneStatusRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: MilestoneView }> {
    return {
      data: await this.work.changeMilestoneStatus(
        await this.actions.create(request),
        params.id,
        params.milestoneId,
        body,
      ),
    };
  }

  // ---- Amendments ----

  /** Visible with full contract access only. */
  @Get(':id/amendments')
  @ApiResult(contractAmendmentListResponseSchema)
  async listAmendments(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: AmendmentView[] }> {
    return { data: await this.amendments.list(await this.actions.create(request), params.id) };
  }

  @Post(':id/amendments')
  @RequirePermission('contract.manage_amendments')
  @ApiResult(contractAmendmentResponseSchema, 201)
  async createAmendment(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: createAmendmentSchema }) body: In<typeof createAmendmentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: AmendmentView }> {
    return { data: await this.amendments.create(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/amendments/:amendmentId')
  @ApiResult(contractAmendmentResponseSchema)
  async getAmendment(
    @Param({ schema: amendmentParamsSchema }) params: In<typeof amendmentParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: AmendmentView }> {
    return { data: await this.amendments.get(await this.actions.create(request), params.id, params.amendmentId) };
  }

  @Patch(':id/amendments/:amendmentId')
  @RequirePermission('contract.manage_amendments')
  @ApiResult(contractAmendmentResponseSchema)
  async updateAmendment(
    @Param({ schema: amendmentParamsSchema }) params: In<typeof amendmentParamsSchema>,
    @Body({ schema: updateAmendmentSchema }) body: In<typeof updateAmendmentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: AmendmentView }> {
    return {
      data: await this.amendments.update(await this.actions.create(request), params.id, params.amendmentId, body),
    };
  }

  /** Submit, approve (never by its author), reject, activate (changes the effective terms) or cancel. */
  @Post(':id/amendments/:amendmentId/actions')
  @PrincipalRateLimit('sensitive')
  @ApiResult(contractAmendmentResponseSchema)
  async actOnAmendment(
    @Param({ schema: amendmentParamsSchema }) params: In<typeof amendmentParamsSchema>,
    @Body({ schema: amendmentActionSchema }) body: In<typeof amendmentActionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: AmendmentView }> {
    return { data: await this.amendments.act(await this.actions.create(request), params.id, params.amendmentId, body) };
  }

  // ---- Documents and guarantees ----

  @Get(':id/documents')
  @ApiResult(commercialDocumentListResponseSchema)
  async listDocuments(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: { items: CommercialDocumentView[] } }> {
    return { data: await this.documents.listForContract(await this.actions.create(request), params.id) };
  }

  @Post(':id/documents')
  @RequirePermission('contract.manage_documents')
  @ApiResult(commercialDocumentResponseSchema, 201)
  async createDocument(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: createCommercialDocumentSchema }) body: In<typeof createCommercialDocumentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CommercialDocumentView }> {
    return { data: await this.documents.createForContract(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/guarantees')
  @ApiResult(guaranteeListResponseSchema)
  async listGuarantees(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView[] }> {
    return { data: await this.guarantees.listForContract(await this.actions.create(request), params.id) };
  }

  @Post(':id/guarantees')
  @RequirePermission('contract.manage_guarantees')
  @ApiResult(guaranteeResponseSchema, 201)
  async createGuarantee(
    @Param({ schema: contractIdParamsSchema }) params: IdParams,
    @Body({ schema: createGuaranteeSchema }) body: In<typeof createGuaranteeSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView }> {
    return { data: await this.guarantees.createForContract(await this.actions.create(request), params.id, body) };
  }
}
