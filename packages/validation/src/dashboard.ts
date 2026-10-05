import { z } from 'zod';

import { csvEnum } from './projects.js';
import { cursorSchema, dataResponseSchema, isoDateTimeSchema } from './pagination.js';

const isoDateSchema = z.iso.date();
const projectHealthSchema = z.enum(['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL']);
const projectStatusSchema = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED', 'ARCHIVED']);

/**
 * Where a number leads (ROADMAP P8-1 "filter descriptor"): an app path plus the list filters that
 * reproduce exactly the rows the number counts. The web app turns it into a URL.
 */
export const dashboardLinkSchema = z.strictObject({
  path: z.string(),
  query: z.record(z.string(), z.string()),
  hash: z.string().nullable(),
});

/** One count and its deep link (null when no list reproduces it). */
export const dashboardMetricSchema = z.strictObject({
  value: z.number().int().min(0),
  link: dashboardLinkSchema.nullable(),
});

// ---- Sections ----

export const attendanceTodaySectionSchema = z.strictObject({
  /** The organization's local date. */
  date: isoDateSchema,
  timeZone: z.string(),
  /** Employees in scope who are not terminated. */
  employees: dashboardMetricSchema,
  /** Checked in today (open, complete or missing check-out), any mode. */
  present: dashboardMetricSchema,
  /** Present with mode REMOTE. */
  remote: dashboardMetricSchema,
  onLeave: dashboardMetricSchema,
  onMission: dashboardMetricSchema,
  /** Present and checked in after the shift start plus grace. */
  late: dashboardMetricSchema,
  /** Scheduled today, no leave or mission, no check-in yet (or absent after the shift end). */
  notCheckedIn: dashboardMetricSchema,
  missingCheckout: dashboardMetricSchema,
  /** Check-ins waiting for the caller's review; null without review rights. */
  pendingReviews: dashboardMetricSchema.nullable(),
  /** The scope exceeded the bounded evaluation size; counts cover the first employees by name. */
  truncated: z.boolean(),
});

export const supportSectionSchema = z.strictObject({
  open: dashboardMetricSchema,
  new: dashboardMetricSchema,
  /** Open tickets assigned to the caller; null for members who do not work tickets. */
  assignedToMe: dashboardMetricSchema.nullable(),
  critical: dashboardMetricSchema,
  slaAtRisk: dashboardMetricSchema,
  slaBreached: dashboardMetricSchema,
  escalated: dashboardMetricSchema,
  waitingForDevelopment: dashboardMetricSchema,
  waitingForCustomer: dashboardMetricSchema,
  /** Resolved since the start of the organization's local day. */
  resolvedToday: dashboardMetricSchema,
});

export const projectWatchItemSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: projectStatusSchema,
  health: projectHealthSchema,
  healthChangedAt: isoDateTimeSchema.nullable(),
  openTickets: z.number().int(),
  criticalTickets: z.number().int(),
  slaRiskTickets: z.number().int(),
  /** Past-due reports today; null when the caller cannot view the project's daily reports. */
  missingReportsToday: z.number().int().nullable(),
  link: dashboardLinkSchema,
});

export const projectsSectionSchema = z.strictObject({
  /** Projects in scope that are not completed or archived. */
  active: dashboardMetricSchema,
  healthy: dashboardMetricSchema,
  needsAttention: dashboardMetricSchema,
  atRisk: dashboardMetricSchema,
  critical: dashboardMetricSchema,
  /** Past-due daily reports today across projects whose reports the caller may view. */
  missingReportsToday: z.number().int(),
  /** Non-healthy projects first (critical, at risk, needs attention), then by name; at most 10. */
  watchlist: z.array(projectWatchItemSchema),
});

export const integrationFreshnessSchema = z.strictObject({
  status: z.enum(['NOT_CONNECTED', 'ACTIVE', 'NEEDS_ATTENTION']),
  lastSyncAt: isoDateTimeSchema.nullable(),
  /** No successful sync within the freshness window (cached data may be out of date). */
  stale: z.boolean(),
});

const projectRefShape = { projectId: z.uuid(), code: z.string(), name: z.string() };

export const dashboardJiraProjectSchema = z.strictObject({
  ...projectRefShape,
  open: z.number().int(),
  blocked: z.number().int(),
  overdue: z.number().int(),
  /** The project's Jira tab. */
  link: dashboardLinkSchema,
});

export const dashboardJiraSignalsSchema = z.strictObject({
  freshness: integrationFreshnessSchema,
  open: z.number().int(),
  blocked: z.number().int(),
  overdue: z.number().int(),
  /** Projects with at least one open issue; the totals are the sums over all projects in scope. */
  projects: z.array(dashboardJiraProjectSchema),
});

export const dashboardGithubProjectSchema = z.strictObject({
  ...projectRefShape,
  open: z.number().int(),
  awaitingReview: z.number().int(),
  changesRequested: z.number().int(),
  failingChecks: z.number().int(),
  /** The project's GitHub tab. */
  link: dashboardLinkSchema,
});

export const dashboardGithubSignalsSchema = z.strictObject({
  freshness: integrationFreshnessSchema,
  open: z.number().int(),
  awaitingReview: z.number().int(),
  changesRequested: z.number().int(),
  failingChecks: z.number().int(),
  /** Projects with at least one open pull request; totals count each pull request once. */
  projects: z.array(dashboardGithubProjectSchema),
});

export const developmentSectionSchema = z.strictObject({
  /** Null without `jira.view` on any project. */
  jira: dashboardJiraSignalsSchema.nullable(),
  /** Null without `github.view` on any project. */
  github: dashboardGithubSignalsSchema.nullable(),
});

export const approvalsSectionSchema = z.strictObject({
  waiting: dashboardMetricSchema,
  overdue: dashboardMetricSchema,
});

export const myProjectSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: projectStatusSchema,
  health: projectHealthSchema,
  link: dashboardLinkSchema,
});

export const dailyReportDueSchema = z.strictObject({
  projectId: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** The project's local date the report is for. */
  date: isoDateSchema,
  /** The due time has passed. */
  overdue: z.boolean(),
  link: dashboardLinkSchema,
});

export const meDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  /** Null without `request.approve`. */
  approvals: approvalsSectionSchema.nullable(),
  /** The caller's own requests waiting for approval. */
  myPendingRequests: dashboardMetricSchema,
  /** Open tickets the caller reported. */
  myOpenTickets: dashboardMetricSchema,
  /** Open tickets assigned to the caller; null for members who do not work tickets. */
  assignedTickets: dashboardMetricSchema.nullable(),
  /** Active projects the caller staffs (at most 5). */
  projects: z.array(myProjectSchema),
  /** Today's daily reports the caller still owes; empty when none are expected. */
  dailyReportsDue: z.array(dailyReportDueSchema),
  unreadNotifications: z.number().int(),
});

export const teamDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  attendance: attendanceTodaySectionSchema,
});

export const supportDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  support: supportSectionSchema,
});

export const projectsDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  projects: projectsSectionSchema,
  development: developmentSectionSchema,
});

/** Phase 10 tender pipeline numbers in the caller's `tender.view` scope (ADR-0026). */
export const tenderMetricsSchema = z.strictObject({
  active: dashboardMetricSchema,
  closingIn7Days: dashboardMetricSchema,
  closingIn30Days: dashboardMetricSchema,
  /** Preparing or in internal review with mandatory requirements still missing. */
  notReady: dashboardMetricSchema,
  awaitingFinalApproval: dashboardMetricSchema,
  submittedThisMonth: dashboardMetricSchema,
  awardedYtd: dashboardMetricSchema,
  lostYtd: dashboardMetricSchema,
});

export const contractMetricsSchema = z.strictObject({
  active: dashboardMetricSchema,
  expiringIn90Days: dashboardMetricSchema,
  renewalRequired: dashboardMetricSchema,
  noticeApproaching: dashboardMetricSchema,
  withOverdueObligations: dashboardMetricSchema,
  withOverdueMilestones: dashboardMetricSchema,
  expiringGuarantees: dashboardMetricSchema,
  atRisk: dashboardMetricSchema,
});

export const commercialSectionSchema = z.strictObject({
  /** Null without `tender.view`. */
  tenders: tenderMetricsSchema.nullable(),
  /** Null without `contract.view`. */
  contracts: contractMetricsSchema.nullable(),
  /**
   * Total current value of active contracts per currency (never converted); null without
   * `contract.financial.view`. Covers contracts visible under both permissions.
   */
  activeContractValue: z.array(z.strictObject({ currency: z.string(), amount: z.string() })).nullable(),
  /** Corporate documents expiring within the reminder window / expired; null without `corporate_document.view`. */
  documents: z.strictObject({ expiring: dashboardMetricSchema, expired: dashboardMetricSchema }).nullable(),
});

export const commercialDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  commercial: commercialSectionSchema,
});

export const executiveDashboardSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  /** Each section is null when the caller lacks its permission. */
  today: attendanceTodaySectionSchema.nullable(),
  projects: projectsSectionSchema.nullable(),
  support: supportSectionSchema.nullable(),
  development: developmentSectionSchema,
  /** Null without any commercial view permission. */
  commercial: commercialSectionSchema.nullable(),
});

export const meDashboardResponseSchema = dataResponseSchema(meDashboardSchema);
export const teamDashboardResponseSchema = dataResponseSchema(teamDashboardSchema);
export const supportDashboardResponseSchema = dataResponseSchema(supportDashboardSchema);
export const projectsDashboardResponseSchema = dataResponseSchema(projectsDashboardSchema);
export const executiveDashboardResponseSchema = dataResponseSchema(executiveDashboardSchema);
export const commercialDashboardResponseSchema = dataResponseSchema(commercialDashboardSchema);

// ---- Needs Attention ----

export const attentionSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export const attentionTypeSchema = z.enum([
  'TICKET_SLA_BREACHED',
  'TICKET_CRITICAL_UNASSIGNED',
  'TICKET_SLA_AT_RISK',
  'PROJECT_CRITICAL',
  'PROJECT_AT_RISK',
  'APPROVAL_OVERDUE',
  'APPROVAL_WAITING',
  'ATTENDANCE_MISSING_CHECKOUT',
  'ATTENDANCE_REVIEWS_WAITING',
  'DAILY_REPORT_DUE',
  'REQUESTS_AWAITING_FULFILLMENT',
  'JIRA_CONNECTION_PROBLEM',
  'GITHUB_CONNECTION_PROBLEM',
  'TENDER_DEADLINE_AT_RISK',
  'TENDER_FINAL_APPROVAL',
  'TENDER_REVIEW_WAITING',
  'TENDER_REQUIREMENT_OVERDUE',
  'CONTRACT_NOTICE_DEADLINE',
  'CONTRACT_RENEWAL_DECISION',
  'CONTRACT_EXPIRING',
  'OBLIGATION_OVERDUE',
  'MILESTONE_OVERDUE',
  'GUARANTEE_EXPIRING',
  'GUARANTEE_EXPIRED',
  'AMENDMENT_APPROVAL_WAITING',
  'CORPORATE_DOCUMENT_EXPIRING',
]);
export const attentionScopeSchema = z.enum(['SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG']);

export const attentionItemSchema = z.strictObject({
  /** Stable identity (`type:entityId`), also the deduplication key's tie-breaker. */
  key: z.string(),
  type: attentionTypeSchema,
  severity: attentionSeveritySchema,
  /** i18n parameters for the localized title and reason (no free text from other members). */
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  entity: z.strictObject({ type: z.string(), id: z.string() }),
  /** When the condition started (breach, assignment, health change, ...). */
  occurredAt: isoDateTimeSchema,
  link: dashboardLinkSchema,
  /** The authorization scope that made the item visible. */
  scope: attentionScopeSchema,
});

export const needsAttentionSchema = z.strictObject({
  generatedAt: isoDateTimeSchema,
  items: z.array(attentionItemSchema),
  /** Items before the cap. */
  total: z.number().int(),
  truncated: z.boolean(),
});
export const needsAttentionResponseSchema = dataResponseSchema(needsAttentionSchema);

// ---- Trends ----

export const trendMetricSchema = z.enum(['support_flow', 'attendance_presence']);
export const trendRangeSchema = z.enum(['today', '7d', '30d', '90d']);

export const trendQuerySchema = z.strictObject({
  metric: trendMetricSchema,
  range: trendRangeSchema.optional(),
});

export const trendSchema = z.strictObject({
  metric: trendMetricSchema,
  range: trendRangeSchema,
  timeZone: z.string(),
  /** Local dates, oldest first; one bucket per day. */
  dates: z.array(isoDateSchema),
  /** `support_flow`: created, resolved. `attendance_presence`: present. Same length as `dates`. */
  series: z.array(z.strictObject({ key: z.string(), values: z.array(z.number().int()) })),
  /** The row cap was reached; the oldest buckets may be incomplete. */
  truncated: z.boolean(),
  generatedAt: isoDateTimeSchema,
});
export const trendResponseSchema = dataResponseSchema(trendSchema);

// ---- Global search ----

export const searchTypeSchema = z.enum([
  'projects',
  'employees',
  'tickets',
  'requests',
  'jira',
  'tenders',
  'contracts',
  'documents',
  'guarantees',
]);

export const searchQuerySchema = z
  .strictObject({
    /** Normalized on the server; 2-100 characters after normalization. */
    q: z.string().max(200),
    types: csvEnum(searchTypeSchema).optional(),
    /** Results per type (default 5). */
    limit: z.coerce.number().int().min(1).max(10).optional(),
    /** Next page within a single type (requires exactly one type). */
    cursor: cursorSchema.optional(),
    /** Language of request type names in results. */
    locale: z.enum(['en', 'ar']).optional(),
  })
  .refine((value) => value.cursor === undefined || value.types?.length === 1, {
    message: 'cursor requires exactly one type',
    path: ['cursor'],
  });

export const searchResultSchema = z.strictObject({
  id: z.string(),
  /** Display key (`SUP-12`, `REQ-7`, `ABC-123`, `EMP-00012`, project code). */
  key: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  link: dashboardLinkSchema,
});

export const searchGroupSchema = z.strictObject({
  type: searchTypeSchema,
  items: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
});

export const searchResponseSchema = dataResponseSchema(
  z.strictObject({ query: z.string(), groups: z.array(searchGroupSchema) }),
);

// ---- Setup checklist ----

export const setupItemKeySchema = z.enum([
  'organization',
  'departments',
  'employees',
  'work_locations',
  'attendance_policy',
  'request_types',
  'sla',
  'projects',
  'jira',
  'github',
]);

export const setupChecklistSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      key: setupItemKeySchema,
      done: z.boolean(),
      optional: z.boolean(),
      /** The count the state was derived from (departments, invited members, ...). */
      count: z.number().int(),
      link: dashboardLinkSchema,
    }),
  ),
  completed: z.number().int(),
  /** Required items only. */
  required: z.number().int(),
});
export const setupChecklistResponseSchema = dataResponseSchema(setupChecklistSchema);

// ---- Notification preferences ----

export const notificationCategorySchema = z.enum([
  'ACCESS',
  'PROJECTS',
  'DAILY_REPORTS',
  'SUPPORT',
  'REQUESTS',
  'ATTENDANCE',
  'INTEGRATIONS',
  'COMMERCIAL',
]);
export const notificationPreferenceChannelSchema = z.enum(['IN_APP', 'EMAIL']);

export const notificationPreferencesSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      category: notificationCategorySchema,
      inApp: z.boolean(),
      email: z.boolean(),
      inAppLocked: z.boolean(),
      emailLocked: z.boolean(),
    }),
  ),
});
export const notificationPreferencesResponseSchema = dataResponseSchema(notificationPreferencesSchema);

export const updateNotificationPreferencesSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        category: notificationCategorySchema,
        channel: notificationPreferenceChannelSchema,
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(16),
});

export type DashboardLink = z.infer<typeof dashboardLinkSchema>;
export type DashboardMetric = z.infer<typeof dashboardMetricSchema>;
export type TrendQuery = z.infer<typeof trendQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>;
