import { z } from 'zod';

import {
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

/**
 * GitHub App integration contracts (INTEGRATIONS §GitHub, ADR-0020). Responses never contain App
 * JWTs, installation tokens, user tokens, private keys, webhook secrets, webhook payloads, source
 * code, diffs or file contents; error details carry codes only.
 */

export const githubInstallationStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'DELETED', 'DISCONNECTED']);
export const githubAccountTypeSchema = z.enum(['ORGANIZATION', 'USER', 'ENTERPRISE']);
export const githubRepositorySelectionSchema = z.enum(['ALL', 'SELECTED']);
export const githubRepositoryStatusSchema = z.enum(['AVAILABLE', 'REMOVED', 'DELETED']);
export const githubSyncStateSchema = z.enum(['NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED']);
export const githubPullRequestStateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED']);
export const githubReviewStateSchema = z.enum(['NONE', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'APPROVED']);
export const githubChecksStateSchema = z.enum(['UNKNOWN', 'PENDING', 'SUCCESS', 'FAILURE']);
export const githubLinkSourceSchema = z.enum(['MANUAL', 'BRANCH_NAME', 'TITLE', 'BODY']);
export const githubLinkStateSchema = z.enum(['SUGGESTED', 'CONFIRMED', 'DISMISSED']);
export const githubDeliveryStatusSchema = z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']);
export const githubSyncRunTypeSchema = z.enum(['INITIAL_SYNC', 'RECONCILIATION', 'MANUAL_RESYNC']);
export const githubSyncRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_FAILED',
  'FAILED',
  'CANCELLED',
]);
export const githubPullSignalSchema = z.enum([
  'DRAFT',
  'AWAITING_REVIEW',
  'CHANGES_REQUESTED',
  'FAILING_CHECKS',
  'STALE_SYNC',
]);
export const githubRepositoryHealthSchema = z.enum([
  'OK',
  'SYNCING',
  'NOT_SYNCED',
  'STALE',
  'FAILED',
  'UNAVAILABLE',
  'SUSPENDED',
]);

const personSchema = z.strictObject({ memberId: z.uuid(), fullName: z.string().nullable() });
const projectRefSchema = z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() });

export const githubInstallationSchema = z.strictObject({
  id: z.uuid(),
  githubInstallationId: z.string(),
  accountLogin: z.string(),
  accountType: githubAccountTypeSchema,
  repositorySelection: githubRepositorySelectionSchema,
  permissions: z.record(z.string(), z.string()),
  missingPermissions: z.array(z.string()),
  events: z.array(z.string()),
  status: githubInstallationStatusSchema,
  suspendedAt: isoDateTimeSchema.nullable(),
  boundAt: isoDateTimeSchema,
  installedBy: personSchema.nullable(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: isoDateTimeSchema.nullable(),
  repositoryCount: z.number().int(),
  manageUrl: z.string().nullable(),
  version: z.number().int(),
});
export const githubInstallationResponseSchema = dataResponseSchema(githubInstallationSchema);

export const githubIntegrationStatusSchema = z.strictObject({
  /** The deployment has GitHub App credentials. */
  configured: z.boolean(),
  /** The setup flow is available (App slug and client secret configured). */
  canInstall: z.boolean(),
  webhookUrl: z.string().nullable(),
  setupUrl: z.string().nullable(),
  callbackUrl: z.string().nullable(),
  requiredPermissions: z.record(z.string(), z.string()),
  subscribedEvents: z.array(z.string()),
  installations: z.array(githubInstallationSchema),
});
export const githubIntegrationStatusResponseSchema = dataResponseSchema(githubIntegrationStatusSchema);
export const githubInstallResponseSchema = dataResponseSchema(z.strictObject({ installUrl: z.url() }));

/**
 * Query GitHub appends to the setup URL. `installation_id` is untrusted (anyone can craft it); it
 * only selects which installation the signed-in GitHub user must prove access to.
 */
export const githubSetupQuerySchema = z.object({
  installation_id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .optional(),
  setup_action: z.string().max(40).optional(),
  state: z.string().min(1).max(200).optional(),
});
/** Query of the setup-time user authorization callback. */
export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(1000).optional(),
});

export const githubRunSchema = z.strictObject({
  id: z.uuid(),
  repository: z.strictObject({ id: z.uuid(), fullName: z.string() }),
  type: githubSyncRunTypeSchema,
  status: githubSyncRunStatusSchema,
  cancelRequested: z.boolean(),
  requestedBy: personSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  recordsProcessed: z.number().int(),
  recordsCreated: z.number().int(),
  recordsUpdated: z.number().int(),
  recordsUnchanged: z.number().int(),
  recordsFailed: z.number().int(),
  pages: z.number().int(),
  /** Machine-readable failure code (e.g. `github_rate_limited`); never a GitHub response body. */
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export const githubRunResponseSchema = dataResponseSchema(githubRunSchema);
export const githubRunPageResponseSchema = pageResponseSchema(githubRunSchema);
export const githubRunFailureSchema = z.strictObject({
  id: z.uuid(),
  prNumber: z.number().int().nullable(),
  errorCode: z.string(),
  classification: z.enum(['RETRYABLE', 'PERMANENT']),
  message: z.string(),
  createdAt: isoDateTimeSchema,
});
export const githubRunDetailResponseSchema = dataResponseSchema(
  z.strictObject({ run: githubRunSchema, failures: z.array(githubRunFailureSchema) }),
);
export const githubRunListQuerySchema = z.strictObject({
  ...pageQueryShape,
  repositoryId: z.uuid().optional(),
  status: githubSyncRunStatusSchema.optional(),
});

export const githubMappingSchema = z.strictObject({
  id: z.uuid(),
  project: projectRefSchema,
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
});

export const githubRepositorySchema = z.strictObject({
  id: z.uuid(),
  installationId: z.uuid(),
  githubRepoId: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  htmlUrl: z.string(),
  defaultBranch: z.string().nullable(),
  status: githubRepositoryStatusSchema,
  unavailableAt: isoDateTimeSchema.nullable(),
  syncState: githubSyncStateSchema,
  lastFullSyncAt: isoDateTimeSchema.nullable(),
  lastReconciledAt: isoDateTimeSchema.nullable(),
  openPullCount: z.number().int(),
  mappings: z.array(githubMappingSchema),
  lastRun: githubRunSchema.nullable(),
});
export const githubRepositoryResponseSchema = dataResponseSchema(githubRepositorySchema);
export const githubRepositoryListResponseSchema = listResponseSchema(githubRepositorySchema);
export const githubRepositoryListQuerySchema = z.strictObject({
  installationId: z.uuid().optional(),
  includeUnavailable: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export const createGithubMappingRequestSchema = z.strictObject({ repositoryId: z.uuid(), projectId: z.uuid() });
export const githubVersionQuerySchema = z.strictObject({ version: z.coerce.number().int().nonnegative() });

export const githubDeliverySchema = z.strictObject({
  id: z.uuid(),
  deliveryId: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  status: githubDeliveryStatusSchema,
  outcome: z.string().nullable(),
  errorCode: z.string().nullable(),
  receivedAt: isoDateTimeSchema,
  processedAt: isoDateTimeSchema.nullable(),
});
export const githubDeliveryPageResponseSchema = pageResponseSchema(githubDeliverySchema);
export const githubDeliveryListQuerySchema = z.strictObject({
  ...pageQueryShape,
  status: githubDeliveryStatusSchema.optional(),
});

export const githubPrJiraLinkSchema = z.strictObject({
  id: z.uuid(),
  state: githubLinkStateSchema,
  source: githubLinkSourceSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  issue: z.strictObject({
    id: z.uuid(),
    key: z.string(),
    summary: z.string(),
    statusName: z.string(),
    statusCategory: z.enum(['TODO', 'IN_PROGRESS', 'DONE']),
    url: z.string(),
    projectId: z.uuid().nullable(),
  }),
});

export const githubPullSchema = z.strictObject({
  id: z.uuid(),
  repository: z.strictObject({ id: z.uuid(), fullName: z.string() }),
  number: z.number().int(),
  title: z.string(),
  /** Deep link to the pull request on GitHub. */
  url: z.string(),
  state: githubPullRequestStateSchema,
  draft: z.boolean(),
  authorLogin: z.string().nullable(),
  headRef: z.string(),
  baseRef: z.string(),
  reviewState: githubReviewStateSchema,
  requestedReviewerCount: z.number().int(),
  checksState: githubChecksStateSchema,
  checksTotal: z.number().int(),
  checksFailed: z.number().int(),
  checksPending: z.number().int(),
  ghCreatedAt: isoDateTimeSchema,
  ghUpdatedAt: isoDateTimeSchema,
  mergedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  lastSyncedAt: isoDateTimeSchema,
  signals: z.array(githubPullSignalSchema),
  jiraLinks: z.array(githubPrJiraLinkSchema),
  unverifiedKeys: z.array(z.string()),
});
export const githubPullResponseSchema = dataResponseSchema(githubPullSchema);
export const githubPullPageResponseSchema = pageResponseSchema(githubPullSchema);
export const githubPullListQuerySchema = z.strictObject({
  ...pageQueryShape,
  state: githubPullRequestStateSchema.optional(),
  repositoryId: z.uuid().optional(),
});

export const githubProjectRepositorySchema = z.strictObject({
  id: z.uuid(),
  mappingId: z.uuid(),
  fullName: z.string(),
  htmlUrl: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  status: githubRepositoryStatusSchema,
  syncState: githubSyncStateSchema,
  lastSyncedAt: isoDateTimeSchema.nullable(),
  openPullCount: z.number().int(),
  health: githubRepositoryHealthSchema,
});
export const githubProjectOverviewSchema = z.strictObject({
  configured: z.boolean(),
  canManage: z.boolean(),
  canLink: z.boolean(),
  repositories: z.array(githubProjectRepositorySchema),
  signals: z.strictObject({
    open: z.number().int(),
    draft: z.number().int(),
    awaitingReview: z.number().int(),
    changesRequested: z.number().int(),
    failingChecks: z.number().int(),
    staleRepositories: z.number().int(),
  }),
  pulls: z.array(githubPullSchema),
  needsAttention: z.boolean(),
});
export const githubProjectOverviewResponseSchema = dataResponseSchema(githubProjectOverviewSchema);

export const projectPullParamsSchema = z.strictObject({ id: z.uuid(), pullId: z.uuid() });
export const projectPullLinkParamsSchema = z.strictObject({ id: z.uuid(), linkId: z.uuid() });
export const linkPullJiraIssueRequestSchema = z.strictObject({ issueId: z.uuid() });
export const projectJiraIssueSearchQuerySchema = z.strictObject({ q: z.string().max(100).default('') });
export const projectJiraIssueSearchResponseSchema = listResponseSchema(
  z.strictObject({ id: z.uuid(), key: z.string(), summary: z.string(), statusName: z.string(), url: z.string() }),
);

export const ticketPullSchema = githubPullSchema.extend({
  via: z.array(z.enum(['JIRA', 'MANUAL'])),
  ticketLinkId: z.uuid().nullable(),
});
export const ticketGithubPanelSchema = z.strictObject({
  visible: z.boolean(),
  available: z.boolean(),
  canLink: z.boolean(),
  pulls: z.array(ticketPullSchema),
});
export const ticketGithubPanelResponseSchema = dataResponseSchema(ticketGithubPanelSchema);
export const ticketPullSearchQuerySchema = z.strictObject({ q: z.string().max(100).default('') });
export const ticketPullSearchResponseSchema = listResponseSchema(
  z.strictObject({
    id: z.uuid(),
    repository: z.string(),
    number: z.number().int(),
    title: z.string(),
    state: githubPullRequestStateSchema,
    linked: z.boolean(),
  }),
);
export const linkTicketPullRequestSchema = z.strictObject({ pullRequestId: z.uuid() });
export const ticketPullLinkParamsSchema = z.strictObject({ id: z.uuid(), linkId: z.uuid() });

/** Acknowledgement of a webhook delivery (202 queued; 200 duplicate or not relevant). */
export const githubWebhookAckResponseSchema = dataResponseSchema(
  z.strictObject({ outcome: z.enum(['queued', 'duplicate', 'ignored']) }),
);

/** Outbox payloads of the `github-sync` queue (validated by the worker before use). */
export const githubSyncRequestedPayloadSchema = z.strictObject({ runId: z.uuid() });
export const githubWebhookReceivedPayloadSchema = z.strictObject({ deliveryId: z.uuid() });
export const githubInstallationSyncPayloadSchema = z.strictObject({ installationId: z.uuid() });

/**
 * Retention (ADR-0020, ADR-0022): technical integration records are deleted; attendance coordinates are
 * cleared (events are kept). `ATTENDANCE_COORDINATES` needs at least 30 days (checked by the service).
 */
export const retentionCategorySchema = z.enum(['WEBHOOK_DELIVERIES', 'SYNC_FAILURES', 'ATTENDANCE_COORDINATES']);
export const retentionPolicySchema = z.strictObject({
  category: retentionCategorySchema,
  retainDays: z.number().int().nullable(),
  configuredAt: isoDateTimeSchema.nullable(),
  configuredBy: personSchema.nullable(),
  lastPurgedAt: isoDateTimeSchema.nullable(),
  lastPurgedCount: z.number().int().nullable(),
  version: z.number().int().nullable(),
});
export const retentionPolicyListResponseSchema = listResponseSchema(retentionPolicySchema);
export const retentionCategoryParamsSchema = z.strictObject({ category: retentionCategorySchema });
export const setRetentionPolicyRequestSchema = z.strictObject({
  retainDays: z.number().int().min(7).max(3650),
  /** Null creates the policy; otherwise the current version (optimistic concurrency). */
  version: z.number().int().nonnegative().nullable(),
});
export const retentionPreviewQuerySchema = z.strictObject({
  retainDays: z.coerce.number().int().min(7).max(3650),
});
/** Dry run: how many records a policy of `retainDays` would remove now (nothing is deleted). */
export const retentionPreviewSchema = z.strictObject({
  category: retentionCategorySchema,
  retainDays: z.number().int(),
  eligible: z.number().int().nonnegative(),
});
export const retentionPreviewResponseSchema = dataResponseSchema(retentionPreviewSchema);

export type GithubIntegrationStatus = z.infer<typeof githubIntegrationStatusSchema>;
export type GithubInstallation = z.infer<typeof githubInstallationSchema>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type GithubRun = z.infer<typeof githubRunSchema>;
export type GithubRunFailure = z.infer<typeof githubRunFailureSchema>;
export type GithubDelivery = z.infer<typeof githubDeliverySchema>;
export type GithubPull = z.infer<typeof githubPullSchema>;
export type GithubPrJiraLink = z.infer<typeof githubPrJiraLinkSchema>;
export type GithubProjectOverview = z.infer<typeof githubProjectOverviewSchema>;
export type TicketGithubPanel = z.infer<typeof ticketGithubPanelSchema>;
export type TicketPull = z.infer<typeof ticketPullSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;
