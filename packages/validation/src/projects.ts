import { z } from 'zod';

import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

// ---- Shared enums (mirror the Prisma enums) ----

export const projectStatusSchema = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED', 'ARCHIVED']);
/** Statuses reachable through `PUT /projects/:id/status`; ARCHIVED only through archive/restore. */
export const settableProjectStatusSchema = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED']);
export const projectHealthSchema = z.enum(['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL']);
export const projectRoleSchema = z.enum([
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'DEVELOPER',
  'SUPPORT',
  'FIELD',
  'QA',
  'OBSERVER',
]);
export const customerTypeSchema = z.enum(['GOVERNMENT', 'PRIVATE', 'INTERNAL']);
export const workLocationTypeSchema = z.enum(['OFFICE', 'CUSTOMER_SITE', 'PROJECT_SITE', 'OTHER']);
export const dailyReportStatusSchema = z.enum(['NORMAL', 'DEGRADED', 'ISSUE', 'CRITICAL']);
export const activitySourceSchema = z.enum(['SUPPORT', 'JIRA', 'GITHUB', 'DAILY_REPORT', 'PROJECT', 'REQUEST']);

const memberStatusSchema = z.enum(['INVITED', 'ACTIVE', 'DISABLED']);
const employmentStatusSchema = z.enum(['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED']);
const isoDateSchema = z.iso.date();
const timeZoneSchema = z.string().trim().min(1).max(64);
const versionSchema = z.number().int().min(1);
const longTextSchema = z.string().trim().min(1).max(5000);
const projectCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'letters, digits, "-" and "_" (max 32)');

/** Comma-separated multi-value filter (ARCHITECTURE §8.2), e.g. `status=ACTIVE,ON_HOLD`. */
export function csvEnum<T extends z.ZodEnum>(values: T) {
  const value = values.options.join('|');
  return z
    .string()
    .max(200)
    .regex(new RegExp(`^(${value})(,(${value}))*$`), `comma-separated values of: ${values.options.join(', ')}`)
    .transform((raw) => [
      ...new Set(
        raw.split(',').flatMap((part) => {
          const parsed = values.safeParse(part);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    ]);
}

const atLeastOne = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0;

// ---- Daily-report policy ----

export const dailyReportPolicySchema = z.strictObject({
  required: z.boolean(),
  /** ISO weekdays (1 = Monday ... 7 = Sunday); empty = the organization's work week. */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  /** Local time in the project's zone after which today's report counts as missing. */
  dueLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24 h)'),
  reporterRoles: z.array(projectRoleSchema).min(1).max(7),
});

// ---- Customers ----

export const customerSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  type: customerTypeSchema,
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const customerResponseSchema = dataResponseSchema(customerSchema);
export const customerPageResponseSchema = pageResponseSchema(customerSchema);

export const customerListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  type: customerTypeSchema.optional(),
  includeArchived: booleanQuerySchema.optional(),
  ...pageQueryShape,
});

export const createCustomerRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  type: customerTypeSchema,
  contactName: z.string().trim().min(1).max(200).nullable().optional(),
  contactEmail: z.email().max(254).nullable().optional(),
  notes: longTextSchema.nullable().optional(),
});

export const updateCustomerRequestSchema = createCustomerRequestSchema
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine(atLeastOne, 'at least one field is required');

// ---- Projects ----

const personRefSchema = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  memberStatus: memberStatusSchema,
  employmentStatus: employmentStatusSchema,
});

export const projectSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  code: z.string(),
  name: z.string(),
  customer: z.strictObject({ id: z.uuid(), name: z.string(), archived: z.boolean() }).nullable(),
  status: projectStatusSchema,
  health: projectHealthSchema,
  startDate: isoDateSchema.nullable(),
  targetEndDate: isoDateSchema.nullable(),
  projectManager: personRefSchema.nullable(),
  technicalManager: personRefSchema.nullable(),
  memberCount: z.number().int(),
  updatedAt: isoDateTimeSchema,
});

export const projectSchema = projectSummarySchema.extend({
  description: z.string().nullable(),
  statusReason: z.string().nullable(),
  statusChangedAt: isoDateTimeSchema.nullable(),
  healthNote: z.string().nullable(),
  healthChangedAt: isoDateTimeSchema.nullable(),
  timeZone: z.string().nullable(),
  effectiveTimeZone: z.string(),
  dailyReportPolicy: dailyReportPolicySchema,
  notes: z.string().nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  /** Send back with every change (optimistic concurrency); a stale value is `409 VERSION_CONFLICT`. */
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  /** What the caller may do (UX hints; every action is re-checked by the server). */
  access: z.strictObject({
    canManage: z.boolean(),
    canAssignMembers: z.boolean(),
    canAssignManagers: z.boolean(),
    canArchive: z.boolean(),
    canViewReports: z.boolean(),
    canSubmitReports: z.boolean(),
  }),
});

export const projectResponseSchema = dataResponseSchema(projectSchema);
export const projectPageResponseSchema = pageResponseSchema(projectSummarySchema);

export const projectSortSchema = z.enum([
  'updatedAt:desc',
  'createdAt:desc',
  'name:asc',
  'name:desc',
  'code:asc',
  'code:desc',
]);

export const projectListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  status: csvEnum(projectStatusSchema).optional(),
  health: csvEnum(projectHealthSchema).optional(),
  customerId: z.uuid().optional(),
  /** Employee id of the project manager or technical manager. */
  managerId: z.uuid().optional(),
  /** `mine` = projects the caller is assigned to. */
  scope: z.enum(['all', 'mine']).optional(),
  includeArchived: booleanQuerySchema.optional(),
  sort: projectSortSchema.optional(),
  ...pageQueryShape,
});

const projectDetailsShape = {
  name: z.string().trim().min(1).max(200),
  code: projectCodeSchema.optional(),
  description: longTextSchema.nullable().optional(),
  customerId: z.uuid().nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  targetEndDate: isoDateSchema.nullable().optional(),
  projectManagerId: z.uuid().nullable().optional(),
  technicalManagerId: z.uuid().nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  notes: longTextSchema.nullable().optional(),
  dailyReportPolicy: dailyReportPolicySchema.optional(),
};

export const createProjectRequestSchema = z.strictObject(projectDetailsShape);

export const updateProjectRequestSchema = z
  .strictObject({ ...projectDetailsShape, name: projectDetailsShape.name.optional(), version: versionSchema })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'at least one field is required');

export const setProjectStatusRequestSchema = z.strictObject({
  status: settableProjectStatusSchema,
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  version: versionSchema,
});

export const setProjectHealthRequestSchema = z.strictObject({
  health: projectHealthSchema,
  /** Health is set manually and always explained. */
  note: z.string().trim().min(1).max(1000),
  version: versionSchema,
});

export const archiveProjectRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  version: versionSchema,
});

export const restoreProjectRequestSchema = z.strictObject({ version: versionSchema });

export const employeeProjectSchema = z.strictObject({
  project: projectSummarySchema,
  roles: z.array(projectRoleSchema),
});
export const employeeProjectListResponseSchema = listResponseSchema(employeeProjectSchema);

// ---- Project members ----

export const projectMemberSchema = z.strictObject({
  employeeId: z.uuid(),
  fullName: z.string(),
  employeeNumber: z.string(),
  jobTitle: z.string().nullable(),
  memberStatus: memberStatusSchema,
  employmentStatus: employmentStatusSchema,
  projectRole: projectRoleSchema,
  allocationPercent: z.number().int().nullable(),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  addedAt: isoDateTimeSchema,
});

export const projectMemberResponseSchema = dataResponseSchema(projectMemberSchema);
export const projectMemberListResponseSchema = listResponseSchema(projectMemberSchema);
export const projectMemberParamsSchema = z.strictObject({ id: z.uuid(), employeeId: z.uuid() });

const memberDetailsShape = {
  allocationPercent: z.number().int().min(1).max(100).nullable().optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.nullable().optional(),
};

export const addProjectMemberRequestSchema = z.strictObject({
  employeeId: z.uuid(),
  projectRole: projectRoleSchema,
  ...memberDetailsShape,
});

export const updateProjectMemberRequestSchema = z
  .strictObject({ projectRole: projectRoleSchema.optional(), ...memberDetailsShape })
  .refine(atLeastOne, 'at least one field is required');

// ---- Work locations ----

export const workLocationSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  type: workLocationTypeSchema,
  latitude: z.number(),
  longitude: z.number(),
  allowedRadiusMeters: z.number().int(),
  address: z.string().nullable(),
  timeZone: z.string().nullable(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const workLocationResponseSchema = dataResponseSchema(workLocationSchema);
export const workLocationListResponseSchema = listResponseSchema(workLocationSchema);

export const workLocationListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  includeInactive: booleanQuerySchema.optional(),
});

export const createWorkLocationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  type: workLocationTypeSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  allowedRadiusMeters: z.number().int().min(10).max(5000),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  active: z.boolean().optional(),
});

export const updateWorkLocationRequestSchema = createWorkLocationRequestSchema
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const projectLocationSchema = z.strictObject({
  location: workLocationSchema,
  linkedAt: isoDateTimeSchema,
});
export const projectLocationResponseSchema = dataResponseSchema(projectLocationSchema);
export const projectLocationListResponseSchema = listResponseSchema(projectLocationSchema);
export const linkProjectLocationRequestSchema = z.strictObject({ workLocationId: z.uuid() });
export const projectLocationParamsSchema = z.strictObject({ id: z.uuid(), locationId: z.uuid() });

// ---- Daily reports ----

const reporterSchema = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  memberStatus: memberStatusSchema,
  employmentStatus: employmentStatusSchema,
});

export const dailyReportSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  projectId: z.uuid(),
  /** Business date in the project's time zone. */
  reportDate: isoDateSchema,
  systemStatus: dailyReportStatusSchema,
  followUpRequired: z.boolean(),
  reporter: reporterSchema,
  submittedAt: isoDateTimeSchema,
});

export const dailyReportSchema = dailyReportSummarySchema.extend({
  project: z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() }),
  workPerformed: z.string(),
  operationalNotes: z.string().nullable(),
  customerNotes: z.string().nullable(),
  problems: z.string().nullable(),
  followUpNotes: z.string().nullable(),
  processedRequestsCount: z.number().int().nullable(),
  failedRequestsCount: z.number().int().nullable(),
  access: z.strictObject({ canAttach: z.boolean(), canDeleteAttachments: z.boolean() }),
});

export const dailyReportResponseSchema = dataResponseSchema(dailyReportSchema);
export const dailyReportPageResponseSchema = pageResponseSchema(dailyReportSummarySchema);

export const dailyReportListQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  reporterId: z.uuid().optional(),
  systemStatus: csvEnum(dailyReportStatusSchema).optional(),
  ...pageQueryShape,
});

const countSchema = z.number().int().min(0).max(1_000_000_000);

export const submitDailyReportRequestSchema = z.strictObject({
  /** Defaults to today in the project's time zone; at most 7 days back, never in the future. */
  reportDate: isoDateSchema.optional(),
  systemStatus: dailyReportStatusSchema,
  workPerformed: longTextSchema,
  operationalNotes: longTextSchema.nullable().optional(),
  customerNotes: longTextSchema.nullable().optional(),
  problems: longTextSchema.nullable().optional(),
  followUpRequired: z.boolean().optional(),
  followUpNotes: longTextSchema.nullable().optional(),
  processedRequestsCount: countSchema.nullable().optional(),
  failedRequestsCount: countSchema.nullable().optional(),
});

const missingEntrySchema = z.strictObject({
  date: isoDateSchema,
  employee: z.strictObject({ id: z.uuid(), fullName: z.string() }),
});

export const missingReportsSchema = z.strictObject({
  projectId: z.uuid(),
  timeZone: z.string(),
  today: isoDateSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  policy: dailyReportPolicySchema,
  /** False when the project's status does not expect reports. */
  reporting: z.boolean(),
  missing: z.array(missingEntrySchema),
  pendingToday: z.array(missingEntrySchema),
});

export const missingReportsResponseSchema = dataResponseSchema(missingReportsSchema);
export const missingReportsQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

// ---- Project activity ----

export const projectActivitySchema = z.strictObject({
  id: z.uuid(),
  occurredAt: isoDateTimeSchema,
  source: activitySourceSchema,
  /** Stable type key; the web app renders the localized text from `type` + `summaryParams`. */
  type: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  summaryParams: z.record(z.string(), z.unknown()),
  actor: z.strictObject({ memberId: z.uuid(), fullName: z.string().nullable() }).nullable(),
});

export const projectActivityPageResponseSchema = pageResponseSchema(projectActivitySchema);
export const projectActivityQuerySchema = z.strictObject({ ...pageQueryShape });

/**
 * Payload of the `project.activity.recorded` outbox event / `project-activity.record` job. Validated
 * by the worker before use; a payload that fails validation is a permanent job failure.
 */
export const projectActivityRecordedPayloadSchema = z.strictObject({
  projectId: z.uuid(),
  occurredAt: isoDateTimeSchema,
  source: activitySourceSchema,
  type: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
    .max(100),
  entityType: z.string().min(1).max(64),
  entityId: z.string().max(64).nullable(),
  summaryParams: z.record(z.string().max(64), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])),
  actorMemberId: z.uuid().nullable(),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type ProjectHealth = z.infer<typeof projectHealthSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type CustomerType = z.infer<typeof customerTypeSchema>;
export type WorkLocationType = z.infer<typeof workLocationTypeSchema>;
export type DailyReportStatus = z.infer<typeof dailyReportStatusSchema>;
export type DailyReportPolicy = z.infer<typeof dailyReportPolicySchema>;
export type Customer = z.infer<typeof customerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type SetProjectStatusRequest = z.infer<typeof setProjectStatusRequestSchema>;
export type SetProjectHealthRequest = z.infer<typeof setProjectHealthRequestSchema>;
export type ArchiveProjectRequest = z.infer<typeof archiveProjectRequestSchema>;
export type RestoreProjectRequest = z.infer<typeof restoreProjectRequestSchema>;
export type EmployeeProject = z.infer<typeof employeeProjectSchema>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type ProjectMemberParams = z.infer<typeof projectMemberParamsSchema>;
export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;
export type UpdateProjectMemberRequest = z.infer<typeof updateProjectMemberRequestSchema>;
export type WorkLocation = z.infer<typeof workLocationSchema>;
export type WorkLocationListQuery = z.infer<typeof workLocationListQuerySchema>;
export type CreateWorkLocationRequest = z.infer<typeof createWorkLocationRequestSchema>;
export type UpdateWorkLocationRequest = z.infer<typeof updateWorkLocationRequestSchema>;
export type ProjectLocation = z.infer<typeof projectLocationSchema>;
export type ProjectLocationParams = z.infer<typeof projectLocationParamsSchema>;
export type LinkProjectLocationRequest = z.infer<typeof linkProjectLocationRequestSchema>;
export type DailyReportSummary = z.infer<typeof dailyReportSummarySchema>;
export type DailyReport = z.infer<typeof dailyReportSchema>;
export type DailyReportListQuery = z.infer<typeof dailyReportListQuerySchema>;
export type SubmitDailyReportRequest = z.infer<typeof submitDailyReportRequestSchema>;
export type MissingReports = z.infer<typeof missingReportsSchema>;
export type MissingReportsQuery = z.infer<typeof missingReportsQuerySchema>;
export type ProjectActivity = z.infer<typeof projectActivitySchema>;
export type ProjectActivityQuery = z.infer<typeof projectActivityQuerySchema>;
export type ProjectActivityRecordedPayloadInput = z.infer<typeof projectActivityRecordedPayloadSchema>;
