import { z } from 'zod';

import {
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

/**
 * Jira Cloud integration contracts (INTEGRATIONS §1.9, ADR-0019). Responses never contain tokens,
 * authorization codes or webhook payloads; error details carry codes and field names only.
 */

export const jiraConnectionStatusSchema = z.enum(['ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'DISCONNECTED']);
export const jiraImportStateSchema = z.enum(['NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED']);
export const jiraStatusCategorySchema = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);
export const jiraSyncRunTypeSchema = z.enum([
  'INITIAL_IMPORT',
  'RECONCILIATION',
  'DEEP_RECONCILIATION',
  'MANUAL_RESYNC',
]);
export const jiraSyncRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIALLY_FAILED',
  'FAILED',
  'CANCELLED',
]);
export const jiraFailureClassSchema = z.enum(['RETRYABLE', 'PERMANENT']);
export const ticketJiraLinkTypeSchema = z.enum(['CAUSED_BY', 'FIX_TRACKED_BY', 'RELATED']);
export const ticketJiraLinkSourceSchema = z.enum(['LINKED_EXISTING', 'CREATED_FROM_TICKET']);

/** Numeric Jira id (issues, projects, webhooks). */
export const jiraIdSchema = z.string().regex(/^[0-9]{1,20}$/, 'must be a numeric Jira id');

const jiraPersonSchema = z.strictObject({ memberId: z.uuid(), fullName: z.string().nullable() });
const projectRefSchema = z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() });

export const jiraWebhookHealthSchema = z.strictObject({
  state: z.enum(['ACTIVE', 'NOT_REGISTERED', 'ERROR', 'UNSUPPORTED']),
  errorCode: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
});

export const jiraConnectionSchema = z.strictObject({
  id: z.uuid(),
  cloudId: z.string(),
  siteName: z.string(),
  siteUrl: z.string(),
  status: jiraConnectionStatusSchema,
  connectedAt: isoDateTimeSchema,
  connectedBy: jiraPersonSchema.nullable(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: isoDateTimeSchema.nullable(),
  scopes: z.array(z.string()),
  webhook: jiraWebhookHealthSchema,
  version: z.number().int(),
});

export const jiraIntegrationStatusSchema = z.strictObject({
  /** The deployment has Jira OAuth app credentials. */
  configured: z.boolean(),
  redirectUri: z.string().nullable(),
  webhooksSupported: z.boolean(),
  connection: jiraConnectionSchema.nullable(),
});
export const jiraIntegrationStatusResponseSchema = dataResponseSchema(jiraIntegrationStatusSchema);
export const jiraConnectionResponseSchema = dataResponseSchema(jiraConnectionSchema);

export const jiraConnectRequestSchema = z.strictObject({
  /** Re-authorize this connection (same Jira site) instead of connecting a new one. */
  connectionId: z.uuid().optional(),
});
export const jiraConnectResponseSchema = dataResponseSchema(z.strictObject({ authorizeUrl: z.url() }));

/**
 * Query of the OAuth redirect (`GET /integrations/jira/callback`). Atlassian sends `code` and
 * `state`, or `error` (e.g. `access_denied`) when consent was refused. The endpoint always answers
 * with a redirect to the admin page; the outcome is a query flag, never a token.
 */
export const jiraOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(1000).optional(),
});

export const jiraSiteOptionSchema = z.strictObject({
  cloudId: z.string(),
  name: z.string(),
  url: z.string(),
  missingScopes: z.array(z.string()),
});
export const jiraSiteListResponseSchema = listResponseSchema(jiraSiteOptionSchema);
export const jiraGrantParamsSchema = z.strictObject({ grantId: z.uuid() });
export const jiraSelectSiteRequestSchema = z.strictObject({ cloudId: z.string().min(1).max(100) });
export const jiraDisconnectQuerySchema = z.strictObject({ version: z.coerce.number().int().nonnegative() });

export const jiraRunSchema = z.strictObject({
  id: z.uuid(),
  mappingId: z.uuid(),
  project: projectRefSchema,
  jiraProjectKey: z.string(),
  type: jiraSyncRunTypeSchema,
  status: jiraSyncRunStatusSchema,
  cancelRequested: z.boolean(),
  requestedBy: jiraPersonSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  recordsEstimated: z.number().int().nullable(),
  recordsProcessed: z.number().int(),
  recordsCreated: z.number().int(),
  recordsUpdated: z.number().int(),
  recordsUnchanged: z.number().int(),
  recordsFailed: z.number().int(),
  pages: z.number().int(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  /** Machine-readable failure code (e.g. `jira_rate_limited`); never a Jira response body. */
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  resumedFromRunId: z.uuid().nullable(),
  createdAt: isoDateTimeSchema,
});
export const jiraRunResponseSchema = dataResponseSchema(jiraRunSchema);
export const jiraRunPageResponseSchema = pageResponseSchema(jiraRunSchema);

export const jiraRunFailureSchema = z.strictObject({
  id: z.uuid(),
  jiraIssueId: z.string().nullable(),
  errorCode: z.string(),
  classification: jiraFailureClassSchema,
  message: z.string(),
  createdAt: isoDateTimeSchema,
});
export const jiraRunDetailResponseSchema = dataResponseSchema(
  z.strictObject({ run: jiraRunSchema, failures: z.array(jiraRunFailureSchema) }),
);
export const jiraRunListQuerySchema = z.strictObject({
  ...pageQueryShape,
  mappingId: z.uuid().optional(),
  status: jiraSyncRunStatusSchema.optional(),
});
export const jiraRunRequestSchema = z.strictObject({
  type: z.enum(['RECONCILIATION', 'DEEP_RECONCILIATION', 'MANUAL_RESYNC']),
});

export const jiraMappingSchema = z.strictObject({
  id: z.uuid(),
  connectionId: z.uuid(),
  project: projectRefSchema,
  jiraProject: z.strictObject({ id: z.string(), key: z.string(), name: z.string() }),
  syncEnabled: z.boolean(),
  importState: jiraImportStateSchema,
  blockedStatuses: z.array(z.string()),
  lastFullSyncAt: isoDateTimeSchema.nullable(),
  lastReconciledAt: isoDateTimeSchema.nullable(),
  lastDeepReconciledAt: isoDateTimeSchema.nullable(),
  issueCount: z.number().int(),
  lastRun: jiraRunSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
});
export const jiraMappingResponseSchema = dataResponseSchema(jiraMappingSchema);
export const jiraMappingListResponseSchema = listResponseSchema(jiraMappingSchema);

const blockedStatusesSchema = z.array(z.string().trim().min(1).max(100)).max(20);

export const createJiraMappingRequestSchema = z.strictObject({
  projectId: z.uuid(),
  jiraProjectId: jiraIdSchema,
  /** Jira status names treated as "blocked"; empty = any status whose name contains "block". */
  blockedStatuses: blockedStatusesSchema.optional(),
});
export const updateJiraMappingRequestSchema = z
  .strictObject({
    version: z.number().int().nonnegative(),
    syncEnabled: z.boolean().optional(),
    blockedStatuses: blockedStatusesSchema.optional(),
  })
  .refine((value) => value.syncEnabled !== undefined || value.blockedStatuses !== undefined, {
    message: 'Provide at least one change.',
  });
export const jiraVersionQuerySchema = z.strictObject({ version: z.coerce.number().int().nonnegative() });

export const jiraProjectOptionSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  mappedToProjectId: z.uuid().nullable(),
});
export const jiraProjectSearchQuerySchema = z.strictObject({
  q: z.string().max(100).optional(),
  startAt: z.coerce.number().int().min(0).max(10_000).optional(),
});
export const jiraProjectSearchResponseSchema = z.strictObject({
  data: z.array(jiraProjectOptionSchema),
  isLast: z.boolean(),
});

export const jiraDeliveryFailureSchema = z.strictObject({
  id: z.uuid(),
  eventType: z.string(),
  jiraIssueId: z.string().nullable(),
  errorCode: z.string().nullable(),
  retryCount: z.number().int(),
  receivedAt: isoDateTimeSchema,
});
export const jiraDeliveryFailureListResponseSchema = listResponseSchema(jiraDeliveryFailureSchema);

export const jiraIssueSchema = z.strictObject({
  id: z.uuid(),
  jiraIssueId: z.string(),
  key: z.string(),
  summary: z.string(),
  issueType: z.string(),
  statusName: z.string(),
  statusCategory: jiraStatusCategorySchema,
  priorityName: z.string().nullable(),
  assigneeDisplayName: z.string().nullable(),
  dueDate: z.iso.date().nullable(),
  isBlocked: z.boolean(),
  /** Deep link to the issue in Jira. */
  url: z.string(),
  jiraUpdatedAt: isoDateTimeSchema,
  lastSyncedAt: isoDateTimeSchema,
  removedInJira: z.boolean(),
});

export const ticketJiraLinkSchema = z.strictObject({
  id: z.uuid(),
  linkType: ticketJiraLinkTypeSchema,
  createdVia: ticketJiraLinkSourceSchema,
  createdAt: isoDateTimeSchema,
  createdBy: jiraPersonSchema.nullable(),
  issue: jiraIssueSchema,
});
export const ticketJiraLinkResponseSchema = dataResponseSchema(ticketJiraLinkSchema);

export const ticketJiraPanelSchema = z.strictObject({
  visible: z.boolean(),
  available: z.boolean(),
  canLink: z.boolean(),
  canCreate: z.boolean(),
  connectionStatus: z.enum(['ACTIVE', 'NEEDS_REAUTH', 'ERROR']).nullable(),
  mappings: z.array(z.strictObject({ id: z.uuid(), jiraProjectKey: z.string(), jiraProjectName: z.string() })),
  links: z.array(ticketJiraLinkSchema),
});
export const ticketJiraPanelResponseSchema = dataResponseSchema(ticketJiraPanelSchema);

export const ticketJiraSearchQuerySchema = z.strictObject({
  q: z.string().max(100).default(''),
  source: z.enum(['cache', 'jira']).default('cache'),
});
export const ticketJiraSearchResponseSchema = listResponseSchema(jiraIssueSchema.extend({ linked: z.boolean() }));

export const linkJiraIssueRequestSchema = z.strictObject({
  issueId: z.uuid(),
  linkType: ticketJiraLinkTypeSchema.default('RELATED'),
});
export const ticketJiraLinkParamsSchema = z.strictObject({ id: z.uuid(), linkId: z.uuid() });
export const ticketJiraIssueTypesQuerySchema = z.strictObject({ mappingId: z.uuid() });
export const jiraIssueTypeListResponseSchema = listResponseSchema(z.strictObject({ id: z.string(), name: z.string() }));

/**
 * Create a Jira issue from a ticket. Only what the user confirmed is sent: summary and description
 * (prefilled from the ticket, editable), never internal notes or attachments. `Idempotency-Key`
 * makes retries safe.
 */
export const createJiraIssueRequestSchema = z.strictObject({
  mappingId: z.uuid(),
  issueTypeId: jiraIdSchema,
  summary: z.string().trim().min(1).max(255),
  description: z.string().max(10_000).default(''),
  linkType: ticketJiraLinkTypeSchema.default('FIX_TRACKED_BY'),
});

export const jiraProjectSignalsSchema = z.strictObject({
  open: z.number().int(),
  byCategory: z.strictObject({ TODO: z.number().int(), IN_PROGRESS: z.number().int(), DONE: z.number().int() }),
  blocked: z.number().int(),
  overdue: z.number().int(),
  linkedTickets: z.number().int(),
});
export const jiraProjectOverviewSchema = z.strictObject({
  configured: z.boolean(),
  connectionStatus: z.enum(['ACTIVE', 'NEEDS_REAUTH', 'ERROR']).nullable(),
  siteUrl: z.string().nullable(),
  canManage: z.boolean(),
  mappings: z.array(jiraMappingSchema),
  signals: jiraProjectSignalsSchema,
  recentIssues: z.array(jiraIssueSchema),
  needsAttention: z.boolean(),
});
export const jiraProjectOverviewResponseSchema = dataResponseSchema(jiraProjectOverviewSchema);

export const jiraWebhookParamsSchema = z.strictObject({ connectionId: z.uuid() });
/** Acknowledgement of a webhook delivery (202 queued; 200 duplicate or not relevant). */
export const jiraWebhookAckResponseSchema = dataResponseSchema(
  z.strictObject({ outcome: z.enum(['queued', 'duplicate', 'ignored']) }),
);

/** Outbox payloads of the `jira-sync` queue (validated by the worker before use). */
export const jiraSyncRequestedPayloadSchema = z.strictObject({ runId: z.uuid() });
export const jiraWebhookReceivedPayloadSchema = z.strictObject({ deliveryId: z.uuid() });
export const jiraConnectionJobPayloadSchema = z.strictObject({ connectionId: z.uuid() });

/** Error details of Jira errors (`JIRA_UNAVAILABLE`, `JIRA_REQUEST_REJECTED`). */
export const jiraErrorDetailsSchema = z.strictObject({
  retryAfterSeconds: z.number().int().optional(),
  fields: z.array(z.string()).optional(),
});

export type JiraIntegrationStatus = z.infer<typeof jiraIntegrationStatusSchema>;
export type JiraConnection = z.infer<typeof jiraConnectionSchema>;
export type JiraSiteOption = z.infer<typeof jiraSiteOptionSchema>;
export type JiraRun = z.infer<typeof jiraRunSchema>;
export type JiraRunFailure = z.infer<typeof jiraRunFailureSchema>;
export type JiraMapping = z.infer<typeof jiraMappingSchema>;
export type JiraProjectOption = z.infer<typeof jiraProjectOptionSchema>;
export type JiraDeliveryFailure = z.infer<typeof jiraDeliveryFailureSchema>;
export type JiraIssue = z.infer<typeof jiraIssueSchema>;
export type TicketJiraLink = z.infer<typeof ticketJiraLinkSchema>;
export type TicketJiraPanel = z.infer<typeof ticketJiraPanelSchema>;
export type JiraProjectOverview = z.infer<typeof jiraProjectOverviewSchema>;
export type CreateJiraIssueRequest = z.infer<typeof createJiraIssueRequestSchema>;
