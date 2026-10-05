import { createHash } from 'node:crypto';

import type { PrismaClient } from '@company-ops/db';
import { z } from 'zod';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { jiraConnectionTenant } from '../../platform/db/sql/jira-scan.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { AsyncLocalTenantContext, TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import type { JiraClientFactory } from './jira-client.js';
import { JiraApiError } from './jira-errors.js';
import { applySnapshot, loadPlacement, tombstoneIssue } from './jira-issue-store.js';
import { webhookJql } from './jira-jql.js';
import { toSnapshot } from './jira-mapper.js';
import type { JiraAppSettings } from './jira-oauth.js';
import { jiraWebhookUrl } from './jira-oauth.js';
import { canRegisterWebhooks } from './jira-runtime.js';
import { verifyWebhookJwt } from './jira-webhook-jwt.js';

/** Issue events we subscribe to (documented webhook events). */
export const JIRA_WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_ID = /^[\x21-\x7e]{1,200}$/;
const WEBHOOK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const webhookBodySchema = z.object({
  webhookEvent: z.string().max(100),
  timestamp: z.number().int().nonnegative().optional(),
  matchedWebhookIds: z
    .array(z.union([z.number().int(), z.string().regex(/^[0-9]{1,20}$/)]).transform(String))
    .max(100)
    .optional(),
  issue: z
    .object({
      id: z.union([z.string().regex(/^[0-9]{1,20}$/), z.number().int().nonnegative()]).transform(String),
      fields: z
        .object({ project: z.object({ id: z.union([z.string(), z.number()]).transform(String) }).optional() })
        .optional(),
    })
    .optional(),
});

export type WebhookIntakeResult =
  | { readonly status: 202; readonly outcome: 'queued' }
  | { readonly status: 200; readonly outcome: 'duplicate' | 'ignored' }
  | { readonly status: 401; readonly outcome: 'unauthenticated' }
  | { readonly status: 403; readonly outcome: 'unknown_webhook' }
  | { readonly status: 404; readonly outcome: 'unknown_connection' }
  | { readonly status: 400; readonly outcome: 'invalid_payload' };

export interface WebhookRequest {
  readonly connectionId: string;
  readonly authorization: string | undefined;
  /** `X-Atlassian-Webhook-Identifier`: unique per delivery, identical across Jira's retries. */
  readonly identifier: string | undefined;
  /** `X-Atlassian-Webhook-Retry`. */
  readonly retry: string | undefined;
  readonly body: unknown;
}

/**
 * Inbound Jira webhooks (API, no session, no CSRF: authenticated by the JWT instead). Kept fast:
 * verify → derive the tenant from the connection → record the delivery (deduplicated) → enqueue
 * processing → return. Only identifiers are stored, never issue content; processing re-reads the
 * issue from Jira, so a replayed or forged body can at most cause a re-fetch.
 *
 * Replay and duplicate protection: the delivery key (Jira's delivery identifier, else a hash of
 * event, issue and timestamp) is unique per connection, so a repeated delivery is acknowledged
 * without new work. Deliveries for an unknown or disconnected connection are 404, deliveries whose
 * `matchedWebhookIds` are not this connection's registrations are 403.
 */
export class JiraWebhookIntake {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: AsyncLocalTenantContext,
    private readonly clientSecret: string,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async receive(request: WebhookRequest): Promise<WebhookIntakeResult> {
    if (!verifyWebhookJwt(request.authorization, this.clientSecret, this.nowSeconds()).ok) {
      return { status: 401, outcome: 'unauthenticated' };
    }
    if (!UUID.test(request.connectionId)) {
      return { status: 404, outcome: 'unknown_connection' };
    }
    const connection = await jiraConnectionTenant(this.prisma, request.connectionId);
    if (connection === null || connection.status === 'DISCONNECTED') {
      return { status: 404, outcome: 'unknown_connection' };
    }
    const parsed = webhookBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return { status: 400, outcome: 'invalid_payload' };
    }
    const body = parsed.data;
    if (!(JIRA_WEBHOOK_EVENTS as readonly string[]).includes(body.webhookEvent) || body.issue === undefined) {
      return { status: 200, outcome: 'ignored' };
    }
    const issue = body.issue;
    const organizationId = connection.organizationId;
    return this.tenant.run({ organizationId, memberId: null, userId: null }, async () => {
      const registrations = await this.db.jiraWebhookRegistration.findMany({
        where: { organizationId, connectionId: request.connectionId },
        select: { jiraWebhookId: true },
      });
      const known = new Set(registrations.map((row) => row.jiraWebhookId));
      const matched = body.matchedWebhookIds ?? [];
      if (matched.length > 0 && !matched.some((id) => known.has(id))) {
        return { status: 403, outcome: 'unknown_webhook' } as const;
      }
      const identifier = request.identifier?.trim();
      const deliveryKey =
        identifier !== undefined && DELIVERY_ID.test(identifier)
          ? identifier
          : `sha256:${createHash('sha256')
              .update(`${body.webhookEvent}|${issue.id}|${String(body.timestamp ?? '')}`)
              .digest('hex')}`;
      const retryCount = Math.min(100, Math.max(0, Number.parseInt(request.retry ?? '0', 10) || 0));
      const projectId = issue.fields?.project?.id ?? null;
      const relevant = await this.isRelevant(organizationId, request.connectionId, issue.id, projectId);
      try {
        return await this.db.$transaction(async (tx) => {
          const delivery = await tx.jiraWebhookDelivery.create({
            data: {
              organizationId,
              connectionId: request.connectionId,
              deliveryKey,
              eventType: body.webhookEvent,
              jiraIssueId: issue.id,
              jiraProjectId: projectId !== null && /^[0-9]{1,20}$/.test(projectId) ? projectId : null,
              webhookTimestamp: body.timestamp === undefined ? null : new Date(body.timestamp),
              retryCount,
              status: relevant ? 'RECEIVED' : 'IGNORED',
              outcome: relevant ? null : 'unmapped',
              processedAt: relevant ? null : new Date(),
              payload: { matchedWebhookIds: matched.slice(0, 10) },
            },
            select: { id: true },
          });
          if (!relevant) {
            return { status: 200, outcome: 'ignored' } as const;
          }
          await enqueueOutboxEvent(tx, organizationId, {
            eventType: 'jira.webhook.received',
            aggregateType: 'jira_webhook_delivery',
            aggregateId: delivery.id,
            payload: { deliveryId: delivery.id },
          });
          return { status: 202, outcome: 'queued' } as const;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { status: 200, outcome: 'duplicate' } as const;
        }
        throw error;
      }
    });
  }

  /** An issue matters when its project is mapped or it is already cached (it may have moved out). */
  private async isRelevant(
    organizationId: string,
    connectionId: string,
    jiraIssueId: string,
    projectId: string | null,
  ): Promise<boolean> {
    if (projectId !== null) {
      const mapping = await this.db.jiraProjectMapping.findFirst({
        where: { organizationId, connectionId, jiraProjectId: projectId, removedAt: null },
        select: { id: true },
      });
      if (mapping !== null) {
        return true;
      }
    }
    const cached = await this.db.jiraIssue.findFirst({
      where: { organizationId, connectionId, jiraIssueId },
      select: { id: true },
    });
    return cached !== null;
  }
}

export type DeliveryProcessOutcome =
  'created' | 'updated' | 'unchanged' | 'stale' | 'tombstoned' | 'ignored' | 'duplicate' | 'connection_inactive';

/**
 * Processes a recorded delivery (worker, tenant context of the delivery's organization): re-fetches
 * the issue from Jira (authoritative, current) and applies it with the out-of-order guard; a 404
 * tombstones a cached issue. Already processed deliveries are skipped. Transient Jira failures are
 * recorded on the delivery and rethrown so the queue retries with backoff.
 */
export class JiraWebhookProcessor {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clients: JiraClientFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(deliveryId: string): Promise<DeliveryProcessOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const delivery = await this.db.jiraWebhookDelivery.findFirst({
      where: { organizationId, id: deliveryId },
      select: {
        id: true,
        status: true,
        connectionId: true,
        jiraIssueId: true,
        connection: { select: { status: true, cloudId: true, siteUrl: true } },
      },
    });
    if (delivery === null || delivery.status === 'PROCESSED' || delivery.status === 'IGNORED') {
      return 'duplicate';
    }
    if (delivery.connection.status !== 'ACTIVE' && delivery.connection.status !== 'ERROR') {
      await this.complete(organizationId, deliveryId, 'IGNORED', 'connection_inactive');
      return 'connection_inactive';
    }
    if (delivery.jiraIssueId === null) {
      await this.complete(organizationId, deliveryId, 'IGNORED', 'no_issue');
      return 'ignored';
    }
    const client = this.clients.forConnection({
      organizationId,
      connectionId: delivery.connectionId,
      cloudId: delivery.connection.cloudId,
    });
    const placement = await loadPlacement(this.db, organizationId, delivery.connectionId);
    let outcome: DeliveryProcessOutcome;
    try {
      const issue = await client.getIssue(delivery.jiraIssueId);
      const snapshot = toSnapshot(issue, delivery.connection.siteUrl);
      outcome =
        snapshot === null
          ? 'ignored'
          : (await applySnapshot(this.db, placement, snapshot, { now: this.now() })).outcome;
    } catch (error) {
      if (error instanceof JiraApiError && error.kind === 'not_found') {
        const removed = await tombstoneIssue(
          this.db,
          organizationId,
          delivery.connectionId,
          delivery.jiraIssueId,
          this.now(),
        );
        outcome = removed ? 'tombstoned' : 'ignored';
      } else {
        const code = error instanceof JiraApiError ? error.code : 'processing_failed';
        await this.db.jiraWebhookDelivery.updateMany({
          where: { organizationId, id: deliveryId },
          data: { status: 'FAILED', errorCode: code },
        });
        throw error;
      }
    }
    await this.complete(organizationId, deliveryId, 'PROCESSED', outcome);
    return outcome;
  }

  private async complete(
    organizationId: string,
    deliveryId: string,
    status: 'PROCESSED' | 'IGNORED',
    outcome: string,
  ): Promise<void> {
    await this.db.jiraWebhookDelivery.updateMany({
      where: { organizationId, id: deliveryId },
      data: { status, outcome, errorCode: null, processedAt: this.now() },
    });
  }
}

export type WebhookSyncOutcome =
  'inactive' | 'unsupported_url' | 'removed' | 'unchanged' | 'refreshed' | 'registered' | 'failed';

/**
 * Keeps one dynamic webhook registration per connection whose JQL covers exactly the mapped Jira
 * projects (OAuth apps may hold at most 5 per user and site). New registrations are created before
 * old ones are deleted, so no events are missed during a change; if Jira refuses (limit reached),
 * the old ones are deleted first and registration is retried once. Registrations expire after 30
 * days and are refreshed when less than 7 days remain. Failures are recorded on the connection and
 * reconciliation keeps the cache correct meanwhile.
 */
export class JiraWebhookRegistrar {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clients: JiraClientFactory,
    private readonly settings: JiraAppSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sync(connectionId: string): Promise<WebhookSyncOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const connection = await this.db.jiraConnection.findFirst({
      where: { organizationId, id: connectionId },
      select: { id: true, status: true, cloudId: true },
    });
    if (connection === null || (connection.status !== 'ACTIVE' && connection.status !== 'ERROR')) {
      return 'inactive';
    }
    if (!canRegisterWebhooks(this.settings)) {
      await this.setError(organizationId, connectionId, 'webhook_url_not_https');
      return 'unsupported_url';
    }
    const client = this.clients.forConnection({ organizationId, connectionId, cloudId: connection.cloudId });
    const mappings = await this.db.jiraProjectMapping.findMany({
      where: { organizationId, connectionId, removedAt: null, syncEnabled: true },
      select: { jiraProjectId: true },
    });
    const registrations = await this.db.jiraWebhookRegistration.findMany({
      where: { organizationId, connectionId },
      select: { id: true, jiraWebhookId: true, jqlFilter: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    });
    try {
      if (mappings.length === 0) {
        await this.remove(organizationId, client, registrations);
        await this.setError(organizationId, connectionId, null);
        return 'removed';
      }
      const jql = webhookJql([...new Set(mappings.map((m) => m.jiraProjectId))]);
      const current = registrations.find((row) => row.jqlFilter === jql);
      if (current !== undefined) {
        await this.remove(
          organizationId,
          client,
          registrations.filter((row) => row.id !== current.id),
        );
        await this.setError(organizationId, connectionId, null);
        if (current.expiresAt.getTime() - this.now().getTime() < REFRESH_WITHIN_MS) {
          await this.refresh(organizationId, client, [current]);
          return 'refreshed';
        }
        return 'unchanged';
      }
      const url = jiraWebhookUrl(this.settings, connectionId);
      let result = await client.registerWebhook(url, jql, JIRA_WEBHOOK_EVENTS);
      if (result.webhookId === null && registrations.length > 0) {
        await this.remove(organizationId, client, registrations);
        result = await client.registerWebhook(url, jql, JIRA_WEBHOOK_EVENTS);
        registrations.length = 0;
      }
      if (result.webhookId === null) {
        await this.setError(organizationId, connectionId, 'webhook_registration_rejected');
        return 'failed';
      }
      await this.db.jiraWebhookRegistration.create({
        data: {
          organizationId,
          connectionId,
          jiraWebhookId: result.webhookId,
          jqlFilter: jql,
          events: [...JIRA_WEBHOOK_EVENTS],
          expiresAt: new Date(this.now().getTime() + WEBHOOK_LIFETIME_MS),
        },
        select: { id: true },
      });
      await this.remove(organizationId, client, registrations);
      await this.setError(organizationId, connectionId, null);
      return 'registered';
    } catch (error) {
      if (error instanceof JiraApiError) {
        await this.setError(organizationId, connectionId, error.code);
        if (error.retryable) {
          throw error;
        }
        return 'failed';
      }
      throw error;
    }
  }

  /**
   * After disconnect: delete the connection's webhooks in Jira (best effort, the tokens still work
   * unless revoked), then wipe the stored tokens. Skipped if the connection was reconnected meanwhile.
   */
  async cleanup(connectionId: string): Promise<'cleaned' | 'skipped'> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const connection = await this.db.jiraConnection.findFirst({
      where: { organizationId, id: connectionId },
      select: { status: true, cloudId: true, disconnectedAt: true },
    });
    if (connection?.status !== 'DISCONNECTED' || connection.disconnectedAt === null) {
      return 'skipped';
    }
    // A reconnect may race this job: registrations made after the disconnect belong to the new session.
    const registrations = await this.db.jiraWebhookRegistration.findMany({
      where: { organizationId, connectionId, createdAt: { lte: connection.disconnectedAt } },
      select: { id: true, jiraWebhookId: true },
    });
    if (registrations.length > 0) {
      const client = this.clients.forConnection({
        organizationId,
        connectionId,
        cloudId: connection.cloudId,
        allowDisconnected: true,
      });
      try {
        await client.deleteWebhooks(registrations.map((row) => row.jiraWebhookId));
      } catch (error) {
        if (!(error instanceof JiraApiError) || error.retryable) {
          throw error;
        }
      }
      await this.db.jiraWebhookRegistration.deleteMany({
        where: { organizationId, id: { in: registrations.map((row) => row.id) } },
      });
    }
    const wiped = await this.db.jiraConnection.updateMany({
      where: { organizationId, id: connectionId, status: 'DISCONNECTED' },
      data: { accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null, encryptionKeyId: null },
    });
    return wiped.count > 0 ? 'cleaned' : 'skipped';
  }

  private async refresh(
    organizationId: string,
    client: ReturnType<JiraClientFactory['forConnection']>,
    rows: readonly { id: string; jiraWebhookId: string }[],
  ): Promise<void> {
    const expiresAt = await client.refreshWebhooks(rows.map((row) => row.jiraWebhookId));
    await this.db.jiraWebhookRegistration.updateMany({
      where: { organizationId, id: { in: rows.map((row) => row.id) } },
      data: { expiresAt, lastRefreshedAt: this.now() },
    });
  }

  private async remove(
    organizationId: string,
    client: ReturnType<JiraClientFactory['forConnection']>,
    rows: readonly { id: string; jiraWebhookId: string }[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    try {
      await client.deleteWebhooks(rows.map((row) => row.jiraWebhookId));
    } catch (error) {
      if (!(error instanceof JiraApiError) || (error.kind !== 'not_found' && error.kind !== 'invalid_request')) {
        throw error;
      }
    }
    await this.db.jiraWebhookRegistration.deleteMany({
      where: { organizationId, id: { in: rows.map((row) => row.id) } },
    });
  }

  private async setError(organizationId: string, connectionId: string, code: string | null): Promise<void> {
    await this.db.jiraConnection.updateMany({
      where: { organizationId, id: connectionId },
      data: { webhookErrorCode: code },
    });
  }
}
