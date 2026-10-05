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

/**
 * Phase 10 tenders, corporate documents and contracts (ADR-0026). Money is a decimal string with at
 * most four fractional digits plus an ISO 4217 currency; values are never converted between
 * currencies. Financial fields are omitted (not null) for callers without the financial permission.
 */

const isoDateSchema = z.iso.date();
const versionSchema = z.number().int().min(1);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 currency code');
export const moneyAmountSchema = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'a non-negative decimal with at most 4 fractional digits');
export const signedMoneyAmountSchema = z
  .string()
  .regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'a decimal with at most 4 fractional digits');
export const moneySchema = z.strictObject({ amount: z.string(), currency: currencySchema });
/** IANA zone name (validated against the runtime's zone database on the server). */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/);

const personRefSchema = z.strictObject({ memberId: z.uuid(), name: z.string(), active: z.boolean() });
const customerRefSchema = z.strictObject({ id: z.uuid(), name: z.string() });
const projectRefSchema = z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() });

// ---- Enumerations ----

export const tenderStatusSchema = z.enum([
  'DRAFT',
  'NEW',
  'UNDER_REVIEW',
  'BID_DECISION_PENDING',
  'NO_BID',
  'PREPARING',
  'INTERNAL_REVIEW',
  'READY_FOR_SUBMISSION',
  'SUBMITTED',
  'CLARIFICATION',
  'AWARDED',
  'LOST',
  'CANCELLED',
  'ARCHIVED',
]);
export const tenderTypeSchema = z.enum([
  'OPEN_TENDER',
  'LIMITED_TENDER',
  'DIRECT_INVITATION',
  'RFQ',
  'RFP',
  'FRAMEWORK_AGREEMENT',
  'OTHER',
]);
export const commercialPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const tenderBidDecisionSchema = z.enum(['PENDING', 'BID', 'NO_BID']);
export const bidCriterionValueSchema = z.enum(['YES', 'NO', 'NOT_EVALUATED']);
export const noBidReasonSchema = z.enum([
  'INSUFFICIENT_TIME',
  'TECHNICAL_MISMATCH',
  'RESOURCE_CONSTRAINT',
  'COMMERCIAL_RISK',
  'MISSING_QUALIFICATION',
  'LOW_STRATEGIC_VALUE',
  'LOW_MARGIN_EXPECTATION',
  'OTHER',
]);
export const tenderRequirementCategorySchema = z.enum([
  'TECHNICAL',
  'COMMERCIAL',
  'LEGAL',
  'ADMINISTRATIVE',
  'FINANCIAL',
  'CERTIFICATE',
  'FORM',
  'EXPERIENCE',
  'BANK',
  'SECURITY',
  'OTHER',
]);
export const tenderRequirementStatusSchema = z.enum([
  'NOT_STARTED',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED',
  'NOT_APPLICABLE',
  'BLOCKED',
]);
export const tenderReviewGateTypeSchema = z.enum(['TECHNICAL', 'COMMERCIAL', 'LEGAL', 'FINAL']);
export const tenderReviewModeSchema = z.enum(['ANY_ONE', 'ALL']);
export const tenderReviewGateStatusSchema = z.enum([
  'WAITING',
  'OPEN',
  'APPROVED',
  'CHANGES_REQUIRED',
  'REJECTED',
  'SUPERSEDED',
]);
export const tenderReviewStatusSchema = z.enum(['PENDING', 'APPROVED', 'CHANGES_REQUIRED', 'REJECTED', 'SUPERSEDED']);
export const tenderReviewDecisionSchema = z.enum(['APPROVED', 'CHANGES_REQUIRED', 'REJECTED']);
export const tenderSubmissionMethodSchema = z.enum(['GOVERNMENT_PORTAL', 'EMAIL', 'PHYSICAL', 'COURIER', 'OTHER']);
export const tenderSubmissionKindSchema = z.enum(['SUBMISSION', 'CORRECTION']);
export const tenderLossReasonSchema = z.enum([
  'PRICE',
  'TECHNICAL_SCORE',
  'COMMERCIAL_TERMS',
  'QUALIFICATION',
  'DELIVERY_TIMELINE',
  'CUSTOMER_DECISION',
  'CANCELLED',
  'UNKNOWN',
  'OTHER',
]);
export const tenderClarificationStatusSchema = z.enum(['OPEN', 'SUBMITTED', 'ANSWERED', 'WITHDRAWN']);
export const commercialDocumentCategorySchema = z.enum([
  'SOURCE_DOCUMENTS',
  'ADDENDA',
  'CLARIFICATIONS',
  'TECHNICAL_SUBMISSION',
  'COMMERCIAL_SUBMISSION',
  'ADMINISTRATIVE',
  'CERTIFICATES',
  'BANKING',
  'FINAL_SUBMISSION',
  'PROOF_OF_SUBMISSION',
  'SIGNED_CONTRACT',
  'STATEMENT_OF_WORK',
  'TECHNICAL_PROPOSAL',
  'COMMERCIAL_PROPOSAL',
  'ANNEX',
  'AMENDMENT',
  'EXTENSION',
  'RENEWAL',
  'ACCEPTANCE_CERTIFICATE',
  'CORRESPONDENCE',
  'OTHER',
]);
export const documentClassificationSchema = z.enum([
  'GENERAL',
  'COMMERCIAL_CONFIDENTIAL',
  'LEGAL_RESTRICTED',
  'BANKING_RESTRICTED',
]);
export const corporateDocumentTypeSchema = z.enum([
  'COMMERCIAL_REGISTRATION',
  'TAX_REGISTRATION',
  'VAT_CERTIFICATE',
  'ISO_CERTIFICATE',
  'BANK_LETTER',
  'COMPANY_PROFILE',
  'PREVIOUS_EXPERIENCE',
  'MANUFACTURER_AUTHORIZATION',
  'LICENSE',
  'INSURANCE_CERTIFICATE',
  'OTHER',
]);
export const corporateDocumentStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
/** Derived from the current version's expiry and the organization's local date. */
export const documentValiditySchema = z.enum(['VALID', 'EXPIRING', 'EXPIRED', 'NO_EXPIRY', 'NO_VERSION']);
export const contractTypeSchema = z.enum([
  'SUPPLY',
  'SERVICES',
  'MAINTENANCE',
  'SUPPORT',
  'IMPLEMENTATION',
  'FRAMEWORK',
  'LICENSE',
  'OTHER',
]);
export const contractStatusSchema = z.enum([
  'DRAFT',
  'UNDER_REVIEW',
  'AWAITING_SIGNATURE',
  'ACTIVE',
  'RENEWAL_REVIEW',
  'SUSPENDED',
  'EXPIRED',
  'TERMINATED',
  'CLOSED',
]);
export const contractRenewalTypeSchema = z.enum(['NONE', 'FIXED_TERM', 'MANUAL_RENEWAL', 'AUTO_RENEWAL', 'EVERGREEN']);
export const commercialHealthSchema = z.enum(['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL']);
export const contractHealthReasonSchema = z.enum([
  'EXPIRY_APPROACHING',
  'EXPIRED_WITHOUT_DECISION',
  'RENEWAL_DECISION_OVERDUE',
  'NOTICE_DEADLINE_APPROACHING',
  'NOTICE_DEADLINE_PASSED',
  'OBLIGATION_OVERDUE',
  'CRITICAL_OBLIGATION_OVERDUE',
  'MILESTONE_OVERDUE',
  'GUARANTEE_EXPIRING',
  'GUARANTEE_EXPIRED',
  'SIGNED_CONTRACT_MISSING',
  'AMENDMENT_AWAITING_APPROVAL',
]);
export const contractAmendmentTypeSchema = z.enum([
  'VALUE_CHANGE',
  'TIME_EXTENSION',
  'SCOPE_CHANGE',
  'COMMERCIAL_CHANGE',
  'TECHNICAL_CHANGE',
  'GENERAL',
]);
export const contractAmendmentStatusSchema = z.enum([
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'EFFECTIVE',
  'REJECTED',
  'CANCELLED',
]);
export const obligationCategorySchema = z.enum([
  'REPORTING',
  'MAINTENANCE',
  'SUPPORT',
  'SLA',
  'TRAINING',
  'DELIVERY',
  'PAYMENT_RELATED',
  'CERTIFICATION',
  'SECURITY',
  'WARRANTY',
  'OTHER',
]);
export const obligationCriticalitySchema = z.enum(['STANDARD', 'CRITICAL']);
export const obligationRecurrenceSchema = z.enum(['NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY']);
/** Stored statuses plus the derived OVERDUE (open and past its due date). */
export const obligationStatusSchema = z.enum([
  'UPCOMING',
  'IN_PROGRESS',
  'COMPLETED',
  'OVERDUE',
  'WAIVED',
  'CANCELLED',
]);
export const milestoneStatusSchema = z.enum([
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'APPROVED',
  'COMPLETED',
  'OVERDUE',
  'CANCELLED',
]);
export const guaranteeTypeSchema = z.enum([
  'BID_SECURITY',
  'PERFORMANCE_GUARANTEE',
  'ADVANCE_PAYMENT_GUARANTEE',
  'WARRANTY_GUARANTEE',
  'INSURANCE_CERTIFICATE',
  'OTHER',
]);
/** Stored statuses plus the derived EXPIRING (active and within the reminder window). */
export const guaranteeStatusSchema = z.enum(['ACTIVE', 'EXPIRING', 'EXPIRED', 'RELEASED', 'CANCELLED']);
export const renewalActionTypeSchema = z.enum([
  'REVIEW_STARTED',
  'RENEW',
  'DO_NOT_RENEW',
  'NOTICE_SENT',
  'RENEWED',
  'EXTENDED',
]);
export const commercialAccessLevelSchema = z.enum(['FULL', 'INVOLVED']);

export const commercialIdempotencyKeySchema = z.uuid();

// ---- Shared views ----

/**
 * The one readiness definition (ADR-0026): approved applicable mandatory requirements over applicable
 * mandatory requirements; NOT_APPLICABLE is excluded; with no applicable mandatory requirement the
 * percentage is null and the state NO_MANDATORY (never a misleading 100%).
 */
export const tenderReadinessSchema = z.strictObject({
  state: z.enum(['NO_MANDATORY', 'NOT_READY', 'READY']),
  percent: z.number().int().min(0).max(100).nullable(),
  mandatoryApplicable: z.number().int(),
  mandatoryApproved: z.number().int(),
  mandatoryMissing: z.number().int(),
  optionalApplicable: z.number().int(),
  optionalApproved: z.number().int(),
  total: z.number().int(),
  blocked: z.number().int(),
  unassigned: z.number().int(),
  /** Detail only (computed from the requirements at read time); null in lists. */
  inProgress: z.number().int().nullable(),
  overdue: z.number().int().nullable(),
});

export const tenderAlertSchema = z.enum([
  'DEADLINE_PASSED',
  'DEADLINE_TOMORROW',
  'DEADLINE_SOON',
  'MANDATORY_MISSING',
  'BLOCKED_REQUIREMENTS',
  'UNASSIGNED_REQUIREMENTS',
  'BID_DECISION_PENDING',
]);

export const tenderRefSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  status: tenderStatusSchema,
});
export const contractRefSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  status: contractStatusSchema,
});

// ---- Tenders ----

export const tenderSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  key: z.string(),
  title: z.string(),
  customer: customerRefSchema.nullable(),
  counterpartyName: z.string().nullable(),
  status: tenderStatusSchema,
  bidDecision: tenderBidDecisionSchema,
  priority: commercialPrioritySchema,
  owner: personRefSchema,
  submissionDeadlineAt: isoDateTimeSchema.nullable(),
  submissionDeadlineTimeZone: z.string().nullable(),
  readiness: tenderReadinessSchema,
  alerts: z.array(tenderAlertSchema),
  /** Present only with `tender.financial.view` on the tender. */
  estimatedValue: moneySchema.optional(),
  updatedAt: isoDateTimeSchema,
  version: z.number().int(),
});

export const tenderAccessSchema = z.strictObject({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canManageRequirements: z.boolean(),
  canDecideBid: z.boolean(),
  canRequestReview: z.boolean(),
  canSubmit: z.boolean(),
  canRecordAward: z.boolean(),
  canRecordLoss: z.boolean(),
  canCreateContract: z.boolean(),
  canManageDocuments: z.boolean(),
  canViewFinancial: z.boolean(),
  canViewConfidentialDocuments: z.boolean(),
  canManageGuarantees: z.boolean(),
  /** Lifecycle targets the caller may move the tender to now. */
  transitions: z.array(tenderStatusSchema),
});

export const tenderSchema = tenderSummarySchema.extend({
  accessLevel: commercialAccessLevelSchema,
  internalReference: z.string().nullable(),
  description: z.string().nullable(),
  relatedProject: projectRefSchema.nullable(),
  tenderType: tenderTypeSchema,
  procurementMethod: z.string().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  clarificationDeadlineAt: isoDateTimeSchema.nullable(),
  technicalLead: personRefSchema.nullable(),
  commercialLead: personRefSchema.nullable(),
  submission: z
    .strictObject({
      method: tenderSubmissionMethodSchema,
      reference: z.string().nullable(),
      submittedAt: isoDateTimeSchema,
      submittedBy: personRefSchema.nullable(),
    })
    .nullable(),
  award: z
    .strictObject({
      awardDate: isoDateSchema,
      reference: z.string().nullable(),
      notes: z.string().nullable(),
      value: moneySchema.optional(),
    })
    .nullable(),
  loss: z
    .strictObject({
      reason: tenderLossReasonSchema,
      winningCompany: z.string().nullable(),
      debriefNotes: z.string().nullable(),
      lessonsLearned: z.string().nullable(),
      winningValue: moneySchema.optional(),
      ourSubmittedValue: moneySchema.optional(),
    })
    .nullable(),
  cancelReason: z.string().nullable(),
  reviewRound: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: personRefSchema.nullable(),
  /** Contracts created from this tender that the caller may view. */
  contracts: z.array(contractRefSchema),
  pendingReviews: z.number().int(),
  access: tenderAccessSchema,
});

export const tenderResponseSchema = dataResponseSchema(tenderSchema);
export const tenderPageResponseSchema = pageResponseSchema(tenderSummarySchema);

export const tenderSortSchema = z.enum(['deadline:asc', 'updatedAt:desc', 'number:desc']);
export const tenderListQuerySchema = z.strictObject({
  ...pageQueryShape,
  q: z.string().trim().min(1).max(100).optional(),
  view: z.enum(['all', 'mine']).optional(),
  status: csvEnum(tenderStatusSchema).optional(),
  bidDecision: csvEnum(tenderBidDecisionSchema).optional(),
  customerId: z.uuid().optional(),
  ownerMemberId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  deadline: z.enum(['next7', 'next30', 'overdue']).optional(),
  readiness: z.enum(['not_ready', 'ready', 'no_mandatory']).optional(),
  /** INTERNAL_REVIEW tenders whose FINAL gate is open. */
  stage: z.enum(['final_approval']).optional(),
  submittedFrom: isoDateSchema.optional(),
  submittedTo: isoDateSchema.optional(),
  awardedFrom: isoDateSchema.optional(),
  closedFrom: isoDateSchema.optional(),
  includeArchived: booleanQuerySchema.optional(),
  sort: tenderSortSchema.optional(),
});

const tenderFieldsShape = {
  title: shortText(300),
  internalReference: optionalText(100),
  description: optionalText(5000),
  customerId: z.uuid().nullable().optional(),
  counterpartyName: optionalText(300),
  relatedProjectId: z.uuid().nullable().optional(),
  tenderType: tenderTypeSchema,
  procurementMethod: optionalText(200),
  publishedAt: isoDateTimeSchema.nullable().optional(),
  submissionDeadlineAt: isoDateTimeSchema.nullable().optional(),
  submissionDeadlineTimeZone: timeZoneSchema.nullable().optional(),
  clarificationDeadlineAt: isoDateTimeSchema.nullable().optional(),
  estimatedValue: moneyAmountSchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
  ownerMemberId: z.uuid(),
  technicalLeadMemberId: z.uuid().nullable().optional(),
  commercialLeadMemberId: z.uuid().nullable().optional(),
  priority: commercialPrioritySchema.optional(),
};

export const createTenderSchema = z.strictObject({
  ...tenderFieldsShape,
  /** Create as DRAFT (default) or directly as NEW (requires a deadline). */
  status: z.enum(['DRAFT', 'NEW']).optional(),
});

export const updateTenderSchema = z.strictObject({
  version: versionSchema,
  title: shortText(300).optional(),
  internalReference: optionalText(100),
  description: optionalText(5000),
  customerId: z.uuid().nullable().optional(),
  counterpartyName: optionalText(300),
  relatedProjectId: z.uuid().nullable().optional(),
  tenderType: tenderTypeSchema.optional(),
  procurementMethod: optionalText(200),
  publishedAt: isoDateTimeSchema.nullable().optional(),
  /** Only while DRAFT/NEW; afterwards deadlines change through an addendum. */
  submissionDeadlineAt: isoDateTimeSchema.nullable().optional(),
  submissionDeadlineTimeZone: timeZoneSchema.nullable().optional(),
  clarificationDeadlineAt: isoDateTimeSchema.nullable().optional(),
  estimatedValue: moneyAmountSchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
  ownerMemberId: z.uuid().optional(),
  technicalLeadMemberId: z.uuid().nullable().optional(),
  commercialLeadMemberId: z.uuid().nullable().optional(),
  priority: commercialPrioritySchema.optional(),
});

export const tenderTransitionSchema = z.strictObject({
  version: versionSchema,
  to: tenderStatusSchema,
  reason: shortText(1000).optional(),
});

export const versionBodySchema = z.strictObject({ version: versionSchema });
export const versionQuerySchema = z.strictObject({ version: z.coerce.number().int().min(1) });

const criteriaShape = {
  technicalFit: bidCriterionValueSchema,
  commercialAttractiveness: bidCriterionValueSchema,
  resourcesAvailable: bidCriterionValueSchema,
  requiredQualificationsAvailable: bidCriterionValueSchema,
  deadlineFeasible: bidCriterionValueSchema,
  strategicCustomer: bidCriterionValueSchema,
  previousExperienceAvailable: bidCriterionValueSchema,
  commercialRisk: bidCriterionValueSchema,
  technicalRisk: bidCriterionValueSchema,
};
export const bidCriteriaSchema = z.strictObject(criteriaShape);

export const bidDecisionRequestSchema = z.strictObject({
  version: versionSchema,
  decision: z.enum(['BID', 'NO_BID']),
  criteria: bidCriteriaSchema,
  noBidReason: noBidReasonSchema.optional(),
  comments: optionalText(2000),
});

export const bidDecisionRecordSchema = z.strictObject({
  id: z.uuid(),
  decision: z.enum(['BID', 'NO_BID']),
  criteria: bidCriteriaSchema,
  noBidReason: noBidReasonSchema.nullable(),
  comments: z.string().nullable(),
  decidedBy: personRefSchema.nullable(),
  decidedAt: isoDateTimeSchema,
});
export const bidDecisionListResponseSchema = listResponseSchema(bidDecisionRecordSchema);

// ---- Requirements ----

export const requirementLinkSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['CORPORATE', 'COMMERCIAL']),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: personRefSchema.nullable(),
  /** Links to documents the caller may not view are omitted entirely (existence included). */
  document: z.strictObject({
    documentId: z.uuid(),
    versionId: z.uuid(),
    title: z.string(),
    type: z.string(),
    versionNumber: z.number().int(),
    attachmentId: z.uuid(),
    expiryDate: isoDateSchema.nullable(),
    /** Corporate versions: valid on the tender's submission deadline (null without expiry or deadline). */
    validOnDeadline: z.boolean().nullable(),
    isCurrentVersion: z.boolean(),
  }),
});

export const tenderRequirementSchema = z.strictObject({
  id: z.uuid(),
  tenderId: z.uuid(),
  category: tenderRequirementCategorySchema,
  title: z.string(),
  description: z.string().nullable(),
  referenceSection: z.string().nullable(),
  owner: personRefSchema.nullable(),
  reviewer: personRefSchema.nullable(),
  dueDate: isoDateSchema.nullable(),
  priority: commercialPrioritySchema,
  mandatory: z.boolean(),
  status: tenderRequirementStatusSchema,
  overdue: z.boolean(),
  notes: z.string().nullable(),
  reviewedBy: personRefSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  links: z.array(requirementLinkSchema),
  version: z.number().int(),
  access: z.strictObject({
    canEdit: z.boolean(),
    canWork: z.boolean(),
    canReview: z.boolean(),
    canLink: z.boolean(),
  }),
});
export const tenderRequirementResponseSchema = dataResponseSchema(tenderRequirementSchema);
export const tenderRequirementListResponseSchema = listResponseSchema(tenderRequirementSchema);

export const createRequirementSchema = z.strictObject({
  category: tenderRequirementCategorySchema,
  title: shortText(300),
  description: optionalText(5000),
  referenceSection: optionalText(200),
  ownerMemberId: z.uuid().nullable().optional(),
  reviewerMemberId: z.uuid().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  priority: commercialPrioritySchema.optional(),
  mandatory: z.boolean().optional(),
  notes: optionalText(5000),
});

export const updateRequirementSchema = z.strictObject({
  version: versionSchema,
  category: tenderRequirementCategorySchema.optional(),
  title: shortText(300).optional(),
  description: optionalText(5000),
  referenceSection: optionalText(200),
  ownerMemberId: z.uuid().nullable().optional(),
  reviewerMemberId: z.uuid().nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  priority: commercialPrioritySchema.optional(),
  mandatory: z.boolean().optional(),
  notes: optionalText(5000),
});

export const requirementStatusRequestSchema = z.strictObject({
  version: versionSchema,
  status: tenderRequirementStatusSchema,
  note: optionalText(2000),
});

export const createRequirementLinkSchema = z
  .strictObject({
    corporateDocumentVersionId: z.uuid().optional(),
    commercialDocumentVersionId: z.uuid().optional(),
    note: optionalText(1000),
  })
  .refine(
    (value) => (value.corporateDocumentVersionId === undefined) !== (value.commercialDocumentVersionId === undefined),
    {
      message: 'exactly one document version is required',
      path: ['corporateDocumentVersionId'],
    },
  );

export const tenderRequirementParamsSchema = z.strictObject({ id: z.uuid(), requirementId: z.uuid() });
export const requirementLinkParamsSchema = z.strictObject({ id: z.uuid(), requirementId: z.uuid(), linkId: z.uuid() });

export const requirementListQuerySchema = z.strictObject({
  status: csvEnum(tenderRequirementStatusSchema).optional(),
  mine: booleanQuerySchema.optional(),
});

/** One requirement of "My tender work" / the manager queues, with its tender. */
export const tenderWorkItemSchema = z.strictObject({
  requirement: z.strictObject({
    id: z.uuid(),
    title: z.string(),
    category: tenderRequirementCategorySchema,
    status: tenderRequirementStatusSchema,
    mandatory: z.boolean(),
    dueDate: isoDateSchema.nullable(),
    overdue: z.boolean(),
    priority: commercialPrioritySchema,
    owner: personRefSchema.nullable(),
    reviewer: personRefSchema.nullable(),
  }),
  tender: z.strictObject({
    id: z.uuid(),
    key: z.string(),
    title: z.string(),
    status: tenderStatusSchema,
    submissionDeadlineAt: isoDateTimeSchema.nullable(),
  }),
  bucket: z.enum(['OVERDUE', 'DUE_TODAY', 'UPCOMING', 'BLOCKED', 'REVIEW', 'UNASSIGNED', 'NO_DUE_DATE']),
});
export const tenderWorkQuerySchema = z.strictObject({
  view: z.enum(['mine', 'unassigned', 'overdue', 'blocked', 'critical']).optional(),
});
export const tenderWorkResponseSchema = dataResponseSchema(
  z.strictObject({
    today: isoDateSchema,
    items: z.array(tenderWorkItemSchema),
    /** Reviews assigned to the caller on open gates. */
    reviews: z.array(
      z.strictObject({
        reviewId: z.uuid(),
        gate: tenderReviewGateTypeSchema,
        tender: tenderRefSchema,
        requestedAt: isoDateTimeSchema,
      }),
    ),
    truncated: z.boolean(),
  }),
);

// ---- Reviews ----

export const requestTenderReviewSchema = z.strictObject({
  version: versionSchema,
  gates: z
    .array(
      z.strictObject({
        gate: tenderReviewGateTypeSchema,
        mode: tenderReviewModeSchema,
        reviewerMemberIds: z.array(z.uuid()).min(1).max(10),
      }),
    )
    .min(1)
    .max(4),
});

export const tenderReviewDecisionRequestSchema = z.strictObject({
  decision: tenderReviewDecisionSchema,
  comment: optionalText(2000),
});

export const tenderReviewParamsSchema = z.strictObject({ id: z.uuid(), reviewId: z.uuid() });

export const tenderReviewGateSchema = z.strictObject({
  id: z.uuid(),
  round: z.number().int(),
  gate: tenderReviewGateTypeSchema,
  mode: tenderReviewModeSchema,
  status: tenderReviewGateStatusSchema,
  openedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  reviews: z.array(
    z.strictObject({
      id: z.uuid(),
      reviewer: personRefSchema,
      status: tenderReviewStatusSchema,
      comment: z.string().nullable(),
      decidedAt: isoDateTimeSchema.nullable(),
      canDecide: z.boolean(),
    }),
  ),
});
export const tenderReviewGateListResponseSchema = listResponseSchema(tenderReviewGateSchema);

// ---- Submission, award, loss ----

export const submitTenderSchema = z.strictObject({
  version: versionSchema,
  method: tenderSubmissionMethodSchema,
  reference: optionalText(200),
  notes: optionalText(2000),
  submittedAt: isoDateTimeSchema,
  evidenceVersionId: z.uuid().nullable().optional(),
});

export const correctSubmissionSchema = z.strictObject({
  method: tenderSubmissionMethodSchema,
  reference: optionalText(200),
  notes: optionalText(2000),
  submittedAt: isoDateTimeSchema,
  evidenceVersionId: z.uuid().nullable().optional(),
  reason: shortText(1000),
});

export const tenderSubmissionSchema = z.strictObject({
  id: z.uuid(),
  kind: tenderSubmissionKindSchema,
  method: tenderSubmissionMethodSchema,
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  submittedAt: isoDateTimeSchema,
  submittedBy: personRefSchema.nullable(),
  evidence: z
    .strictObject({ documentId: z.uuid(), versionId: z.uuid(), title: z.string(), versionNumber: z.number().int() })
    .nullable(),
  correctsSubmissionId: z.uuid().nullable(),
  createdAt: isoDateTimeSchema,
});
export const tenderSubmissionListResponseSchema = listResponseSchema(tenderSubmissionSchema);

export const recordAwardSchema = z.strictObject({
  version: versionSchema,
  awardDate: isoDateSchema,
  awardValue: moneyAmountSchema.nullable().optional(),
  awardCurrency: currencySchema.nullable().optional(),
  awardReference: optionalText(200),
  awardNotes: optionalText(2000),
});

export const recordLossSchema = z.strictObject({
  version: versionSchema,
  lossReason: tenderLossReasonSchema,
  winningCompany: optionalText(300),
  winningValue: moneyAmountSchema.nullable().optional(),
  ourSubmittedValue: moneyAmountSchema.nullable().optional(),
  debriefNotes: optionalText(5000),
  lessonsLearned: optionalText(5000),
});

// ---- Addenda, clarifications ----

export const createAddendumSchema = z
  .strictObject({
    version: versionSchema,
    reference: optionalText(200),
    summary: shortText(2000),
    receivedAt: isoDateTimeSchema,
    documentVersionId: z.uuid().nullable().optional(),
    newDeadlineAt: isoDateTimeSchema.nullable().optional(),
    newTimeZone: timeZoneSchema.nullable().optional(),
  })
  .refine((value) => (value.newDeadlineAt == null) === (value.newTimeZone == null), {
    message: 'a new deadline needs its time zone',
    path: ['newTimeZone'],
  });

export const tenderAddendumSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  reference: z.string().nullable(),
  summary: z.string(),
  receivedAt: isoDateTimeSchema,
  documentVersionId: z.uuid().nullable(),
  previousDeadlineAt: isoDateTimeSchema.nullable(),
  previousTimeZone: z.string().nullable(),
  newDeadlineAt: isoDateTimeSchema.nullable(),
  newTimeZone: z.string().nullable(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export const tenderAddendumListResponseSchema = listResponseSchema(tenderAddendumSchema);

export const createClarificationSchema = z.strictObject({
  question: shortText(5000),
  reference: optionalText(200),
});

export const updateClarificationSchema = z.strictObject({
  version: versionSchema,
  status: tenderClarificationStatusSchema,
  response: optionalText(5000),
});

export const tenderClarificationSchema = z.strictObject({
  id: z.uuid(),
  question: z.string(),
  reference: z.string().nullable(),
  status: tenderClarificationStatusSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  response: z.string().nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
  version: z.number().int(),
});
export const tenderClarificationResponseSchema = dataResponseSchema(tenderClarificationSchema);
export const tenderClarificationListResponseSchema = listResponseSchema(tenderClarificationSchema);
export const clarificationParamsSchema = z.strictObject({ id: z.uuid(), clarificationId: z.uuid() });

// ---- Business timeline ----

export const commercialEventSchema = z.strictObject({
  id: z.uuid(),
  type: z.string(),
  actor: personRefSchema.nullable(),
  /** i18n parameters only; financial values appear only for callers with the financial permission. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: isoDateTimeSchema,
});
export const commercialEventPageResponseSchema = pageResponseSchema(commercialEventSchema);
export const eventPageQuerySchema = z.strictObject({ ...pageQueryShape });

// ---- Tender/contract documents ----

export const commercialDocumentVersionSchema = z.strictObject({
  id: z.uuid(),
  versionNumber: z.number().int(),
  attachmentId: z.uuid(),
  filename: z.string(),
  notes: z.string().nullable(),
  uploadedBy: personRefSchema.nullable(),
  uploadedAt: isoDateTimeSchema,
  /** The version that replaced this one (null for the current version). */
  supersededByVersionId: z.uuid().nullable(),
  isCurrent: z.boolean(),
});

export const commercialDocumentSchema = z.strictObject({
  id: z.uuid(),
  parent: z.strictObject({ type: z.enum(['TENDER', 'CONTRACT']), id: z.uuid() }),
  category: commercialDocumentCategorySchema,
  classification: documentClassificationSchema,
  title: z.string(),
  description: z.string().nullable(),
  currentVersion: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  versions: z.array(commercialDocumentVersionSchema),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
  version: z.number().int(),
  canManage: z.boolean(),
});
export const commercialDocumentResponseSchema = dataResponseSchema(commercialDocumentSchema);
/** Only documents the caller may view; hidden ones are neither listed nor counted. */
export const commercialDocumentListResponseSchema = dataResponseSchema(
  z.strictObject({ items: z.array(commercialDocumentSchema) }),
);

export const createCommercialDocumentSchema = z.strictObject({
  category: commercialDocumentCategorySchema,
  classification: documentClassificationSchema.optional(),
  title: shortText(300),
  description: optionalText(2000),
});

export const addDocumentVersionSchema = z.strictObject({
  attachmentId: z.uuid(),
  notes: optionalText(2000),
});

export const documentParamsSchema = z.strictObject({ documentId: z.uuid() });

// ---- Corporate document vault ----

export const corporateDocumentVersionSchema = z.strictObject({
  id: z.uuid(),
  versionNumber: z.number().int(),
  attachmentId: z.uuid(),
  filename: z.string(),
  issueDate: isoDateSchema.nullable(),
  validFrom: isoDateSchema.nullable(),
  expiryDate: isoDateSchema.nullable(),
  notes: z.string().nullable(),
  uploadedBy: personRefSchema.nullable(),
  uploadedAt: isoDateTimeSchema,
  supersededByVersionId: z.uuid().nullable(),
  isCurrent: z.boolean(),
});

export const corporateDocumentSummarySchema = z.strictObject({
  id: z.uuid(),
  documentType: corporateDocumentTypeSchema,
  title: z.string(),
  documentNumber: z.string().nullable(),
  owner: personRefSchema.nullable(),
  classification: documentClassificationSchema,
  status: corporateDocumentStatusSchema,
  currentVersion: z.number().int(),
  currentExpiryDate: isoDateSchema.nullable(),
  validity: documentValiditySchema,
  daysToExpiry: z.number().int().nullable(),
  updatedAt: isoDateTimeSchema,
  version: z.number().int(),
});

export const corporateDocumentSchema = corporateDocumentSummarySchema.extend({
  notes: z.string().nullable(),
  versions: z.array(corporateDocumentVersionSchema),
  /** Tender requirements linked to a version of this document that the caller may view. */
  linkedRequirements: z.array(
    z.strictObject({
      linkId: z.uuid(),
      versionNumber: z.number().int(),
      requirement: z.strictObject({ id: z.uuid(), title: z.string() }),
      tender: tenderRefSchema,
    }),
  ),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
  canManage: z.boolean(),
});
export const corporateDocumentResponseSchema = dataResponseSchema(corporateDocumentSchema);
export const corporateDocumentPageResponseSchema = pageResponseSchema(corporateDocumentSummarySchema);

export const corporateDocumentListQuerySchema = z.strictObject({
  ...pageQueryShape,
  q: z.string().trim().min(1).max(100).optional(),
  type: csvEnum(corporateDocumentTypeSchema).optional(),
  status: csvEnum(corporateDocumentStatusSchema).optional(),
  validity: csvEnum(documentValiditySchema).optional(),
  /** Current version expires within this many days (inclusive) from the organization's today. */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  ownerMemberId: z.uuid().optional(),
});

export const createCorporateDocumentSchema = z.strictObject({
  documentType: corporateDocumentTypeSchema,
  title: shortText(300),
  documentNumber: optionalText(100),
  ownerMemberId: z.uuid().nullable().optional(),
  classification: documentClassificationSchema.optional(),
  notes: optionalText(5000),
});

export const updateCorporateDocumentSchema = z.strictObject({
  version: versionSchema,
  documentType: corporateDocumentTypeSchema.optional(),
  title: shortText(300).optional(),
  documentNumber: optionalText(100),
  ownerMemberId: z.uuid().nullable().optional(),
  classification: documentClassificationSchema.optional(),
  notes: optionalText(5000),
  /** ARCHIVED removes the document from expiry tracking and new requirement links; ACTIVE restores it. */
  status: corporateDocumentStatusSchema.optional(),
});

export const addCorporateVersionSchema = z
  .strictObject({
    attachmentId: z.uuid(),
    issueDate: isoDateSchema.nullable().optional(),
    validFrom: isoDateSchema.nullable().optional(),
    expiryDate: isoDateSchema.nullable().optional(),
    notes: optionalText(2000),
  })
  .refine((value) => value.expiryDate == null || value.issueDate == null || value.expiryDate >= value.issueDate, {
    message: 'the expiry date cannot precede the issue date',
    path: ['expiryDate'],
  })
  .refine((value) => value.expiryDate == null || value.validFrom == null || value.expiryDate >= value.validFrom, {
    message: 'the expiry date cannot precede the validity start',
    path: ['expiryDate'],
  });

// ---- Contracts ----

export const contractSummarySchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  key: z.string(),
  title: z.string(),
  customer: customerRefSchema.nullable(),
  counterpartyName: z.string().nullable(),
  project: projectRefSchema.nullable(),
  status: contractStatusSchema,
  /** ACTIVE contracts whose current expiry is inside the contract reminder window (derived). */
  expiring: z.boolean(),
  health: commercialHealthSchema,
  healthReasons: z.array(contractHealthReasonSchema),
  owner: personRefSchema,
  currentExpiryDate: isoDateSchema.nullable(),
  renewalNoticeDeadline: isoDateSchema.nullable(),
  /** Present only with `contract.financial.view` on the contract. */
  currentValue: moneySchema.optional(),
  updatedAt: isoDateTimeSchema,
  version: z.number().int(),
});

export const contractAccessSchema = z.strictObject({
  canEdit: z.boolean(),
  canApprove: z.boolean(),
  canManageDocuments: z.boolean(),
  canManageObligations: z.boolean(),
  canManageMilestones: z.boolean(),
  canManageGuarantees: z.boolean(),
  canManageAmendments: z.boolean(),
  canManageRenewal: z.boolean(),
  canViewFinancial: z.boolean(),
  canViewConfidentialDocuments: z.boolean(),
  transitions: z.array(contractStatusSchema),
});

export const contractSchema = contractSummarySchema.extend({
  accessLevel: commercialAccessLevelSchema,
  internalReference: z.string().nullable(),
  description: z.string().nullable(),
  /** Null when there is none or the caller may not view it. */
  sourceTender: tenderRefSchema.nullable(),
  contractType: contractTypeSchema,
  originalValue: moneySchema.optional(),
  signedDate: isoDateSchema.nullable(),
  effectiveDate: isoDateSchema.nullable(),
  startDate: isoDateSchema.nullable(),
  originalExpiryDate: isoDateSchema.nullable(),
  initialTermMonths: z.number().int().nullable(),
  renewalType: contractRenewalTypeSchema,
  noticePeriodDays: z.number().int().nullable(),
  renewalDecisionDate: isoDateSchema.nullable(),
  statusReason: z.string().nullable(),
  warrantyStartDate: isoDateSchema.nullable(),
  warrantyEndDate: isoDateSchema.nullable(),
  supportStartDate: isoDateSchema.nullable(),
  supportEndDate: isoDateSchema.nullable(),
  healthEvaluatedOn: isoDateSchema.nullable(),
  counts: z.strictObject({
    overdueObligations: z.number().int(),
    upcomingObligations: z.number().int(),
    overdueMilestones: z.number().int(),
    activeGuarantees: z.number().int(),
    expiringGuarantees: z.number().int(),
    pendingAmendments: z.number().int(),
  }),
  lastRenewalAction: z.strictObject({ action: renewalActionTypeSchema, createdAt: isoDateTimeSchema }).nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: personRefSchema.nullable(),
  access: contractAccessSchema,
});
export const contractResponseSchema = dataResponseSchema(contractSchema);
export const contractPageResponseSchema = pageResponseSchema(contractSummarySchema);

export const contractSortSchema = z.enum(['expiry:asc', 'updatedAt:desc', 'number:desc']);
export const contractListQuerySchema = z.strictObject({
  ...pageQueryShape,
  q: z.string().trim().min(1).max(100).optional(),
  view: z.enum(['all', 'mine']).optional(),
  status: csvEnum(contractStatusSchema).optional(),
  health: csvEnum(commercialHealthSchema).optional(),
  customerId: z.uuid().optional(),
  ownerMemberId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  sourceTenderId: z.uuid().optional(),
  /** ACTIVE/RENEWAL_REVIEW contracts whose current expiry is within N days of the organization's today. */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  /** Renewal decision needed: renewable type, not yet decided, expiry within 90 days. */
  renewalRequired: booleanQuerySchema.optional(),
  /** Notice deadline within the next 30 days. */
  noticeApproaching: booleanQuerySchema.optional(),
  overdueObligations: booleanQuerySchema.optional(),
  overdueMilestones: booleanQuerySchema.optional(),
  /** Not closed, with an expired guarantee or an active one expiring within 30 days. */
  guaranteesExpiring: booleanQuerySchema.optional(),
  sort: contractSortSchema.optional(),
});

const contractDatesShape = {
  signedDate: isoDateSchema.nullable().optional(),
  effectiveDate: isoDateSchema.nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  initialTermMonths: z.number().int().min(1).max(1200).nullable().optional(),
  renewalType: contractRenewalTypeSchema.optional(),
  noticePeriodDays: z.number().int().min(0).max(3650).nullable().optional(),
  renewalDecisionDate: isoDateSchema.nullable().optional(),
  warrantyStartDate: isoDateSchema.nullable().optional(),
  warrantyEndDate: isoDateSchema.nullable().optional(),
  supportStartDate: isoDateSchema.nullable().optional(),
  supportEndDate: isoDateSchema.nullable().optional(),
};

export const createContractSchema = z.strictObject({
  title: shortText(300),
  internalReference: optionalText(100),
  description: optionalText(5000),
  customerId: z.uuid().nullable().optional(),
  counterpartyName: optionalText(300),
  projectId: z.uuid().nullable().optional(),
  contractType: contractTypeSchema,
  currency: currencySchema,
  originalValue: moneyAmountSchema,
  /** The original expiry; the current expiry starts equal to it. */
  expiryDate: isoDateSchema.nullable().optional(),
  ownerMemberId: z.uuid(),
  ...contractDatesShape,
});

/** Prefill overrides when creating a contract from an awarded tender (unset fields come from the tender). */
export const createContractFromTenderSchema = z.strictObject({
  title: shortText(300).optional(),
  contractType: contractTypeSchema,
  currency: currencySchema.optional(),
  originalValue: moneyAmountSchema.optional(),
  expiryDate: isoDateSchema.nullable().optional(),
  ownerMemberId: z.uuid().optional(),
  projectId: z.uuid().nullable().optional(),
  ...contractDatesShape,
});

export const updateContractSchema = z.strictObject({
  version: versionSchema,
  title: shortText(300).optional(),
  internalReference: optionalText(100),
  description: optionalText(5000),
  customerId: z.uuid().nullable().optional(),
  counterpartyName: optionalText(300),
  projectId: z.uuid().nullable().optional(),
  contractType: contractTypeSchema.optional(),
  ownerMemberId: z.uuid().optional(),
  /** DRAFT only: the baseline is immutable once the contract leaves DRAFT. */
  currency: currencySchema.optional(),
  originalValue: moneyAmountSchema.optional(),
  expiryDate: isoDateSchema.nullable().optional(),
  ...contractDatesShape,
});

export const contractTransitionSchema = z.strictObject({
  version: versionSchema,
  to: contractStatusSchema,
  reason: shortText(1000).optional(),
});

// ---- Obligations ----

export const obligationOccurrenceSchema = z.strictObject({
  id: z.uuid(),
  obligationId: z.uuid(),
  contractId: z.uuid(),
  title: z.string(),
  category: obligationCategorySchema,
  criticality: obligationCriticalitySchema,
  evidenceRequired: z.boolean(),
  dueDate: isoDateSchema,
  status: obligationStatusSchema,
  owner: personRefSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  completedBy: personRefSchema.nullable(),
  completionNote: z.string().nullable(),
  evidenceVersionId: z.uuid().nullable(),
  evidenceAttachments: z.number().int(),
  waivedReason: z.string().nullable(),
  version: z.number().int(),
  canWork: z.boolean(),
});
export const obligationOccurrenceResponseSchema = dataResponseSchema(obligationOccurrenceSchema);

export const contractObligationSchema = z.strictObject({
  id: z.uuid(),
  contractId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  category: obligationCategorySchema,
  owner: personRefSchema.nullable(),
  reviewer: personRefSchema.nullable(),
  priority: commercialPrioritySchema,
  criticality: obligationCriticalitySchema,
  evidenceRequired: z.boolean(),
  recurrence: obligationRecurrenceSchema,
  dueDate: isoDateSchema,
  recurrenceUntil: isoDateSchema.nullable(),
  generatedThrough: isoDateSchema.nullable(),
  notes: z.string().nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  occurrences: z.array(obligationOccurrenceSchema),
  version: z.number().int(),
});
export const contractObligationResponseSchema = dataResponseSchema(contractObligationSchema);
export const contractObligationListResponseSchema = listResponseSchema(contractObligationSchema);

export const createObligationSchema = z
  .strictObject({
    title: shortText(300),
    description: optionalText(5000),
    category: obligationCategorySchema,
    ownerMemberId: z.uuid().nullable().optional(),
    reviewerMemberId: z.uuid().nullable().optional(),
    priority: commercialPrioritySchema.optional(),
    criticality: obligationCriticalitySchema.optional(),
    evidenceRequired: z.boolean().optional(),
    recurrence: obligationRecurrenceSchema.optional(),
    dueDate: isoDateSchema,
    recurrenceUntil: isoDateSchema.nullable().optional(),
    notes: optionalText(5000),
  })
  .refine((value) => value.recurrenceUntil == null || value.recurrenceUntil >= value.dueDate, {
    message: 'the recurrence end cannot precede the first due date',
    path: ['recurrenceUntil'],
  });

export const updateObligationSchema = z.strictObject({
  version: versionSchema,
  title: shortText(300).optional(),
  description: optionalText(5000),
  category: obligationCategorySchema.optional(),
  ownerMemberId: z.uuid().nullable().optional(),
  reviewerMemberId: z.uuid().nullable().optional(),
  priority: commercialPrioritySchema.optional(),
  criticality: obligationCriticalitySchema.optional(),
  evidenceRequired: z.boolean().optional(),
  notes: optionalText(5000),
});

export const occurrenceStatusRequestSchema = z.strictObject({
  version: versionSchema,
  status: z.enum(['IN_PROGRESS', 'COMPLETED', 'WAIVED']),
  note: optionalText(2000),
  evidenceVersionId: z.uuid().nullable().optional(),
  waivedReason: optionalText(1000),
});

export const obligationParamsSchema = z.strictObject({ id: z.uuid(), obligationId: z.uuid() });
export const occurrenceParamsSchema = z.strictObject({ id: z.uuid(), occurrenceId: z.uuid() });
export const occurrenceListQuerySchema = z.strictObject({
  status: csvEnum(obligationStatusSchema).optional(),
});
export const occurrenceListResponseSchema = listResponseSchema(obligationOccurrenceSchema);

// ---- Milestones ----

export const contractMilestoneSchema = z.strictObject({
  id: z.uuid(),
  contractId: z.uuid(),
  project: projectRefSchema.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  owner: personRefSchema.nullable(),
  dueDate: isoDateSchema,
  status: milestoneStatusSchema,
  approvalRequired: z.boolean(),
  submittedAt: isoDateTimeSchema.nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  approvedBy: personRefSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  completedBy: personRefSchema.nullable(),
  evidenceAttachments: z.number().int(),
  version: z.number().int(),
  canWork: z.boolean(),
});
export const contractMilestoneResponseSchema = dataResponseSchema(contractMilestoneSchema);
export const contractMilestoneListResponseSchema = listResponseSchema(contractMilestoneSchema);

export const createMilestoneSchema = z.strictObject({
  title: shortText(300),
  description: optionalText(5000),
  projectId: z.uuid().nullable().optional(),
  ownerMemberId: z.uuid().nullable().optional(),
  dueDate: isoDateSchema,
  approvalRequired: z.boolean().optional(),
});

export const updateMilestoneSchema = z.strictObject({
  version: versionSchema,
  title: shortText(300).optional(),
  description: optionalText(5000),
  projectId: z.uuid().nullable().optional(),
  ownerMemberId: z.uuid().nullable().optional(),
  dueDate: isoDateSchema.optional(),
  approvalRequired: z.boolean().optional(),
});

export const milestoneStatusRequestSchema = z.strictObject({
  version: versionSchema,
  status: z.enum(['IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'COMPLETED', 'CANCELLED']),
  note: optionalText(2000),
});
export const milestoneParamsSchema = z.strictObject({ id: z.uuid(), milestoneId: z.uuid() });

// ---- Guarantees ----

export const guaranteeSchema = z.strictObject({
  id: z.uuid(),
  parent: z.strictObject({ type: z.enum(['TENDER', 'CONTRACT']), id: z.uuid(), key: z.string() }),
  type: guaranteeTypeSchema,
  referenceNumber: z.string(),
  issuer: z.string(),
  beneficiary: z.string().nullable(),
  /** Present only with the parent's financial permission. */
  amount: moneySchema.optional(),
  issueDate: isoDateSchema,
  expiryDate: isoDateSchema,
  releaseDate: isoDateSchema.nullable(),
  owner: personRefSchema.nullable(),
  status: guaranteeStatusSchema,
  daysToExpiry: z.number().int(),
  notes: z.string().nullable(),
  documents: z.number().int(),
  version: z.number().int(),
  canManage: z.boolean(),
});
export const guaranteeResponseSchema = dataResponseSchema(guaranteeSchema);
export const guaranteeListResponseSchema = listResponseSchema(guaranteeSchema);

export const createGuaranteeSchema = z
  .strictObject({
    type: guaranteeTypeSchema,
    referenceNumber: shortText(120),
    issuer: shortText(300),
    beneficiary: optionalText(300),
    amount: moneyAmountSchema.nullable().optional(),
    currency: currencySchema.nullable().optional(),
    issueDate: isoDateSchema,
    expiryDate: isoDateSchema,
    ownerMemberId: z.uuid().nullable().optional(),
    notes: optionalText(2000),
  })
  .refine((value) => value.expiryDate >= value.issueDate, {
    message: 'the expiry date cannot precede the issue date',
    path: ['expiryDate'],
  })
  .refine((value) => value.amount == null || value.currency != null, {
    message: 'an amount needs its currency',
    path: ['currency'],
  });

export const updateGuaranteeSchema = z.strictObject({
  version: versionSchema,
  referenceNumber: shortText(120).optional(),
  issuer: shortText(300).optional(),
  beneficiary: optionalText(300),
  amount: moneyAmountSchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
  issueDate: isoDateSchema.optional(),
  expiryDate: isoDateSchema.optional(),
  ownerMemberId: z.uuid().nullable().optional(),
  notes: optionalText(2000),
});

export const guaranteeStatusRequestSchema = z.strictObject({
  version: versionSchema,
  status: z.enum(['RELEASED', 'CANCELLED']),
  releaseDate: isoDateSchema.optional(),
});
export const guaranteeParamsSchema = z.strictObject({ guaranteeId: z.uuid() });

// ---- Amendments ----

export const contractAmendmentSchema = z.strictObject({
  id: z.uuid(),
  contractId: z.uuid(),
  number: z.number().int(),
  key: z.string(),
  type: contractAmendmentTypeSchema,
  title: z.string(),
  description: z.string().nullable(),
  effectiveDate: isoDateSchema,
  /** Present only with `contract.financial.view`; `hasValueChange` tells everyone a change exists. */
  valueDelta: moneySchema.optional(),
  hasValueChange: z.boolean(),
  newExpiryDate: isoDateSchema.nullable(),
  scopeChangeSummary: z.string().nullable(),
  status: contractAmendmentStatusSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  approvedBy: personRefSchema.nullable(),
  rejectionReason: z.string().nullable(),
  activatedAt: isoDateTimeSchema.nullable(),
  activatedBy: personRefSchema.nullable(),
  documentVersionId: z.uuid().nullable(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
  version: z.number().int(),
  access: z.strictObject({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canApprove: z.boolean(),
    canActivate: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export const contractAmendmentResponseSchema = dataResponseSchema(contractAmendmentSchema);
export const contractAmendmentListResponseSchema = listResponseSchema(contractAmendmentSchema);

export const createAmendmentSchema = z.strictObject({
  type: contractAmendmentTypeSchema,
  title: shortText(300),
  description: optionalText(5000),
  effectiveDate: isoDateSchema,
  valueDelta: signedMoneyAmountSchema.nullable().optional(),
  newExpiryDate: isoDateSchema.nullable().optional(),
  scopeChangeSummary: optionalText(5000),
  documentVersionId: z.uuid().nullable().optional(),
});

export const updateAmendmentSchema = z.strictObject({
  version: versionSchema,
  type: contractAmendmentTypeSchema.optional(),
  title: shortText(300).optional(),
  description: optionalText(5000),
  effectiveDate: isoDateSchema.optional(),
  valueDelta: signedMoneyAmountSchema.nullable().optional(),
  newExpiryDate: isoDateSchema.nullable().optional(),
  scopeChangeSummary: optionalText(5000),
  documentVersionId: z.uuid().nullable().optional(),
});

export const amendmentActionSchema = z.strictObject({
  version: versionSchema,
  action: z.enum(['SUBMIT', 'APPROVE', 'REJECT', 'ACTIVATE', 'CANCEL']),
  reason: shortText(1000).optional(),
});
export const amendmentParamsSchema = z.strictObject({ id: z.uuid(), amendmentId: z.uuid() });

// ---- Renewal ----

export const renewalActionRequestSchema = z.strictObject({
  version: versionSchema,
  action: renewalActionTypeSchema,
  comment: optionalText(2000),
  newExpiryDate: isoDateSchema.nullable().optional(),
  documentVersionId: z.uuid().nullable().optional(),
});

export const renewalActionSchema = z.strictObject({
  id: z.uuid(),
  action: renewalActionTypeSchema,
  comment: z.string().nullable(),
  newExpiryDate: isoDateSchema.nullable(),
  documentVersionId: z.uuid().nullable(),
  actor: personRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export const renewalActionListResponseSchema = listResponseSchema(renewalActionSchema);

// ---- Project commercial tab ----

export const projectCommercialSchema = z.strictObject({
  tenders: z.array(
    z.strictObject({
      id: z.uuid(),
      key: z.string(),
      title: z.string(),
      status: tenderStatusSchema,
      submissionDeadlineAt: isoDateTimeSchema.nullable(),
    }),
  ),
  contracts: z.array(contractSummarySchema),
  upcomingObligations: z.array(obligationOccurrenceSchema),
  milestones: z.array(contractMilestoneSchema),
  guarantees: z.array(guaranteeSchema),
});
export const projectCommercialResponseSchema = dataResponseSchema(projectCommercialSchema);

// ---- Settings ----

const reminderDaysSchema = z.array(z.number().int().min(0).max(3650)).max(10);

export const commercialSettingsSchema = z.strictObject({
  documentReminderDays: z.array(z.number().int()),
  contractReminderDays: z.array(z.number().int()),
  guaranteeReminderDays: z.array(z.number().int()),
  obligationReminderDays: z.array(z.number().int()),
  tenderReminderDays: z.array(z.number().int()),
  version: z.number().int(),
});
export const commercialSettingsResponseSchema = dataResponseSchema(commercialSettingsSchema);

export const updateCommercialSettingsSchema = z.strictObject({
  version: z.number().int().min(0),
  documentReminderDays: reminderDaysSchema.optional(),
  contractReminderDays: reminderDaysSchema.optional(),
  guaranteeReminderDays: reminderDaysSchema.optional(),
  obligationReminderDays: reminderDaysSchema.optional(),
  tenderReminderDays: reminderDaysSchema.optional(),
});

// ---- Reports ----

export const commercialReportSchema = z.enum([
  'tender-pipeline',
  'tender-win-loss',
  'tender-bid-decisions',
  'tender-deadlines',
  'tender-readiness',
  'tender-loss-reasons',
  'tender-workload',
  'contracts-active',
  'contracts-by-customer',
  'contracts-by-value',
  'contracts-expiring',
  'contracts-renewal',
  'obligations-overdue',
  'milestones-upcoming',
  'guarantees-expiring',
  'amendment-history',
]);
export const commercialReportParamsSchema = z.strictObject({ report: commercialReportSchema });
export const commercialReportQuerySchema = z
  .strictObject({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    /** Look-ahead window for expiring/upcoming reports (default 90 days). */
    withinDays: z.coerce.number().int().min(1).max(730).optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

// ---- Params ----

export const tenderIdParamsSchema = z.strictObject({ id: z.uuid() });
export const contractIdParamsSchema = z.strictObject({ id: z.uuid() });

export type TenderStatus = z.infer<typeof tenderStatusSchema>;
export type ContractStatus = z.infer<typeof contractStatusSchema>;
export type TenderListQuery = z.infer<typeof tenderListQuerySchema>;
export type ContractListQuery = z.infer<typeof contractListQuerySchema>;
export type CreateTenderRequest = z.infer<typeof createTenderSchema>;
export type UpdateTenderRequest = z.infer<typeof updateTenderSchema>;
export type CreateContractRequest = z.infer<typeof createContractSchema>;
export type UpdateContractRequest = z.infer<typeof updateContractSchema>;
export type CommercialReport = z.infer<typeof commercialReportSchema>;
export type CorporateDocumentListQuery = z.infer<typeof corporateDocumentListQuerySchema>;
export type TenderTransitionRequest = z.infer<typeof tenderTransitionSchema>;
export type BidDecisionRequest = z.infer<typeof bidDecisionRequestSchema>;
export type BidCriteria = z.infer<typeof bidCriteriaSchema>;
export type CreateRequirementRequest = z.infer<typeof createRequirementSchema>;
export type UpdateRequirementRequest = z.infer<typeof updateRequirementSchema>;
export type RequirementStatusRequest = z.infer<typeof requirementStatusRequestSchema>;
export type CreateRequirementLinkRequest = z.infer<typeof createRequirementLinkSchema>;
export type RequirementListQuery = z.infer<typeof requirementListQuerySchema>;
export type TenderWorkQuery = z.infer<typeof tenderWorkQuerySchema>;
export type RequestTenderReviewRequest = z.infer<typeof requestTenderReviewSchema>;
export type TenderReviewDecisionRequest = z.infer<typeof tenderReviewDecisionRequestSchema>;
export type SubmitTenderRequest = z.infer<typeof submitTenderSchema>;
export type CorrectSubmissionRequest = z.infer<typeof correctSubmissionSchema>;
export type RecordAwardRequest = z.infer<typeof recordAwardSchema>;
export type RecordLossRequest = z.infer<typeof recordLossSchema>;
export type CreateAddendumRequest = z.infer<typeof createAddendumSchema>;
export type CreateClarificationRequest = z.infer<typeof createClarificationSchema>;
export type UpdateClarificationRequest = z.infer<typeof updateClarificationSchema>;
export type CreateCommercialDocumentRequest = z.infer<typeof createCommercialDocumentSchema>;
export type AddDocumentVersionRequest = z.infer<typeof addDocumentVersionSchema>;
export type CreateCorporateDocumentRequest = z.infer<typeof createCorporateDocumentSchema>;
export type UpdateCorporateDocumentRequest = z.infer<typeof updateCorporateDocumentSchema>;
export type AddCorporateVersionRequest = z.infer<typeof addCorporateVersionSchema>;
export type CreateContractFromTenderRequest = z.infer<typeof createContractFromTenderSchema>;
export type ContractTransitionRequest = z.infer<typeof contractTransitionSchema>;
export type CreateObligationRequest = z.infer<typeof createObligationSchema>;
export type UpdateObligationRequest = z.infer<typeof updateObligationSchema>;
export type OccurrenceStatusRequest = z.infer<typeof occurrenceStatusRequestSchema>;
export type OccurrenceListQuery = z.infer<typeof occurrenceListQuerySchema>;
export type CreateMilestoneRequest = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneRequest = z.infer<typeof updateMilestoneSchema>;
export type MilestoneStatusRequest = z.infer<typeof milestoneStatusRequestSchema>;
export type CreateGuaranteeRequest = z.infer<typeof createGuaranteeSchema>;
export type UpdateGuaranteeRequest = z.infer<typeof updateGuaranteeSchema>;
export type GuaranteeStatusRequest = z.infer<typeof guaranteeStatusRequestSchema>;
export type CreateAmendmentRequest = z.infer<typeof createAmendmentSchema>;
export type UpdateAmendmentRequest = z.infer<typeof updateAmendmentSchema>;
export type AmendmentActionRequest = z.infer<typeof amendmentActionSchema>;
export type RenewalActionRequest = z.infer<typeof renewalActionRequestSchema>;
export type UpdateCommercialSettingsRequest = z.infer<typeof updateCommercialSettingsSchema>;
export type CommercialReportQuery = z.infer<typeof commercialReportQuerySchema>;
