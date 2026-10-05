import { Global, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import {
  createTenantScopedClient,
  IdentityService,
  InvitationRedemptionService,
  PrismaClient,
  ScopeReachResolver,
} from '@company-ops/core';

import { ClsTenantContext } from './cls-tenant-context.js';

/** Tenant-scoped Prisma client (guard extension); the only client business modules receive. */
export const TENANT_DB = Symbol('TENANT_DB');

@Global()
@Module({
  providers: [
    { provide: ClsTenantContext, useFactory: (cls: ClsService) => new ClsTenantContext(cls), inject: [ClsService] },
    {
      provide: TENANT_DB,
      useFactory: (prisma: PrismaClient, tenant: ClsTenantContext) => createTenantScopedClient(prisma, tenant),
      inject: [PrismaClient, ClsTenantContext],
    },
    // Pre-tenant identity resolution and invitation redemption: base client with explicit
    // user/organization binding (no tenant context exists yet during login).
    {
      provide: IdentityService,
      useFactory: (prisma: PrismaClient) => new IdentityService(prisma),
      inject: [PrismaClient],
    },
    {
      provide: InvitationRedemptionService,
      useFactory: (prisma: PrismaClient) => new InvitationRedemptionService(prisma),
      inject: [PrismaClient],
    },
    // Tagged SQL bound to the principal's organization (recursive hierarchy queries).
    {
      provide: ScopeReachResolver,
      useFactory: (prisma: PrismaClient) => new ScopeReachResolver(prisma),
      inject: [PrismaClient],
    },
  ],
  exports: [ClsTenantContext, TENANT_DB, IdentityService, InvitationRedemptionService, ScopeReachResolver],
})
export class TenancyModule {}
