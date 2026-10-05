import type { Prisma } from '@company-ops/db';

import { redactAuditMetadata } from './redact.js';

/**
 * Audit facility (SECURITY §7/§8, DATA_MODEL §10). Application code only ever inserts: the tables
 * are append-only (trigger + grants), and there is no update/delete path here.
 */
export type AuditActor =
  | { readonly type: 'USER'; readonly userId: string; readonly memberId: string | null }
  | { readonly type: 'SYSTEM' }
  | { readonly type: 'INTEGRATION' };

/** Request facts attached to audit rows. Never tokens, cookies or credentials. */
export interface AuditRequestContext {
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface AuditEntry {
  /** Dotted action, e.g. `auth.login.succeeded`, `role.granted`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly actor: AuditActor;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly context?: AuditRequestContext | undefined;
}

export interface AuditLogStore {
  auditLog: {
    create(args: { data: Prisma.AuditLogUncheckedCreateInput; select: { id: true } }): PromiseLike<{ id: string }>;
  };
}

export interface PlatformAuditLogStore {
  platformAuditLog: {
    create(args: {
      data: Prisma.PlatformAuditLogUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
  };
}

const MAX_USER_AGENT = 512;

function requestFields(context: AuditRequestContext | undefined) {
  return {
    requestId: context?.requestId ?? null,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent === undefined ? null : context.userAgent.slice(0, MAX_USER_AGENT),
  };
}

/**
 * Inserts an organization audit row. When `store` is the tenant-scoped client, the tenant guard also
 * verifies that `organizationId` is the active organization.
 */
export async function recordAudit(store: AuditLogStore, organizationId: string, entry: AuditEntry): Promise<string> {
  const actor = entry.actor;
  const { requestId, ip, userAgent } = requestFields(entry.context);
  const row = await store.auditLog.create({
    data: {
      organizationId,
      actorType: actor.type,
      actorUserId: actor.type === 'USER' ? actor.userId : null,
      actorMemberId: actor.type === 'USER' ? actor.memberId : null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: redactAuditMetadata(entry.metadata ?? {}),
      requestId,
      ip,
      userAgent,
    },
    select: { id: true },
  });
  return row.id;
}

export type PlatformAuditActor =
  { readonly type: 'USER'; readonly userId: string } | { readonly type: 'SYSTEM' } | { readonly type: 'CLI' };

export interface PlatformAuditEntry {
  readonly action: string;
  readonly actor: PlatformAuditActor;
  readonly targetOrganizationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly context?: Pick<AuditRequestContext, 'requestId' | 'ip'> | undefined;
}

/** Inserts a platform audit row (ADR-0010). Only platform operations call this. */
export async function recordPlatformAudit(store: PlatformAuditLogStore, entry: PlatformAuditEntry): Promise<string> {
  const row = await store.platformAuditLog.create({
    data: {
      actorType: entry.actor.type,
      actorUserId: entry.actor.type === 'USER' ? entry.actor.userId : null,
      action: entry.action,
      targetOrganizationId: entry.targetOrganizationId ?? null,
      metadata: redactAuditMetadata(entry.metadata ?? {}),
      requestId: entry.context?.requestId ?? null,
      ip: entry.context?.ip ?? null,
    },
    select: { id: true },
  });
  return row.id;
}
