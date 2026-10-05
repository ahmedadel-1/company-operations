import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CustomerService } from '@company-ops/core';
import type { CustomerView } from '@company-ops/core';
import {
  createCustomerRequestSchema,
  customerListQuerySchema,
  customerPageResponseSchema,
  customerResponseSchema,
  idParamsSchema,
  updateCustomerRequestSchema,
} from '@company-ops/validation';
import type {
  CreateCustomerRequest,
  CustomerListQuery,
  IdParams,
  UpdateCustomerRequest,
} from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Customers (P2-1): a lightweight directory, not a CRM. Reading is for project administrators (the
 * service checks the combined rule); changes need `project.create` at ORG scope. Archived, never deleted.
 */
@ApiTags('customers')
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(
    @Inject(CustomerService) private readonly customers: CustomerService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(customerPageResponseSchema)
  async list(
    @Query({ schema: customerListQuerySchema }) query: CustomerListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: readonly CustomerView[]; page: { nextCursor: string | null } }> {
    const page = await this.customers.list(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Post()
  @RequirePermission('project.create')
  @ApiResult(customerResponseSchema, 201)
  async create(
    @Body({ schema: createCustomerRequestSchema }) body: CreateCustomerRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: CustomerView }> {
    return { data: await this.customers.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @ApiResult(customerResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: CustomerView }> {
    return { data: await this.customers.get(await this.actions.create(request), params.id) };
  }

  /** Edits fields; `archived` archives or restores the customer. */
  @Patch(':id')
  @RequirePermission('project.create')
  @ApiResult(customerResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateCustomerRequestSchema }) body: UpdateCustomerRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: CustomerView }> {
    return { data: await this.customers.update(await this.actions.create(request), params.id, body) };
  }
}
