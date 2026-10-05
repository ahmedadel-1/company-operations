import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  CommercialDocumentService,
  CommercialReportService,
  CommercialSettingsService,
  CorporateDocumentService,
  GuaranteeService,
  ProjectCommercialService,
} from '@company-ops/core';
import type {
  CommercialDocumentView,
  CommercialSettingsView,
  CorporateDocumentSummaryView,
  CorporateDocumentView,
  GuaranteeView,
  ProjectCommercialView,
} from '@company-ops/core';
import {
  addCorporateVersionSchema,
  addDocumentVersionSchema,
  commercialDocumentResponseSchema,
  commercialReportParamsSchema,
  commercialReportQuerySchema,
  commercialSettingsResponseSchema,
  corporateDocumentListQuerySchema,
  corporateDocumentPageResponseSchema,
  corporateDocumentResponseSchema,
  createCorporateDocumentSchema,
  documentParamsSchema,
  guaranteeParamsSchema,
  guaranteeResponseSchema,
  guaranteeStatusRequestSchema,
  idParamsSchema,
  projectCommercialResponseSchema,
  updateCommercialSettingsSchema,
  updateCorporateDocumentSchema,
  updateGuaranteeSchema,
} from '@company-ops/validation';
import type { IdParams, SchemaOutput as In } from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiCsv, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { toPage } from './commercial-http.js';
import type { PageBody } from './commercial-http.js';

/**
 * The corporate document vault (spec §26-§29): company registrations, certificates and licences with
 * versions and expiry. GENERAL documents need `corporate_document.view`; other classifications also
 * `corporate_document.restricted.view`; out-of-reach documents are 404.
 */
@ApiTags('corporate-documents')
@Controller({ path: 'corporate-documents', version: '1' })
export class CorporateDocumentsController {
  constructor(
    @Inject(CorporateDocumentService) private readonly documents: CorporateDocumentService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('corporate_document.view')
  @ApiResult(corporateDocumentPageResponseSchema)
  async list(
    @Query({ schema: corporateDocumentListQuerySchema }) query: In<typeof corporateDocumentListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<CorporateDocumentSummaryView>> {
    return toPage(await this.documents.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('corporate_document.manage')
  @ApiResult(corporateDocumentResponseSchema, 201)
  async create(
    @Body({ schema: createCorporateDocumentSchema }) body: In<typeof createCorporateDocumentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CorporateDocumentView }> {
    return { data: await this.documents.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @RequirePermission('corporate_document.view')
  @ApiResult(corporateDocumentResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: CorporateDocumentView }> {
    return { data: await this.documents.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('corporate_document.manage')
  @ApiResult(corporateDocumentResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateCorporateDocumentSchema }) body: In<typeof updateCorporateDocumentSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CorporateDocumentView }> {
    return { data: await this.documents.update(await this.actions.create(request), params.id, body) };
  }

  /** A renewed certificate is a new version; earlier versions stay readable. */
  @Post(':id/versions')
  @RequirePermission('corporate_document.manage')
  @ApiResult(corporateDocumentResponseSchema, 201)
  async addVersion(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: addCorporateVersionSchema }) body: In<typeof addCorporateVersionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CorporateDocumentView }> {
    return { data: await this.documents.addVersion(await this.actions.create(request), params.id, body) };
  }
}

/** Tender and contract documents by id (versions are append-only; classification gates the file). */
@ApiTags('commercial-documents')
@Controller({ path: 'commercial-documents', version: '1' })
export class CommercialDocumentsController {
  constructor(
    @Inject(CommercialDocumentService) private readonly documents: CommercialDocumentService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':documentId')
  @ApiResult(commercialDocumentResponseSchema)
  async get(
    @Param({ schema: documentParamsSchema }) params: In<typeof documentParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CommercialDocumentView }> {
    return { data: await this.documents.get(await this.actions.create(request), params.documentId) };
  }

  @Post(':documentId/versions')
  @ApiResult(commercialDocumentResponseSchema, 201)
  async addVersion(
    @Param({ schema: documentParamsSchema }) params: In<typeof documentParamsSchema>,
    @Body({ schema: addDocumentVersionSchema }) body: In<typeof addDocumentVersionSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CommercialDocumentView }> {
    return { data: await this.documents.addVersion(await this.actions.create(request), params.documentId, body) };
  }
}

/** Guarantees by id; amounts follow the parent tender's or contract's financial permission. */
@ApiTags('guarantees')
@Controller({ path: 'guarantees', version: '1' })
export class GuaranteesController {
  constructor(
    @Inject(GuaranteeService) private readonly guarantees: GuaranteeService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':guaranteeId')
  @ApiResult(guaranteeResponseSchema)
  async get(
    @Param({ schema: guaranteeParamsSchema }) params: In<typeof guaranteeParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView }> {
    return { data: await this.guarantees.get(await this.actions.create(request), params.guaranteeId) };
  }

  @Patch(':guaranteeId')
  @ApiResult(guaranteeResponseSchema)
  async update(
    @Param({ schema: guaranteeParamsSchema }) params: In<typeof guaranteeParamsSchema>,
    @Body({ schema: updateGuaranteeSchema }) body: In<typeof updateGuaranteeSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView }> {
    return { data: await this.guarantees.update(await this.actions.create(request), params.guaranteeId, body) };
  }

  /** Release or cancel (explicit, audited); EXPIRED is set by the monitor only. */
  @Post(':guaranteeId/status')
  @PrincipalRateLimit('sensitive')
  @ApiResult(guaranteeResponseSchema)
  async changeStatus(
    @Param({ schema: guaranteeParamsSchema }) params: In<typeof guaranteeParamsSchema>,
    @Body({ schema: guaranteeStatusRequestSchema }) body: In<typeof guaranteeStatusRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GuaranteeView }> {
    return { data: await this.guarantees.changeStatus(await this.actions.create(request), params.guaranteeId, body) };
  }
}

/** Organization reminder settings and the commercial CSV reports. */
@ApiTags('commercial')
@Controller({ path: 'commercial', version: '1' })
export class CommercialController {
  constructor(
    @Inject(CommercialSettingsService) private readonly settings: CommercialSettingsService,
    @Inject(CommercialReportService) private readonly reports: CommercialReportService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('settings')
  @ApiResult(commercialSettingsResponseSchema)
  async getSettings(@Req() request: HttpRequest): Promise<{ data: CommercialSettingsView }> {
    return { data: await this.settings.get(await this.actions.create(request)) };
  }

  @Put('settings')
  @RequirePermission('org.settings.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(commercialSettingsResponseSchema)
  async updateSettings(
    @Body({ schema: updateCommercialSettingsSchema }) body: In<typeof updateCommercialSettingsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: CommercialSettingsView }> {
    return { data: await this.settings.update(await this.actions.create(request), body) };
  }

  /**
   * Rows the caller fully sees; money columns only with the financial permission. Cells are
   * formula-escaped; `X-Export-Truncated: true` marks a report cut at the row limit. Every export is audited.
   */
  @Get('reports/:report')
  @Header('Cache-Control', 'no-store')
  @ApiCsv()
  async report(
    @Param({ schema: commercialReportParamsSchema }) params: In<typeof commercialReportParamsSchema>,
    @Query({ schema: commercialReportQuerySchema }) query: In<typeof commercialReportQuerySchema>,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<StreamableFile> {
    const result = await this.reports.export(await this.actions.create(request), params.report, query);
    response.setHeader('X-Export-Truncated', result.truncated ? 'true' : 'false');
    // Byte order mark so spreadsheet applications read UTF-8 (Arabic names) correctly.
    return new StreamableFile(Buffer.from(`\uFEFF${result.csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }
}

/** The project's Commercial tab: its tenders, contracts and their open work (project scope first). */
@ApiTags('projects')
@Controller({ path: 'projects', version: '1' })
export class ProjectCommercialController {
  constructor(
    @Inject(ProjectCommercialService) private readonly commercial: ProjectCommercialService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/commercial')
  @RequirePermission('project.view')
  @ApiResult(projectCommercialResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectCommercialView }> {
    return { data: await this.commercial.forProject(await this.actions.create(request), params.id) };
  }
}
