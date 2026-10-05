import { z } from 'zod';

import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';
import { csvEnum, projectRoleSchema } from './projects.js';

// ---- Shared enums (mirror the Prisma enums) ----

export const ticketStatusSchema = z.enum([
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
]);
export const ticketSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const ticketPrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);
export const ticketImpactSchema = z.enum(['SINGLE_USER', 'MULTIPLE_USERS', 'SITE', 'ALL_USERS']);
export const ticketSourceSchema = z.enum([
  'FIELD',
  'CUSTOMER_PHONE',
  'CUSTOMER_EMAIL',
  'MONITORING',
  'INTERNAL',
  'OTHER',
]);
export const slaStateSchema = z.enum(['ON_TRACK', 'AT_RISK', 'BREACHED', 'PAUSED', 'MET']);
export const commentVisibilitySchema = z.enum(['PUBLIC_INTERNAL', 'INTERNAL_NOTE']);
export const escalationTriggerSchema = z.enum([
  'RESOLUTION_ELAPSED_PERCENT',
  'UNRESOLVED_AFTER_MINUTES',
  'FIRST_RESPONSE_BREACHED',
]);
export const ticketViewSchema = z.enum([
  'all',
  'open',
  'assigned_to_me',
  'reported_by_me',
  'watching',
  'unassigned',
  'untriaged',
  'critical',
  'sla_risk',
]);
export const ticketSortSchema = z.enum(['createdAt:desc', 'createdAt:asc', 'updatedAt:desc', 'priority:asc']);

const versionSchema = z.number().int().min(1);
const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().min(1).max(1000);
const timeZoneSchema = z.string().trim().min(1).max(64);
const ticketTitleSchema = z.string().trim().min(1).max(200);
const ticketDescriptionSchema = z.string().trim().min(1).max(10_000);
const commentBodySchema = z.string().trim().min(1).max(10_000);
const atLeastOne = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0;

// ---- Tickets ----

const personRefSchema = z.strictObject({ memberId: z.uuid(), name: z.string(), active: z.boolean() });
const namedRefSchema = z.strictObject({ id: z.uuid(), name: z.string() });

export const ticketSlaSchema = z.strictObject({
  policy: namedRefSchema,
  firstResponseDueAt: isoDateTimeSchema.nullable(),
  resolutionDueAt: isoDateTimeSchema.nullable(),
  firstRespondedAt: isoDateTimeSchema.nullable(),
  firstResponseState: slaStateSchema.nullable(),
  resolutionState: slaStateSchema.nullable(),
  /** The clock is stopped (pause status or resolved). */
  paused: z.boolean(),
});

export const ticketSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  /** `SUP-<number>`. */
  key: z.string(),
  title: z.string(),
  status: ticketStatusSchema,
  severity: ticketSeveritySchema,
  priority: ticketPrioritySchema,
  impact: ticketImpactSchema,
  source: ticketSourceSchema,
  project: z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
  category: namedRefSchema.nullable(),
  assignedTeam: namedRefSchema.nullable(),
  assignee: personRefSchema.nullable(),
  reporter: personRefSchema,
  escalationLevel: z.number().int(),
  sla: ticketSlaSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const ticketSchema = ticketSummarySchema.extend({
  description: z.string(),
  component: namedRefSchema.nullable(),
  resolutionNote: z.string().nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  /** Send back with every change (optimistic concurrency); a stale value is `409 VERSION_CONFLICT`. */
  version: z.number().int(),
  watching: z.boolean(),
  watcherCount: z.number().int(),
  /** What the caller may do (UX hints; every action is re-checked by the server). */
  access: z.strictObject({
    canEdit: z.boolean(),
    canClassify: z.boolean(),
    canAssign: z.boolean(),
    canComment: z.boolean(),
    canAddInternalNote: z.boolean(),
    canViewInternalNotes: z.boolean(),
    canWatch: z.boolean(),
    canManageWatchers: z.boolean(),
    canAttach: z.boolean(),
    transitions: z.array(z.strictObject({ to: ticketStatusSchema, noteRequired: z.boolean() })),
  }),
});

export const ticketResponseSchema = dataResponseSchema(ticketSchema);
export const ticketPageResponseSchema = pageResponseSchema(ticketSummarySchema);

export const ticketListQuerySchema = z
  .strictObject({
    view: ticketViewSchema.optional(),
    /** Title text or ticket key (`SUP-12` / `12`). Comments are never searched. */
    q: z.string().trim().min(1).max(100).optional(),
    status: csvEnum(ticketStatusSchema).optional(),
    severity: csvEnum(ticketSeveritySchema).optional(),
    priority: csvEnum(ticketPrioritySchema).optional(),
    slaState: csvEnum(slaStateSchema).optional(),
    projectId: z.uuid().optional(),
    teamId: z.uuid().optional(),
    assigneeMemberId: z.uuid().optional(),
    reporterMemberId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    componentId: z.uuid().optional(),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
    /** Resolution time window (dashboard "resolved today" deep link). */
    resolvedFrom: isoDateTimeSchema.optional(),
    resolvedTo: isoDateTimeSchema.optional(),
    sort: ticketSortSchema.optional(),
    ...pageQueryShape,
  })
  .refine(
    (value) => value.createdFrom === undefined || value.createdTo === undefined || value.createdFrom < value.createdTo,
    { message: 'createdFrom must be before createdTo', path: ['createdTo'] },
  )
  .refine(
    (value) =>
      value.resolvedFrom === undefined || value.resolvedTo === undefined || value.resolvedFrom < value.resolvedTo,
    { message: 'resolvedFrom must be before resolvedTo', path: ['resolvedTo'] },
  );

export const createTicketRequestSchema = z.strictObject({
  title: ticketTitleSchema,
  description: ticketDescriptionSchema,
  severity: ticketSeveritySchema,
  impact: ticketImpactSchema,
  source: ticketSourceSchema.optional(),
  /** Only triagers may set it; otherwise derived from severity. */
  priority: ticketPrioritySchema.optional(),
  projectId: z.uuid().nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  componentId: z.uuid().nullable().optional(),
});

/** `Idempotency-Key` header of `POST /support/tickets` (client-generated UUID). */
export const idempotencyKeySchema = z.uuid();

export const updateTicketRequestSchema = z
  .strictObject({
    title: ticketTitleSchema.optional(),
    description: ticketDescriptionSchema.optional(),
    severity: ticketSeveritySchema.optional(),
    priority: ticketPrioritySchema.optional(),
    impact: ticketImpactSchema.optional(),
    source: ticketSourceSchema.optional(),
    projectId: z.uuid().nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    componentId: z.uuid().nullable().optional(),
    version: versionSchema,
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'at least one field is required');

export const assignTicketRequestSchema = z
  .strictObject({
    teamId: z.uuid().nullable().optional(),
    assigneeMemberId: z.uuid().nullable().optional(),
    version: versionSchema,
  })
  .refine(
    (value) => value.teamId !== undefined || value.assigneeMemberId !== undefined,
    'teamId or assigneeMemberId is required',
  );

export const transitionTicketRequestSchema = z.strictObject({
  to: ticketStatusSchema,
  /** Required to escalate, resolve (public resolution summary), cancel or reopen. */
  note: z.string().trim().max(5000).nullable().optional(),
  version: versionSchema,
});

export const assigneeQuerySchema = z.strictObject({
  teamId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export const ticketPersonListResponseSchema = listResponseSchema(personRefSchema);

export const ticketEventSchema = z.strictObject({
  id: z.uuid(),
  type: z.string(),
  actor: personRefSchema.nullable(),
  from: z.unknown().nullable(),
  to: z.unknown().nullable(),
  metadata: z.unknown(),
  createdAt: isoDateTimeSchema,
});
export const ticketEventPageResponseSchema = pageResponseSchema(ticketEventSchema);
export const ticketPageQuerySchema = z.strictObject({ ...pageQueryShape });

// ---- Comments ----

export const ticketCommentSchema = z.strictObject({
  id: z.uuid(),
  /** Plain text (never rendered as HTML or Markdown). */
  body: z.string(),
  visibility: commentVisibilitySchema,
  author: personRefSchema,
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
  canEdit: z.boolean(),
});
export const ticketCommentResponseSchema = dataResponseSchema(ticketCommentSchema);
export const ticketCommentPageResponseSchema = pageResponseSchema(ticketCommentSchema);
export const createCommentRequestSchema = z.strictObject({
  body: commentBodySchema,
  visibility: commentVisibilitySchema,
});
export const editCommentRequestSchema = z.strictObject({ body: commentBodySchema });
export const commentParamsSchema = z.strictObject({ id: z.uuid(), commentId: z.uuid() });

// ---- Watchers ----

export const ticketWatcherSchema = z.strictObject({ member: personRefSchema, addedAt: isoDateTimeSchema });
export const ticketWatcherListResponseSchema = listResponseSchema(ticketWatcherSchema);
export const addWatcherRequestSchema = z.strictObject({ memberId: z.uuid() });
export const watcherParamsSchema = z.strictObject({ id: z.uuid(), memberId: z.uuid() });

// ---- Project support ----

export const projectSupportSchema = z.strictObject({
  projectId: z.uuid(),
  supportTeam: namedRefSchema.nullable(),
  openCount: z.number().int(),
  criticalOpenCount: z.number().int(),
  slaRiskCount: z.number().int(),
  byStatus: z.partialRecord(ticketStatusSchema, z.number().int()),
  canManageSupportTeam: z.boolean(),
});
export const projectSupportResponseSchema = dataResponseSchema(projectSupportSchema);
export const setProjectSupportTeamRequestSchema = z.strictObject({
  teamId: z.uuid().nullable(),
  version: versionSchema,
});
export const projectSupportTeamResponseSchema = dataResponseSchema(
  z.strictObject({ supportTeam: namedRefSchema.nullable(), version: z.number().int() }),
);

// ---- Configuration ----

export const supportCategorySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export const supportCategoryResponseSchema = dataResponseSchema(supportCategorySchema);
export const supportCategoryListResponseSchema = listResponseSchema(supportCategorySchema);
export const taxonomyListQuerySchema = z.strictObject({
  includeInactive: booleanQuerySchema.optional(),
  projectId: z.uuid().optional(),
});
export const createCategoryRequestSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.nullable().optional(),
  active: z.boolean().optional(),
});
export const updateCategoryRequestSchema = createCategoryRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const supportComponentSchema = supportCategorySchema.extend({
  project: z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
});
export const supportComponentResponseSchema = dataResponseSchema(supportComponentSchema);
export const supportComponentListResponseSchema = listResponseSchema(supportComponentSchema);
export const createComponentRequestSchema = createCategoryRequestSchema.extend({
  /** Null = available to every project. */
  projectId: z.uuid().nullable().optional(),
});
export const updateComponentRequestSchema = createComponentRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24 h)');
export const workingHoursSchema = z
  .array(z.strictObject({ weekday: z.number().int().min(1).max(7), start: localTimeSchema, end: localTimeSchema }))
  .max(7);
const holidaysSchema = z.array(z.iso.date()).max(366);

export const businessCalendarSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** Null = the ticket's project zone, else the organization's. */
  timeZone: z.string().nullable(),
  workingHours: workingHoursSchema,
  holidays: z.array(z.string()),
});
export const businessCalendarResponseSchema = dataResponseSchema(businessCalendarSchema);
export const businessCalendarListResponseSchema = listResponseSchema(businessCalendarSchema);
export const createCalendarRequestSchema = z.strictObject({
  name: nameSchema,
  timeZone: timeZoneSchema.nullable().optional(),
  workingHours: workingHoursSchema.min(1),
  holidays: holidaysSchema.optional(),
});
export const updateCalendarRequestSchema = createCalendarRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const ticketMatchSchema = z.strictObject({
  severities: z.array(ticketSeveritySchema).max(4).optional(),
  priorities: z.array(ticketPrioritySchema).max(4).optional(),
  projectIds: z.array(z.uuid()).max(100).optional(),
  categoryIds: z.array(z.uuid()).max(100).optional(),
});
const ticketMatchViewSchema = z.strictObject({
  severities: z.array(ticketSeveritySchema),
  priorities: z.array(ticketPrioritySchema),
  projectIds: z.array(z.uuid()),
  categoryIds: z.array(z.uuid()),
});
const minutesSchema = z.number().int().min(1).max(525_600);
const pausableStatusSchema = z.enum([
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
]);

export const slaPolicySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  priority: z.number().int(),
  match: ticketMatchViewSchema,
  firstResponseMinutes: z.number().int(),
  resolutionMinutes: z.number().int(),
  atRiskThresholdPercent: z.number().int(),
  /** Set = business-hours clock; null = wall clock. */
  businessCalendar: namedRefSchema.nullable(),
  pauseStatuses: z.array(ticketStatusSchema),
  active: z.boolean(),
});
export const slaPolicyResponseSchema = dataResponseSchema(slaPolicySchema);
export const slaPolicyListResponseSchema = listResponseSchema(slaPolicySchema);
export const createSlaPolicyRequestSchema = z.strictObject({
  name: nameSchema,
  /** Lower = evaluated first; the first active matching policy applies. */
  priority: z.number().int().min(0).max(10_000),
  match: ticketMatchSchema.optional(),
  firstResponseMinutes: minutesSchema,
  resolutionMinutes: minutesSchema,
  atRiskThresholdPercent: z.number().int().min(1).max(99).optional(),
  businessCalendarId: z.uuid().nullable().optional(),
  pauseStatuses: z.array(pausableStatusSchema).max(5).optional(),
  active: z.boolean().optional(),
});
export const updateSlaPolicyRequestSchema = createSlaPolicyRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

const notifySchema = z.strictObject({
  roles: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/))
    .max(20)
    .optional(),
  projectRoles: z.array(projectRoleSchema).max(7).optional(),
  memberIds: z.array(z.uuid()).max(50).optional(),
});
export const escalationRuleSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slaPolicyId: z.uuid().nullable(),
  match: ticketMatchViewSchema,
  level: z.number().int(),
  trigger: escalationTriggerSchema,
  threshold: z.number().int(),
  notify: z.strictObject({
    roles: z.array(z.string()),
    projectRoles: z.array(projectRoleSchema),
    memberIds: z.array(z.uuid()),
  }),
  active: z.boolean(),
});
export const escalationRuleResponseSchema = dataResponseSchema(escalationRuleSchema);
export const escalationRuleListResponseSchema = listResponseSchema(escalationRuleSchema);
export const createEscalationRuleRequestSchema = z.strictObject({
  name: nameSchema,
  /** Null = applies under every policy. */
  slaPolicyId: z.uuid().nullable().optional(),
  match: ticketMatchSchema.optional(),
  level: z.number().int().min(1).max(5),
  trigger: escalationTriggerSchema,
  /** Percent of the resolution target, or minutes, depending on `trigger`. */
  threshold: z.number().int().min(1).max(525_600),
  notify: notifySchema.optional(),
  active: z.boolean().optional(),
});
export const updateEscalationRuleRequestSchema = createEscalationRuleRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketSeverity = z.infer<typeof ticketSeveritySchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type TicketImpact = z.infer<typeof ticketImpactSchema>;
export type TicketSource = z.infer<typeof ticketSourceSchema>;
export type SlaState = z.infer<typeof slaStateSchema>;
export type CommentVisibility = z.infer<typeof commentVisibilitySchema>;
export type TicketQueueView = z.infer<typeof ticketViewSchema>;
export type TicketSummary = z.infer<typeof ticketSummarySchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type CreateTicketRequest = z.infer<typeof createTicketRequestSchema>;
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>;
export type AssignTicketRequest = z.infer<typeof assignTicketRequestSchema>;
export type TransitionTicketRequest = z.infer<typeof transitionTicketRequestSchema>;
export type AssigneeQuery = z.infer<typeof assigneeQuerySchema>;
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export type TicketPageQuery = z.infer<typeof ticketPageQuerySchema>;
export type TicketComment = z.infer<typeof ticketCommentSchema>;
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;
export type EditCommentRequest = z.infer<typeof editCommentRequestSchema>;
export type CommentParams = z.infer<typeof commentParamsSchema>;
export type TicketWatcher = z.infer<typeof ticketWatcherSchema>;
export type AddWatcherRequest = z.infer<typeof addWatcherRequestSchema>;
export type WatcherParams = z.infer<typeof watcherParamsSchema>;
export type ProjectSupport = z.infer<typeof projectSupportSchema>;
export type SetProjectSupportTeamRequest = z.infer<typeof setProjectSupportTeamRequestSchema>;
export type SupportCategory = z.infer<typeof supportCategorySchema>;
export type SupportComponent = z.infer<typeof supportComponentSchema>;
export type TaxonomyListQuery = z.infer<typeof taxonomyListQuerySchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
export type CreateComponentRequest = z.infer<typeof createComponentRequestSchema>;
export type UpdateComponentRequest = z.infer<typeof updateComponentRequestSchema>;
export type BusinessCalendar = z.infer<typeof businessCalendarSchema>;
export type CreateCalendarRequest = z.infer<typeof createCalendarRequestSchema>;
export type UpdateCalendarRequest = z.infer<typeof updateCalendarRequestSchema>;
export type SlaPolicy = z.infer<typeof slaPolicySchema>;
export type CreateSlaPolicyRequest = z.infer<typeof createSlaPolicyRequestSchema>;
export type UpdateSlaPolicyRequest = z.infer<typeof updateSlaPolicyRequestSchema>;
export type EscalationRule = z.infer<typeof escalationRuleSchema>;
export type CreateEscalationRuleRequest = z.infer<typeof createEscalationRuleRequestSchema>;
export type UpdateEscalationRuleRequest = z.infer<typeof updateEscalationRuleRequestSchema>;
