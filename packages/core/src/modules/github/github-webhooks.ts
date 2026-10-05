import type { PrismaClient } from '@company-ops/db';
import { z } from 'zod';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { githubInstallationBinding } from '../../platform/db/sql/github-scan.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { AsyncLocalTenantContext, TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { verifyWebhookSignature } from './github-crypto.js';
import { GithubApiError } from './github-errors.js';
import type { GithubInstallationSync } from './github-installations.js';
import {
  detailsCoverDelivery,
  detailsOutdated,
  refreshJiraAssociation,
  refreshPullDetails,
  upsertPull,
} from './github-pr-store.js';
import type { RepoPlacement } from './github-pr-store.js';
import type { GithubRuntime } from './github-runtime.js';

/**
 * Event → actions we act on (docs "Webhook events and payloads", checked 2026-10-03). `null` = the
 * event has no action. Other events and actions are acknowledged and recorded as IGNORED.
 * `installation` and `installation_repositories` are delivered to every App without subscribing.
 */
export const GITHUB_WEBHOOK_ACTIONS: Readonly<Record<string, readonly string[] | null>> = {
  installation: ['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'],
  installation_repositories: ['added', 'removed'],
  repository: [
    'archived',
    'unarchived',
    'created',
    'deleted',
    'edited',
    'privatized',
    'publicized',
    'renamed',
    'transferred',
  ],
  pull_request: [
    'opened',
    'edited',
    'closed',
    'reopened',
    'synchronize',
    'ready_for_review',
    'converted_to_draft',
    'review_requested',
    'review_request_removed',
  ],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  check_run: ['created', 'completed', 'rerequested'],
  check_suite: ['completed', 'requested', 'rerequested'],
  status: null,
};

/** Events whose payload names a repository that must belong to the delivering installation. */
const REPOSITORY_EVENTS: ReadonlySet<string> = new Set([
  'repository',
  'pull_request',
  'pull_request_review',
  'check_run',
  'check_suite',
  'status',
]);
/** Events that only matter for repositories mapped to a project. */
const MAPPED_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_review',
  'check_run',
  'check_suite',
  'status',
]);

const EVENT_NAME = /^[a-z_]{1,64}$/;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const payloadSchema = z.object({
  action: z.string().max(64).optional(),
  installation: z.object({ id: positive }).optional(),
  repository: z.object({ id: positive }).optional(),
  pull_request: z.object({ number: positive, head: z.object({ sha }).optional() }).optional(),
  check_run: z.object({ head_sha: sha }).optional(),
  check_suite: z.object({ head_sha: sha }).optional(),
  sha: sha.optional(),
});

export type GithubWebhookResult =
  | { readonly status: 202; readonly outcome: 'queued' }
  | { readonly status: 200; readonly outcome: 'duplicate' | 'ignored' }
  | { readonly status: 401; readonly outcome: 'invalid_signature' }
  | { readonly status: 400; readonly outcome: 'invalid_payload' };

export interface GithubWebhookRequest {
  /** `X-Hub-Signature-256`. */
  readonly signature: string | undefined;
  /** `X-GitHub-Event`. */
  readonly event: string | undefined;
  /** `X-GitHub-Delivery`: unique per delivery, identical on redelivery. */
  readonly deliveryId: string | undefined;
  /** `X-GitHub-Hook-Installation-Target-Type` (`integration` for App webhooks). */
  readonly targetType: string | undefined;
  /** The exact bytes received; the signature covers them. */
  readonly rawBody: Buffer;
}

/**
 * Inbound GitHub App webhooks (API; no session and no CSRF: authenticated by the HMAC instead).
 * Order: verify `X-Hub-Signature-256` over the raw body → validate headers and JSON → derive the
 * tenant from the persisted installation binding (never from anything the payload claims about
 * organizations) → check the repository belongs to that installation → record the delivery
 * (deduplicated by `X-GitHub-Delivery`) and enqueue processing in one transaction → return.
 *
 * Only identifiers are stored, never payload content. Processing re-reads state from GitHub with
 * the installation token, so a replayed or crafted body can at most cause a re-fetch. Deliveries for
 * an installation not bound to any organization are acknowledged without being stored (the
 * delivery table is tenant-owned and there is no tenant to own them).
 */
export class GithubWebhookIntake {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: AsyncLocalTenantContext,
    private readonly webhookSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(request: GithubWebhookRequest): Promise<GithubWebhookResult> {
    if (!verifyWebhookSignature(this.webhookSecret, request.rawBody, request.signature)) {
      return { status: 401, outcome: 'invalid_signature' };
    }
    const event = request.event?.trim() ?? '';
    const deliveryId = request.deliveryId?.trim() ?? '';
    if (!EVENT_NAME.test(event) || !DELIVERY_ID.test(deliveryId)) {
      return { status: 400, outcome: 'invalid_payload' };
    }
    if (request.targetType !== undefined && request.targetType !== 'integration') {
      return { status: 200, outcome: 'ignored' };
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      return { status: 400, outcome: 'invalid_payload' };
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) {
      return { status: 400, outcome: 'invalid_payload' };
    }
    const body = parsed.data;
    if (body.installation === undefined) {
      return { status: 200, outcome: 'ignored' };
    }
    const binding = await githubInstallationBinding(this.prisma, String(body.installation.id));
    if (binding === null) {
      return { status: 200, outcome: 'ignored' };
    }
    const { organizationId, installationId } = binding;
    return this.tenant.run({ organizationId, memberId: null, userId: null }, async () => {
      const decision = await this.decide(organizationId, installationId, binding.status, event, body);
      try {
        return await this.db.$transaction(async (tx) => {
          const delivery = await tx.githubWebhookDelivery.create({
            data: {
              organizationId,
              installationId,
              deliveryId,
              event,
              action: body.action ?? null,
              githubRepoId: body.repository === undefined ? null : BigInt(body.repository.id),
              prNumber: body.pull_request?.number ?? null,
              headSha:
                body.pull_request?.head?.sha ??
                body.check_run?.head_sha ??
                body.check_suite?.head_sha ??
                body.sha ??
                null,
              status: decision === null ? 'RECEIVED' : 'IGNORED',
              outcome: decision,
              processedAt: decision === null ? null : this.now(),
            },
            select: { id: true },
          });
          if (decision !== null) {
            return { status: 200, outcome: 'ignored' } as const;
          }
          await enqueueOutboxEvent(tx, organizationId, {
            eventType: 'github.webhook.received',
            aggregateType: 'github_webhook_delivery',
            aggregateId: delivery.id,
            payload: { deliveryId: delivery.id },
          });
          return { status: 202, outcome: 'queued' } as const;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return (await this.retryFailed(organizationId, deliveryId))
            ? ({ status: 202, outcome: 'queued' } as const)
            : ({ status: 200, outcome: 'duplicate' } as const);
        }
        throw error;
      }
    });
  }

  /**
   * A redelivery (same `X-GitHub-Delivery`) of a delivery whose processing finally failed queues it
   * once more; processing is idempotent. Received, processed and ignored deliveries stay untouched.
   */
  private async retryFailed(organizationId: string, deliveryId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.githubWebhookDelivery.findFirst({
        where: { organizationId, deliveryId, status: 'FAILED' },
        select: { id: true },
      });
      if (row === null) {
        return false;
      }
      const reset = await tx.githubWebhookDelivery.updateMany({
        where: { organizationId, id: row.id, status: 'FAILED' },
        data: { status: 'RECEIVED', processedAt: null, errorCode: null },
      });
      if (reset.count === 0) {
        return false;
      }
      await enqueueOutboxEvent(tx, organizationId, {
        eventType: 'github.webhook.received',
        aggregateType: 'github_webhook_delivery',
        aggregateId: row.id,
        payload: { deliveryId: row.id },
      });
      return true;
    });
  }

  /** Null = process it; otherwise the IGNORED outcome to record. */
  private async decide(
    organizationId: string,
    installationId: string,
    installationStatus: string,
    event: string,
    body: z.output<typeof payloadSchema>,
  ): Promise<string | null> {
    if (!Object.hasOwn(GITHUB_WEBHOOK_ACTIONS, event)) {
      return 'unsupported_event';
    }
    const actions = GITHUB_WEBHOOK_ACTIONS[event] ?? null;
    if (actions !== null && (body.action === undefined || !actions.includes(body.action))) {
      return 'unsupported_action';
    }
    if (installationStatus === 'DELETED' || installationStatus === 'DISCONNECTED') {
      return 'installation_inactive';
    }
    if (!REPOSITORY_EVENTS.has(event)) {
      return null;
    }
    if (body.repository === undefined) {
      return 'no_repository';
    }
    if (event === 'repository') {
      return null;
    }
    const repo = await this.db.githubRepository.findFirst({
      where: { organizationId, installationId, githubRepoId: BigInt(body.repository.id) },
      select: { id: true, status: true },
    });
    if (repo === null) {
      return 'unknown_repository';
    }
    if (repo.status !== 'AVAILABLE') {
      return 'repository_unavailable';
    }
    if (MAPPED_ONLY_EVENTS.has(event)) {
      const mapped = await this.db.githubRepositoryMapping.findFirst({
        where: { organizationId, repositoryId: repo.id, removedAt: null },
        select: { id: true },
      });
      if (mapped === null) {
        return 'unmapped';
      }
    }
    if ((event === 'pull_request' || event === 'pull_request_review') && body.pull_request === undefined) {
      return 'no_pull_request';
    }
    return null;
  }
}

export type GithubDeliveryOutcome =
  | 'duplicate'
  | 'installation_synced'
  | 'installation_suspended'
  | 'installation_deleted'
  | 'installation_inactive'
  | 'repository_updated'
  | 'repository_removed'
  | 'repository_unavailable'
  | 'pull_created'
  | 'pull_updated'
  | 'pull_unchanged'
  | 'pull_stale'
  | 'checks_updated'
  | 'checks_current'
  | 'not_found'
  | 'ignored';

const MAX_PULLS_PER_SHA = 20;

/**
 * Processes a recorded delivery (worker, tenant context of the delivery's organization). Every
 * branch re-reads authoritative state from GitHub (installation, repository, pull request, reviews,
 * checks) and applies it with the out-of-order guards, so duplicate, replayed or reordered deliveries
 * converge. Already processed deliveries are skipped. Transient GitHub failures mark the delivery
 * FAILED and are rethrown for the queue's retry with backoff.
 */
export class GithubWebhookProcessor {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: GithubRuntime,
    private readonly installations: GithubInstallationSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(deliveryId: string): Promise<GithubDeliveryOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const delivery = await this.db.githubWebhookDelivery.findFirst({
      where: { organizationId, id: deliveryId },
      select: {
        id: true,
        status: true,
        event: true,
        action: true,
        githubRepoId: true,
        prNumber: true,
        headSha: true,
        installationId: true,
        receivedAt: true,
        installation: { select: { id: true, githubInstallationId: true, status: true } },
      },
    });
    if (delivery === null || delivery.status === 'PROCESSED' || delivery.status === 'IGNORED') {
      return 'duplicate';
    }
    let outcome: GithubDeliveryOutcome;
    try {
      outcome = await this.dispatch(organizationId, delivery);
    } catch (error) {
      if (error instanceof GithubApiError && error.kind === 'not_found') {
        outcome = 'not_found';
      } else {
        await this.db.githubWebhookDelivery.updateMany({
          where: { organizationId, id: deliveryId },
          data: {
            status: 'FAILED',
            errorCode: error instanceof GithubApiError ? error.code : 'processing_failed',
            processedAt: this.now(),
          },
        });
        throw error;
      }
    }
    await this.db.githubWebhookDelivery.updateMany({
      where: { organizationId, id: deliveryId },
      data: { status: 'PROCESSED', outcome, errorCode: null, processedAt: this.now() },
    });
    return outcome;
  }

  private async dispatch(
    organizationId: string,
    delivery: {
      event: string;
      action: string | null;
      githubRepoId: bigint | null;
      prNumber: number | null;
      headSha: string | null;
      installationId: string;
      receivedAt: Date;
      installation: { id: string; githubInstallationId: bigint; status: string };
    },
  ): Promise<GithubDeliveryOutcome> {
    const installation = delivery.installation;
    if (installation.status === 'DELETED' || installation.status === 'DISCONNECTED') {
      return 'installation_inactive';
    }
    if (delivery.event === 'installation' || delivery.event === 'installation_repositories') {
      return this.onInstallation(organizationId, installation.id, delivery.event, delivery.action);
    }
    if (installation.status !== 'ACTIVE') {
      return 'installation_inactive';
    }
    const client = this.runtime.clients.forInstallation({
      installationRowId: installation.id,
      githubInstallationId: installation.githubInstallationId.toString(),
    });
    if (delivery.githubRepoId === null) {
      return 'ignored';
    }
    if (delivery.event === 'repository') {
      return this.onRepository(organizationId, installation.id, delivery.githubRepoId, delivery.action, client);
    }
    const repo = await this.db.githubRepository.findFirst({
      where: { organizationId, installationId: installation.id, githubRepoId: delivery.githubRepoId },
      select: { id: true, fullName: true, status: true },
    });
    if (repo?.status !== 'AVAILABLE') {
      return 'repository_unavailable';
    }
    const placement: RepoPlacement = { organizationId, repositoryId: repo.id, fullName: repo.fullName };
    if ((delivery.event === 'pull_request' || delivery.event === 'pull_request_review') && delivery.prNumber !== null) {
      return this.onPull(
        placement,
        delivery.prNumber,
        delivery.event === 'pull_request_review',
        delivery.receivedAt,
        client,
      );
    }
    if (delivery.headSha !== null) {
      const pulls = await this.db.githubPullRequest.findMany({
        where: { organizationId, repositoryId: repo.id, headSha: delivery.headSha, state: 'OPEN' },
        select: {
          id: true,
          number: true,
          headSha: true,
          detailsSha: true,
          detailsFetchedAt: true,
          requestedReviewers: true,
        },
        take: MAX_PULLS_PER_SHA,
      });
      if (pulls.length === 0) {
        return 'ignored';
      }
      const outdated = pulls.filter((pull) => !detailsCoverDelivery(pull, delivery.receivedAt));
      for (const pull of outdated) {
        await refreshPullDetails(this.db, client, placement, pull, this.now);
      }
      return outdated.length === 0 ? 'checks_current' : 'checks_updated';
    }
    return 'ignored';
  }

  private async onInstallation(
    organizationId: string,
    installationId: string,
    event: string,
    action: string | null,
  ): Promise<GithubDeliveryOutcome> {
    const row = await this.installations.loadRow(organizationId, installationId);
    if (row === null) {
      return 'installation_inactive';
    }
    if (event === 'installation' && action === 'deleted') {
      await this.installations.markDeleted(organizationId, row);
      return 'installation_deleted';
    }
    const result = await this.installations.sync(installationId);
    switch (result) {
      case 'suspended':
        return 'installation_suspended';
      case 'deleted':
        return 'installation_deleted';
      case 'inactive':
        return 'installation_inactive';
      default:
        return 'installation_synced';
    }
  }

  private async onRepository(
    organizationId: string,
    installationId: string,
    githubRepoId: bigint,
    action: string | null,
    client: ReturnType<GithubRuntime['clients']['forInstallation']>,
  ): Promise<GithubDeliveryOutcome> {
    const cached = await this.db.githubRepository.findFirst({
      where: { organizationId, githubRepoId },
      select: { id: true, installationId: true },
    });
    if (cached !== null && cached.installationId !== installationId) {
      return 'ignored';
    }
    if (action === 'deleted') {
      if (cached !== null) {
        await this.installations.markRepositoryUnavailable(organizationId, cached.id, 'DELETED');
      }
      return 'repository_removed';
    }
    try {
      const wire = await client.getRepository(githubRepoId.toString());
      await this.installations.upsertRepository(organizationId, installationId, wire, this.now());
      return 'repository_updated';
    } catch (error) {
      if (error instanceof GithubApiError && error.kind === 'not_found') {
        if (cached !== null) {
          await this.installations.markRepositoryUnavailable(organizationId, cached.id, 'REMOVED');
        }
        return 'repository_removed';
      }
      throw error;
    }
  }

  private async onPull(
    placement: RepoPlacement,
    number: number,
    reviewEvent: boolean,
    receivedAt: Date,
    client: ReturnType<GithubRuntime['clients']['forInstallation']>,
  ): Promise<GithubDeliveryOutcome> {
    const wire = await client.getPull(placement.fullName, number);
    const { outcome, pull } = await upsertPull(this.db, placement, wire, this.now());
    if (outcome !== 'stale') {
      await refreshJiraAssociation(
        this.db,
        placement,
        pull.id,
        { branch: wire.head.ref, title: wire.title, body: wire.body ?? null },
        this.now(),
      );
    }
    const fresh = await this.db.githubPullRequest.findFirst({
      where: { organizationId: placement.organizationId, id: pull.id },
      select: {
        id: true,
        number: true,
        headSha: true,
        detailsSha: true,
        detailsFetchedAt: true,
        state: true,
        requestedReviewers: true,
      },
    });
    if (
      fresh !== null &&
      fresh.state === 'OPEN' &&
      ((reviewEvent && !detailsCoverDelivery(fresh, receivedAt)) || outcome !== 'unchanged' || detailsOutdated(fresh))
    ) {
      await refreshPullDetails(this.db, client, placement, fresh, this.now);
    }
    switch (outcome) {
      case 'created':
        return 'pull_created';
      case 'updated':
        return 'pull_updated';
      case 'stale':
        return 'pull_stale';
      default:
        return 'pull_unchanged';
    }
  }
}
