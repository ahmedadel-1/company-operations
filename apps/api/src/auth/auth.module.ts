import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { EnvelopeCipher, IdentityService, InvitationRedemptionService, PrismaClient } from '@company-ops/core';

import type { ApiEnv } from '../config/api-env.js';
import { REDIS } from '../infrastructure/infrastructure.module.js';
import { allowedOrigins } from '../http/security.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ALLOWED_ORIGINS, CsrfGuard } from './guards/csrf.guard.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { SessionGuard } from './guards/session.guard.js';
import { MeController } from './me.controller.js';
import { OidcService } from './oidc/oidc.service.js';
import { SessionStore } from './session/session.store.js';

const MINUTE_MS = 60_000;

@Module({})
export class AuthModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AuthModule,
      // AuthService is used by the feature modules' action-context factory (MFA freshness).
      global: true,
      controllers: [AuthController, MeController],
      providers: [
        { provide: ALLOWED_ORIGINS, useValue: allowedOrigins(env) },
        {
          provide: SessionStore,
          useFactory: (redis: Redis) =>
            new SessionStore(redis, apiCipher(env), {
              idleMs: env.SESSION_IDLE_TIMEOUT_MINUTES * MINUTE_MS,
              absoluteMs: env.SESSION_ABSOLUTE_TIMEOUT_MINUTES * MINUTE_MS,
            }),
          inject: [REDIS],
        },
        {
          provide: EnvelopeCipher,
          useFactory: () => apiCipher(env),
        },
        {
          provide: OidcService,
          useFactory: (redis: Redis) =>
            new OidcService(
              {
                issuer: env.OIDC_ISSUER,
                clientId: env.OIDC_CLIENT_ID,
                clientSecret: env.OIDC_CLIENT_SECRET,
                allowInsecureHttp: env.OIDC_ALLOW_INSECURE_HTTP,
                publicUrl: env.APP_PUBLIC_URL,
              },
              redis,
            ),
          inject: [REDIS],
        },
        {
          provide: AuthService,
          useFactory: (
            prisma: PrismaClient,
            identities: IdentityService,
            sessions: SessionStore,
            oidc: OidcService,
            invitations: InvitationRedemptionService,
          ) =>
            new AuthService(prisma, identities, sessions, oidc, invitations, {
              mfaMaxAgeMs: env.MFA_MAX_AGE_MINUTES * MINUTE_MS,
            }),
          inject: [PrismaClient, IdentityService, SessionStore, OidcService, InvitationRedemptionService],
        },
        SessionGuard,
        CsrfGuard,
        PermissionGuard,
      ],
      exports: [
        SessionStore,
        EnvelopeCipher,
        AuthService,
        OidcService,
        ALLOWED_ORIGINS,
        SessionGuard,
        CsrfGuard,
        PermissionGuard,
      ],
    };
  }
}

/** Current key plus retired keys accepted for decryption (rotation, SECURITY §7). */
function apiCipher(env: ApiEnv): EnvelopeCipher {
  return EnvelopeCipher.fromBase64(env.APP_ENCRYPTION_KEY_ID, env.APP_ENCRYPTION_KEY, env.APP_ENCRYPTION_KEYS_PREVIOUS);
}
