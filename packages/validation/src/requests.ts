import { z } from 'zod';

import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';
import { csvEnum } from './projects.js';

// ---- Enums (mirror the Prisma enums) ----

export const requestCategorySchema = z.enum(['HR', 'IT', 'FINANCE', 'ACCESS', 'OPERATIONS', 'OTHER']);
export const workflowVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']);
export const workflowStepKindSchema = z.enum(['APPROVAL', 'FULFILLMENT']);
export const approverTypeSchema = z.enum([
  'DIRECT_MANAGER',
  'DEPARTMENT_MANAGER',
  'TEAM_LEAD',
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'ROLE',
  'MEMBER',
]);
export const approvalModeSchema = z.enum(['ANY_ONE', 'ALL']);
export const attachmentRequirementSchema = z.enum(['NONE', 'OPTIONAL', 'REQUIRED']);
export const requestStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'IN_FULFILLMENT',
  'COMPLETED',
]);
export const requestApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED']);
/** `CORRECTION` is reserved for the system-provisioned `attendance_correction` type (ADR-0022). */
export const requestEffectModeSchema = z.enum(['LEAVE', 'REMOTE', 'BUSINESS_MISSION', 'SHORT_LEAVE', 'CORRECTION']);
/** Request type key provisioned by attendance; never offered by the generic catalog. */
export const ATTENDANCE_CORRECTION_TYPE_KEY = 'attendance_correction';

/** Icons the web app can render; configuration cannot reference arbitrary assets. */
export const REQUEST_TYPE_ICONS = [
  'calendar',
  'home',
  'laptop',
  'key',
  'shopping-cart',
  'plane',
  'file-text',
  'clock',
  'wrench',
  'users',
] as const;
export const requestTypeIconSchema = z.enum(REQUEST_TYPE_ICONS);

// ---- Limits (ADR-0021) ----

export const FORM_LIMITS = {
  maxFields: 40,
  maxOptions: 50,
  maxConditionRules: 10,
  maxSteps: 20,
  maxStepApprovers: 25,
  maxSchemaBytes: 65_536,
  maxDataBytes: 32_768,
  maxTextLength: 500,
  maxTextareaLength: 5000,
  maxAttachments: 20,
  maxDelegationDays: 90,
} as const;

const versionSchema = z.number().int().min(1);

export const localizedTextSchema = z.strictObject({
  en: z.string().trim().min(1).max(200),
  ar: z.string().trim().min(1).max(200).optional(),
});
export const localizedLongTextSchema = z.strictObject({
  en: z.string().trim().min(1).max(1000),
  ar: z.string().trim().min(1).max(1000).optional(),
});
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export const formFieldKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'must be a camelCase key');
const optionValueSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, 'must be a lowercase option value');
const isoDateSchema = z.iso.date();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const amountSchema = z.number().min(-1_000_000_000_000).max(1_000_000_000_000);

// ---- Conditions: one all/any group of typed rules over form fields ----

export const conditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'isSet',
  'isNotSet',
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

export const conditionValueSchema = z.union([
  z.string().max(200),
  amountSchema,
  z.boolean(),
  z.array(z.string().max(200)).min(1).max(FORM_LIMITS.maxOptions),
]);

export const conditionRuleSchema = z.strictObject({
  field: formFieldKeySchema,
  op: conditionOperatorSchema,
  value: conditionValueSchema.optional(),
});

export const conditionSchema = z.strictObject({
  match: z.enum(['all', 'any']),
  rules: z.array(conditionRuleSchema).min(1).max(FORM_LIMITS.maxConditionRules),
});
export type ConditionRule = z.infer<typeof conditionRuleSchema>;
export type Condition = z.infer<typeof conditionSchema>;

// ---- Form fields ----

const fieldBase = {
  key: formFieldKeySchema,
  label: localizedTextSchema,
  help: localizedLongTextSchema.optional(),
  required: z.boolean().optional(),
  visibleWhen: conditionSchema.optional(),
};

const optionSchema = z.strictObject({ value: optionValueSchema, label: localizedTextSchema });

export const formFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...fieldBase,
    type: z.literal('text'),
    minLength: z.number().int().min(1).max(FORM_LIMITS.maxTextLength).optional(),
    maxLength: z.number().int().min(1).max(FORM_LIMITS.maxTextLength).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('textarea'),
    minLength: z.number().int().min(1).max(FORM_LIMITS.maxTextareaLength).optional(),
    maxLength: z.number().int().min(1).max(FORM_LIMITS.maxTextareaLength).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('number'),
    min: amountSchema.optional(),
    max: amountSchema.optional(),
    integer: z.boolean().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('money'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code'),
    min: amountSchema.optional(),
    max: amountSchema.optional(),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('date'), notInPast: z.boolean().optional() }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('date_range'),
    notInPast: z.boolean().optional(),
    maxDays: z.number().int().min(1).max(366).optional(),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('time') }),
  z.strictObject({ ...fieldBase, type: z.literal('boolean') }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('select'),
    options: z.array(optionSchema).min(1).max(FORM_LIMITS.maxOptions),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal('multiselect'),
    options: z.array(optionSchema).min(1).max(FORM_LIMITS.maxOptions),
    minItems: z.number().int().min(1).max(FORM_LIMITS.maxOptions).optional(),
    maxItems: z.number().int().min(1).max(FORM_LIMITS.maxOptions).optional(),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('member') }),
  z.strictObject({ ...fieldBase, type: z.literal('project') }),
  /** Display-only text: never holds a value. */
  z.strictObject({
    key: formFieldKeySchema,
    type: z.literal('info'),
    label: localizedTextSchema,
    help: localizedLongTextSchema.optional(),
    visibleWhen: conditionSchema.optional(),
  }),
]);
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldType = FormField['type'];

interface ConditionIssue {
  path: (string | number)[];
  message: string;
}

const ORDERED_TYPES: ReadonlySet<FormFieldType> = new Set(['number', 'money', 'date', 'time']);

function scalarMatches(field: FormField, value: unknown): boolean {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return typeof value === 'string';
    case 'number':
    case 'money':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return isoDateSchema.safeParse(value).success;
    case 'time':
      return timeSchema.safeParse(value).success;
    case 'select':
      return typeof value === 'string' && field.options.some((option) => option.value === value);
    case 'member':
    case 'project':
      return z.uuid().safeParse(value).success;
    default:
      return false;
  }
}

/**
 * Static checks of a condition against the form: referenced fields exist, hold values, are not the
 * field itself, and each operator/value pair fits the field type. Shared by the API (publish) and
 * the web builder so both reject the same configurations.
 */
export function conditionIssues(
  condition: Condition,
  fields: ReadonlyMap<string, FormField>,
  selfKey?: string,
): ConditionIssue[] {
  const issues: ConditionIssue[] = [];
  condition.rules.forEach((rule, index) => {
    const at = (message: string): void => {
      issues.push({ path: ['rules', index], message });
    };
    const field = fields.get(rule.field);
    if (field === undefined || field.type === 'info') {
      at('references an unknown field');
      return;
    }
    if (rule.field === selfKey) {
      at('cannot reference its own field');
      return;
    }
    const value = rule.value;
    switch (rule.op) {
      case 'isSet':
      case 'isNotSet':
        if (value !== undefined) at('takes no value');
        return;
      case 'eq':
      case 'neq':
        if (!scalarMatches(field, value)) at('value does not fit the field');
        return;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        if (!ORDERED_TYPES.has(field.type) || !scalarMatches(field, value)) at('comparison does not fit the field');
        return;
      case 'in':
      case 'notIn': {
        if (!Array.isArray(value)) {
          at('needs a list of values');
          return;
        }
        if (field.type === 'select' || field.type === 'multiselect') {
          const allowed = new Set(field.options.map((option) => option.value));
          if (!value.every((item) => allowed.has(item))) at('lists an unknown option');
          return;
        }
        if (field.type !== 'text') at('list comparison does not fit the field');
        return;
      }
    }
  });
  return issues;
}

export const formSchemaSchema = z
  .strictObject({ fields: z.array(formFieldSchema).max(FORM_LIMITS.maxFields) })
  .superRefine((form, ctx) => {
    const byKey = new Map<string, FormField>();
    form.fields.forEach((field, index) => {
      if (byKey.has(field.key)) {
        ctx.addIssue({ code: 'custom', message: 'duplicate field key', path: ['fields', index, 'key'] });
      }
      byKey.set(field.key, field);
      if (
        'minLength' in field &&
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        ctx.addIssue({ code: 'custom', message: 'minLength exceeds maxLength', path: ['fields', index, 'minLength'] });
      }
      if ('min' in field && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        ctx.addIssue({ code: 'custom', message: 'min exceeds max', path: ['fields', index, 'min'] });
      }
      if (
        field.type === 'multiselect' &&
        field.minItems !== undefined &&
        field.maxItems !== undefined &&
        field.minItems > field.maxItems
      ) {
        ctx.addIssue({ code: 'custom', message: 'minItems exceeds maxItems', path: ['fields', index, 'minItems'] });
      }
      if (field.type === 'select' || field.type === 'multiselect') {
        const values = field.options.map((option) => option.value);
        if (new Set(values).size !== values.length) {
          ctx.addIssue({ code: 'custom', message: 'duplicate option value', path: ['fields', index, 'options'] });
        }
      }
    });
    form.fields.forEach((field, index) => {
      if (field.visibleWhen === undefined) return;
      for (const issue of conditionIssues(field.visibleWhen, byKey, field.key)) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: ['fields', index, 'visibleWhen', ...issue.path] });
      }
    });
  });
export type FormSchema = z.infer<typeof formSchemaSchema>;

// ---- Form data (values submitted by the requester) ----

export const dateRangeValueSchema = z.strictObject({ start: isoDateSchema, end: isoDateSchema });
export const formValueSchema = z.union([
  z.string().max(FORM_LIMITS.maxTextareaLength),
  amountSchema,
  z.boolean(),
  z.array(z.string().max(100)).max(FORM_LIMITS.maxOptions),
  dateRangeValueSchema,
]);
export type FormValue = z.infer<typeof formValueSchema>;

/** `{ [fieldKey]: value }`; null clears a value in a draft. Validated against the schema by the server. */
export const formDataSchema = z
  .record(formFieldKeySchema, formValueSchema.nullable())
  .refine((data) => Object.keys(data).length <= FORM_LIMITS.maxFields, 'too many values');
export type RequestFormData = z.infer<typeof formDataSchema>;

// ---- Workflow configuration (administration) ----

export const approverRuleSchema = z.strictObject({
  type: approverTypeSchema,
  /** MEMBER only. */
  memberId: z.uuid().optional(),
  /** ROLE only. */
  roleId: z.uuid().optional(),
  /** PROJECT_MANAGER / TECHNICAL_MANAGER only: key of a `project` field. */
  projectField: formFieldKeySchema.optional(),
});

export const workflowStepInputSchema = z.strictObject({
  kind: workflowStepKindSchema,
  name: localizedTextSchema,
  /** APPROVAL only; FULFILLMENT steps are performed by any member holding `request.fulfill`. */
  mode: approvalModeSchema.optional(),
  approver: approverRuleSchema.optional(),
  condition: conditionSchema.nullable().optional(),
  slaHours: z.number().int().min(1).max(720).nullable().optional(),
});

export const workflowEffectsSchema = z.strictObject({
  /** Approved requests produce one attendance effect for the dates in `dateField` (Phase 7 consumes it). */
  attendance: z
    .strictObject({
      mode: requestEffectModeSchema,
      dateField: formFieldKeySchema,
      /** SHORT_LEAVE only: required `time` fields bounding the permission window (ADR-0022). */
      fromTimeField: formFieldKeySchema.optional(),
      toTimeField: formFieldKeySchema.optional(),
    })
    .optional(),
});

export const workflowNotificationsSchema = z.strictObject({
  emailApprovers: z.boolean(),
  emailRequester: z.boolean(),
});

export const attachmentPolicySchema = z.strictObject({
  requirement: attachmentRequirementSchema,
  maxFiles: z.number().int().min(0).max(FORM_LIMITS.maxAttachments),
});

export const workflowContentSchema = z.strictObject({
  form: formSchemaSchema,
  steps: z.array(workflowStepInputSchema).min(1).max(FORM_LIMITS.maxSteps),
  attachments: attachmentPolicySchema,
  effects: workflowEffectsSchema,
  notifications: workflowNotificationsSchema,
});
export type WorkflowContent = z.infer<typeof workflowContentSchema>;

export const updateWorkflowDraftSchema = workflowContentSchema.extend({ revision: versionSchema });
export const workflowRevisionSchema = z.strictObject({ revision: versionSchema });

const requesterRoleIdsSchema = z.array(z.uuid()).max(20);

export const createRequestTypeSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, 'must be a lowercase key'),
  name: localizedTextSchema,
  description: localizedLongTextSchema.nullable().optional(),
  category: requestCategorySchema,
  icon: requestTypeIconSchema,
  /** Empty: every member holding `request.create` may submit. */
  requesterRoleIds: requesterRoleIdsSchema.optional(),
});

export const updateRequestTypeSchema = z
  .strictObject({
    version: versionSchema,
    name: localizedTextSchema.optional(),
    description: localizedLongTextSchema.nullable().optional(),
    category: requestCategorySchema.optional(),
    icon: requestTypeIconSchema.optional(),
    requesterRoleIds: requesterRoleIdsSchema.optional(),
    /** Activation needs a published workflow version. */
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 1, 'at least one change is required');

const personRefSchema = z.strictObject({ memberId: z.uuid(), name: z.string(), active: z.boolean() });

export const requestTypeRefSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: localizedTextSchema,
  category: requestCategorySchema,
  icon: requestTypeIconSchema,
});

export const adminRequestTypeSchema = requestTypeRefSchema.extend({
  description: localizedLongTextSchema.nullable(),
  active: z.boolean(),
  requesterRoles: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  publishedVersion: z
    .strictObject({ id: z.uuid(), number: z.number().int(), publishedAt: isoDateTimeSchema })
    .nullable(),
  draftVersion: z.strictObject({ id: z.uuid(), number: z.number().int(), revision: z.number().int() }).nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const adminWorkflowStepSchema = z.strictObject({
  order: z.number().int(),
  kind: workflowStepKindSchema,
  name: localizedTextSchema,
  mode: approvalModeSchema,
  approver: z
    .strictObject({
      type: approverTypeSchema,
      member: personRefSchema.nullable(),
      role: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
      projectField: z.string().nullable(),
    })
    .nullable(),
  condition: conditionSchema.nullable(),
  slaHours: z.number().int().nullable(),
});

export const workflowVersionSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  status: workflowVersionStatusSchema,
  createdAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  retiredAt: isoDateTimeSchema.nullable(),
});

export const workflowVersionSchema = workflowVersionSummarySchema.extend({
  requestTypeId: z.uuid(),
  /** Draft edit counter; send back with every draft change. */
  revision: z.number().int(),
  /** Only drafts are editable; editing a published workflow creates a new draft version. */
  editable: z.boolean(),
  form: formSchemaSchema,
  steps: z.array(adminWorkflowStepSchema),
  attachments: attachmentPolicySchema,
  effects: workflowEffectsSchema,
  notifications: workflowNotificationsSchema,
  publishedBy: personRefSchema.nullable(),
});

export const adminRequestTypeResponseSchema = dataResponseSchema(adminRequestTypeSchema);
export const adminRequestTypeListResponseSchema = listResponseSchema(adminRequestTypeSchema);
export const workflowVersionResponseSchema = dataResponseSchema(workflowVersionSchema);
export const workflowVersionPageResponseSchema = pageResponseSchema(workflowVersionSummarySchema);
export const versionParamsSchema = z.strictObject({ id: z.uuid(), versionId: z.uuid() });

// ---- Requester catalog ----

export const requestTypeCatalogItemSchema = requestTypeRefSchema.extend({
  description: localizedLongTextSchema.nullable(),
});
export const requestTypeCatalogResponseSchema = listResponseSchema(requestTypeCatalogItemSchema);

export const requestFormResponseSchema = dataResponseSchema(
  z.strictObject({
    requestType: requestTypeCatalogItemSchema,
    workflowVersionId: z.uuid(),
    workflowVersionNumber: z.number().int(),
    form: formSchemaSchema,
    attachments: attachmentPolicySchema,
  }),
);

// ---- Requests ----

export const requestViewSchema = z.enum(['mine', 'all']);

export const requestSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  /** `REQ-<number>`. */
  key: z.string(),
  status: requestStatusSchema,
  requestType: requestTypeRefSchema,
  requester: personRefSchema,
  project: z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
  currentStep: z.strictObject({ order: z.number().int(), name: localizedTextSchema }).nullable(),
  startsOn: isoDateSchema.nullable(),
  endsOn: isoDateSchema.nullable(),
  submittedAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const requestApprovalViewSchema = z.strictObject({
  id: z.uuid(),
  approver: personRefSchema,
  status: requestApprovalStatusSchema,
  /** Who decided: the approver, or a delegate acting for them. */
  decidedBy: personRefSchema.nullable(),
  delegated: z.boolean(),
  comment: z.string().nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
});

export const requestStepStateSchema = z.enum([
  'NOT_REACHED',
  'ACTIVE',
  'COMPLETED',
  'SKIPPED',
  'REJECTED',
  'CANCELLED',
]);

export const requestStepViewSchema = z.strictObject({
  order: z.number().int(),
  kind: workflowStepKindSchema,
  name: localizedTextSchema,
  mode: approvalModeSchema,
  state: requestStepStateSchema,
  /** The step is active but nobody can act on it yet (an administrator must reassign it). */
  unassigned: z.boolean(),
  approvals: z.array(requestApprovalViewSchema),
});

export const fulfillmentActionSchema = z.enum(['START', 'COMPLETE_STEP']);

export const requestSchema = requestSummarySchema.extend({
  /** Send back with every change (optimistic concurrency); a stale value is `409 VERSION_CONFLICT`. */
  version: z.number().int(),
  workflowVersion: z.strictObject({ id: z.uuid(), number: z.number().int() }),
  /** The form of the pinned workflow version (labels for `formData`). */
  form: formSchemaSchema,
  formData: formDataSchema,
  attachments: attachmentPolicySchema,
  cancelledAt: isoDateTimeSchema.nullable(),
  cancelReason: z.string().nullable(),
  steps: z.array(requestStepViewSchema),
  /** Display names of the members and projects referenced by `formData`. */
  references: z.strictObject({
    members: z.array(personRefSchema),
    projects: z.array(z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() })),
  }),
  /** What the caller may do (UX hints; every action is re-checked by the server). */
  access: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canCancel: z.boolean(),
    canAttach: z.boolean(),
    /** Pending approvals the caller may decide (their own or delegated to them). */
    decidableApprovalIds: z.array(z.uuid()),
    fulfillmentAction: fulfillmentActionSchema.nullable(),
    canReassign: z.boolean(),
  }),
});

export const requestResponseSchema = dataResponseSchema(requestSchema);
export const requestPageResponseSchema = pageResponseSchema(requestSummarySchema);

export const requestListQuerySchema = z.strictObject({
  view: requestViewSchema.optional(),
  status: csvEnum(requestStatusSchema).optional(),
  requestTypeId: z.uuid().optional(),
  /** Request key (`REQ-12` / `12`). Form contents are never searched. */
  q: z.string().trim().min(1).max(40).optional(),
  ...pageQueryShape,
});

export const createRequestSchema = z.strictObject({
  requestTypeId: z.uuid(),
  formData: formDataSchema,
  /** Submit immediately instead of keeping a draft. */
  submit: z.boolean().optional(),
});

export const updateRequestDraftSchema = z.strictObject({ version: versionSchema, formData: formDataSchema });
export const requestVersionSchema = z.strictObject({ version: versionSchema });
export const cancelRequestSchema = z.strictObject({
  version: versionSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
});
export const fulfilRequestSchema = z.strictObject({
  version: versionSchema,
  action: fulfillmentActionSchema,
  note: z.string().trim().min(1).max(1000).optional(),
});
export const reassignApprovalSchema = z.strictObject({
  version: versionSchema,
  /** New assignee of the current step. */
  memberId: z.uuid(),
  /** Pending assignment to replace; omitted: add an assignee. */
  replaceApprovalId: z.uuid().optional(),
  reason: z.string().trim().min(1).max(500),
});

export const requestEventTypeSchema = z.enum([
  'CREATED',
  'UPDATED',
  'SUBMITTED',
  'STEP_ACTIVATED',
  'STEP_SKIPPED',
  'STEP_UNASSIGNED',
  'APPROVED',
  'REJECTED',
  'STEP_COMPLETED',
  'REASSIGNED',
  'FULFILLMENT_STARTED',
  'FULFILLMENT_STEP_COMPLETED',
  'COMPLETED',
  'CANCELLED',
  'EFFECT_RECORDED',
  'EFFECT_REVOKED',
]);

export const requestEventSchema = z.strictObject({
  id: z.uuid(),
  type: requestEventTypeSchema,
  /** Null for automatic changes. */
  actor: personRefSchema.nullable(),
  stepOrder: z.number().int().nullable(),
  /** The approver a delegate acted for, or the member a step was assigned to. */
  subject: personRefSchema.nullable(),
  /** Decision comment, cancellation or reassignment reason, fulfillment note. */
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export const requestEventPageResponseSchema = pageResponseSchema(requestEventSchema);
export const requestEventQuerySchema = z.strictObject({ ...pageQueryShape });

// ---- Approvals ----

export const approvalInboxItemSchema = z.strictObject({
  approvalId: z.uuid(),
  request: z.strictObject({
    id: z.uuid(),
    key: z.string(),
    status: requestStatusSchema,
    requestType: requestTypeRefSchema,
    requester: personRefSchema,
    startsOn: isoDateSchema.nullable(),
    endsOn: isoDateSchema.nullable(),
    submittedAt: isoDateTimeSchema.nullable(),
  }),
  step: z.strictObject({ order: z.number().int(), name: localizedTextSchema, mode: approvalModeSchema }),
  /** Set when the caller acts as a delegate: the original approver. */
  onBehalfOf: personRefSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  overdue: z.boolean(),
  assignedAt: isoDateTimeSchema,
});
export const approvalInboxPageResponseSchema = pageResponseSchema(approvalInboxItemSchema);
export const approvalInboxQuerySchema = z.strictObject({
  requestTypeId: z.uuid().optional(),
  /** Only assignments past their due time (dashboard "overdue" deep link). */
  overdue: booleanQuerySchema.optional(),
  ...pageQueryShape,
});
export const approvalSummaryResponseSchema = dataResponseSchema(z.strictObject({ pending: z.number().int() }));

export const approveSchema = z.strictObject({ comment: z.string().trim().min(1).max(2000).optional() });
export const rejectSchema = z.strictObject({ comment: z.string().trim().min(1).max(2000) });

export const delegationStatusSchema = z.enum(['SCHEDULED', 'ACTIVE', 'EXPIRED', 'REVOKED']);

export const delegationSchema = z.strictObject({
  id: z.uuid(),
  delegator: personRefSchema,
  delegate: personRefSchema,
  requestType: z.strictObject({ id: z.uuid(), name: localizedTextSchema }).nullable(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  reason: z.string().nullable(),
  status: delegationStatusSchema,
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  canRevoke: z.boolean(),
});
export const delegationResponseSchema = dataResponseSchema(delegationSchema);
export const delegationPageResponseSchema = pageResponseSchema(delegationSchema);
export const delegationListQuerySchema = z.strictObject({
  /** `mine`: given or received by the caller; `all`: every delegation (`request.admin`). */
  view: z.enum(['mine', 'all']).optional(),
  ...pageQueryShape,
});
export const createDelegationSchema = z
  .strictObject({
    /** Defaults to the caller; another member needs `request.admin`. */
    delegatorMemberId: z.uuid().optional(),
    delegateMemberId: z.uuid(),
    requestTypeId: z.uuid().nullable().optional(),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
    message: 'must end after it starts',
    path: ['endsAt'],
  });

/** `Idempotency-Key` header of `POST /requests` (client-generated UUID). */
export const requestIdempotencyKeySchema = z.uuid();

export const approvalParamsSchema = z.strictObject({ approvalId: z.uuid() });

export type RequestStatus = z.infer<typeof requestStatusSchema>;
export type RequestCategory = z.infer<typeof requestCategorySchema>;
export type ApproverType = z.infer<typeof approverTypeSchema>;
export type RequestTypeIcon = z.infer<typeof requestTypeIconSchema>;
export type CreateRequestTypeRequest = z.infer<typeof createRequestTypeSchema>;
export type UpdateRequestTypeRequest = z.infer<typeof updateRequestTypeSchema>;
export type UpdateWorkflowDraftRequest = z.infer<typeof updateWorkflowDraftSchema>;
export type WorkflowRevisionRequest = z.infer<typeof workflowRevisionSchema>;
export type VersionParams = z.infer<typeof versionParamsSchema>;
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;
export type CreateRequestRequest = z.infer<typeof createRequestSchema>;
export type UpdateRequestDraftRequest = z.infer<typeof updateRequestDraftSchema>;
export type RequestVersionRequest = z.infer<typeof requestVersionSchema>;
export type CancelRequestRequest = z.infer<typeof cancelRequestSchema>;
export type FulfilRequestRequest = z.infer<typeof fulfilRequestSchema>;
export type ReassignApprovalRequest = z.infer<typeof reassignApprovalSchema>;
export type RequestEventQuery = z.infer<typeof requestEventQuerySchema>;
export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;
export type ApproveRequest = z.infer<typeof approveSchema>;
export type RejectRequest = z.infer<typeof rejectSchema>;
export type DelegationListQuery = z.infer<typeof delegationListQuerySchema>;
export type CreateDelegationRequest = z.infer<typeof createDelegationSchema>;
export type ApprovalParams = z.infer<typeof approvalParamsSchema>;
export type RequestView = z.infer<typeof requestSchema>;
export type RequestSummary = z.infer<typeof requestSummarySchema>;
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type AdminRequestType = z.infer<typeof adminRequestTypeSchema>;
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;
