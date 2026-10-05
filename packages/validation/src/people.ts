import { z } from 'zod';

import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

const memberStatusSchema = z.enum(['INVITED', 'ACTIVE', 'DISABLED']);
const employmentStatusSchema = z.enum(['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED']);
const employmentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR']);
const localeSchema = z.enum(['en', 'ar']);
const isoDateSchema = z.iso.date();
const nameSchema = z.string().trim().min(1).max(120);
const codeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'letters, digits, "-" and "_" (max 32)');
const employeeNumberSchema = codeSchema;
const emailSchema = z.email().max(254);
const phoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[+0-9 ()-]+$/, 'digits, spaces, "+", "-" and parentheses');
const timeZoneSchema = z.string().trim().min(1).max(64);
const reference = z.strictObject({ id: z.uuid(), name: z.string() });
const personReference = z.strictObject({ id: z.uuid(), fullName: z.string() });

// ---- Organization settings ----

export const organizationSchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  timeZone: z.string(),
  /** ISO weekdays (1 = Monday ... 7 = Sunday). */
  workWeek: z.array(z.number().int().min(1).max(7)),
  defaultLocale: localeSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export const organizationResponseSchema = dataResponseSchema(organizationSchema);

export const updateOrganizationRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    timeZone: timeZoneSchema.optional(),
    workWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    defaultLocale: localeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

// ---- Employees ----

export const employeeSchema = z.strictObject({
  id: z.uuid(),
  memberId: z.uuid(),
  employeeNumber: z.string(),
  fullName: z.string(),
  workEmail: z.string().nullable(),
  /** Null unless the caller may see contact fields. */
  phone: z.string().nullable(),
  contactVisible: z.boolean(),
  department: reference.nullable(),
  jobTitle: reference.nullable(),
  manager: personReference.nullable(),
  employmentStatus: employmentStatusSchema,
  employmentType: employmentTypeSchema,
  joinDate: isoDateSchema.nullable(),
  memberStatus: memberStatusSchema,
  hasAvatar: z.boolean(),
  timeZone: z.string().nullable(),
  locale: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const employeeResponseSchema = dataResponseSchema(employeeSchema);
/** The caller's own profile; null for a member without an employee profile. */
export const ownProfileResponseSchema = dataResponseSchema(employeeSchema.nullable());
export const employeePageResponseSchema = pageResponseSchema(employeeSchema);

export const employeeListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  departmentId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  employmentStatus: employmentStatusSchema.optional(),
  memberStatus: memberStatusSchema.optional(),
  ...pageQueryShape,
});

export const createEmployeeRequestSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(200),
  employeeNumber: employeeNumberSchema.optional(),
  workEmail: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  jobTitleId: z.uuid().nullable().optional(),
  managerId: z.uuid().nullable().optional(),
  employmentType: employmentTypeSchema.optional(),
  joinDate: isoDateSchema.nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  locale: localeSchema.nullable().optional(),
});

export const updateEmployeeRequestSchema = createEmployeeRequestSchema
  .partial()
  .extend({ employmentStatus: employmentStatusSchema.optional() })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const invitationSchema = z.strictObject({
  /** Single-use sign-in link for the invitee; shown once and never retrievable again. */
  url: z.url(),
  expiresAt: isoDateTimeSchema,
});

export const createEmployeeResponseSchema = dataResponseSchema(
  z.strictObject({ employee: employeeSchema, invitation: invitationSchema }),
);

export const invitationResponseSchema = dataResponseSchema(invitationSchema);

export const setMemberStatusRequestSchema = z.strictObject({ status: z.enum(['ACTIVE', 'DISABLED']) });

export const setAvatarRequestSchema = z.strictObject({ attachmentId: z.uuid().nullable() });

export const updateOwnProfileRequestSchema = z
  .strictObject({
    phone: phoneSchema.nullable().optional(),
    timeZone: timeZoneSchema.nullable().optional(),
    locale: localeSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

// ---- Departments, teams, job titles ----

export const structureListQuerySchema = z.strictObject({ includeArchived: booleanQuerySchema.optional() });

export const departmentSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  parentDepartmentId: z.uuid().nullable(),
  manager: personReference.nullable(),
  archived: z.boolean(),
  employeeCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const departmentResponseSchema = dataResponseSchema(departmentSchema);
export const departmentListResponseSchema = listResponseSchema(departmentSchema);

export const createDepartmentRequestSchema = z.strictObject({
  name: nameSchema,
  code: codeSchema,
  parentDepartmentId: z.uuid().nullable().optional(),
  managerId: z.uuid().nullable().optional(),
});

export const updateDepartmentRequestSchema = createDepartmentRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const teamSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  department: reference.nullable(),
  lead: personReference.nullable(),
  archived: z.boolean(),
  memberCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const teamResponseSchema = dataResponseSchema(teamSchema);
export const teamListResponseSchema = listResponseSchema(teamSchema);

export const createTeamRequestSchema = z.strictObject({
  name: nameSchema,
  departmentId: z.uuid().nullable().optional(),
  leadId: z.uuid().nullable().optional(),
});

export const updateTeamRequestSchema = createTeamRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const teamMemberSchema = z.strictObject({
  employeeId: z.uuid(),
  fullName: z.string(),
  employeeNumber: z.string(),
  addedAt: isoDateTimeSchema,
});

export const teamMemberListResponseSchema = listResponseSchema(teamMemberSchema);
export const teamMemberParamsSchema = z.strictObject({ id: z.uuid(), employeeId: z.uuid() });
export const teamMemberAddedResponseSchema = dataResponseSchema(z.strictObject({ created: z.boolean() }));

export const jobTitleSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  archived: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const jobTitleResponseSchema = dataResponseSchema(jobTitleSchema);
export const jobTitleListResponseSchema = listResponseSchema(jobTitleSchema);
export const createJobTitleRequestSchema = z.strictObject({ name: nameSchema });
export const updateJobTitleRequestSchema = z
  .strictObject({ name: nameSchema.optional(), archived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type Organization = z.infer<typeof organizationSchema>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;
export type CreateEmployeeRequest = z.infer<typeof createEmployeeRequestSchema>;
export type UpdateEmployeeRequest = z.infer<typeof updateEmployeeRequestSchema>;
export type SetMemberStatusRequest = z.infer<typeof setMemberStatusRequestSchema>;
export type SetAvatarRequest = z.infer<typeof setAvatarRequestSchema>;
export type UpdateOwnProfileRequest = z.infer<typeof updateOwnProfileRequestSchema>;
export type StructureListQuery = z.infer<typeof structureListQuerySchema>;
export type Department = z.infer<typeof departmentSchema>;
export type CreateDepartmentRequest = z.infer<typeof createDepartmentRequestSchema>;
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentRequestSchema>;
export type Team = z.infer<typeof teamSchema>;
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>;
export type UpdateTeamRequest = z.infer<typeof updateTeamRequestSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamMemberParams = z.infer<typeof teamMemberParamsSchema>;
export type JobTitle = z.infer<typeof jobTitleSchema>;
export type CreateJobTitleRequest = z.infer<typeof createJobTitleRequestSchema>;
export type UpdateJobTitleRequest = z.infer<typeof updateJobTitleRequestSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
