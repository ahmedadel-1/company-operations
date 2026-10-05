import type { Prisma, RequestApprovalStatus, RequestStatus } from '@company-ops/db';
import { requestTypeIconSchema } from '@company-ops/validation';
import type { FormSchema, LocalizedText, RequestFormData, WorkflowContent } from '@company-ops/validation';

import { toDateOnly } from '../projects/business-date.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import type { TicketPersonRef } from '../support/ticket-views.js';
import { stepOutcome } from './engine/workflow.js';
import { requestKey } from './request-access.js';
import { parseLabel, parseLongLabel } from './request-config.js';
import type { LoadedStep } from './request-config.js';

export type PersonRef = TicketPersonRef;
export type RequestTypeIcon = (typeof requestTypeIconSchema.options)[number];
export type RequestCategory = 'HR' | 'IT' | 'FINANCE' | 'ACCESS' | 'OPERATIONS' | 'OTHER';

export interface RequestTypeRefView {
  readonly id: string;
  readonly key: string;
  readonly name: LocalizedText;
  readonly category: RequestCategory;
  readonly icon: RequestTypeIcon;
}

export const requestTypeRefSelect = {
  id: true,
  key: true,
  name: true,
  category: true,
  icon: true,
} satisfies Prisma.RequestTypeSelect;

export function toTypeRef(
  row: Prisma.RequestTypeGetPayload<{ select: typeof requestTypeRefSelect }>,
): RequestTypeRefView {
  const icon = requestTypeIconSchema.safeParse(row.icon);
  return {
    id: row.id,
    key: row.key,
    name: parseLabel(row.name),
    category: row.category,
    icon: icon.success ? icon.data : 'file-text',
  };
}

export const requestSummarySelect = {
  id: true,
  number: true,
  status: true,
  currentStepOrder: true,
  startsOn: true,
  endsOn: true,
  submittedAt: true,
  decidedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  requestType: { select: requestTypeRefSelect },
  requester: { select: memberRefSelect },
  project: { select: { id: true, code: true, name: true } },
  workflowVersion: { select: { steps: { select: { stepOrder: true, name: true }, orderBy: { stepOrder: 'asc' } } } },
} satisfies Prisma.RequestInstanceSelect;

export type RequestSummaryRow = Prisma.RequestInstanceGetPayload<{ select: typeof requestSummarySelect }>;

export interface RequestSummaryView {
  readonly id: string;
  readonly number: number;
  readonly key: string;
  readonly status: RequestStatus;
  readonly requestType: RequestTypeRefView;
  readonly requester: PersonRef;
  readonly project: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly currentStep: { readonly order: number; readonly name: LocalizedText } | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toRequestSummary(row: RequestSummaryRow): RequestSummaryView {
  const step =
    row.currentStepOrder === null
      ? undefined
      : row.workflowVersion.steps.find((item) => item.stepOrder === row.currentStepOrder);
  return {
    id: row.id,
    number: row.number,
    key: requestKey(row.number),
    status: row.status,
    requestType: toTypeRef(row.requestType),
    requester: toPersonRef(row.requester),
    project: row.project,
    currentStep: step === undefined ? null : { order: step.stepOrder, name: parseLabel(step.name) },
    startsOn: toDateOnly(row.startsOn),
    endsOn: toDateOnly(row.endsOn),
    submittedAt: iso(row.submittedAt),
    decidedAt: iso(row.decidedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const approvalViewSelect = {
  id: true,
  stepOrder: true,
  status: true,
  comment: true,
  decidedAt: true,
  dueAt: true,
  delegationId: true,
  approverMemberId: true,
  approver: { select: memberRefSelect },
  decidedBy: { select: memberRefSelect },
} satisfies Prisma.RequestApprovalSelect;

export type ApprovalViewRow = Prisma.RequestApprovalGetPayload<{ select: typeof approvalViewSelect }>;

export interface RequestApprovalView {
  readonly id: string;
  readonly approver: PersonRef;
  readonly status: RequestApprovalStatus;
  readonly decidedBy: PersonRef | null;
  readonly delegated: boolean;
  readonly comment: string | null;
  readonly decidedAt: string | null;
  readonly dueAt: string | null;
}

export type StepState = 'NOT_REACHED' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED' | 'REJECTED' | 'CANCELLED';

export interface RequestStepView {
  readonly order: number;
  readonly kind: 'APPROVAL' | 'FULFILLMENT';
  readonly name: LocalizedText;
  readonly mode: 'ANY_ONE' | 'ALL';
  readonly state: StepState;
  readonly unassigned: boolean;
  readonly approvals: readonly RequestApprovalView[];
}

export interface RequestAccessView {
  readonly canEdit: boolean;
  readonly canSubmit: boolean;
  readonly canCancel: boolean;
  readonly canAttach: boolean;
  readonly decidableApprovalIds: readonly string[];
  readonly fulfillmentAction: 'START' | 'COMPLETE_STEP' | null;
  readonly canReassign: boolean;
}

export interface RequestView extends RequestSummaryView {
  readonly version: number;
  readonly workflowVersion: { readonly id: string; readonly number: number };
  readonly form: FormSchema;
  readonly formData: RequestFormData;
  readonly attachments: WorkflowContent['attachments'];
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly steps: readonly RequestStepView[];
  /** Display names of the members and projects referenced by `formData`. */
  readonly references: {
    readonly members: readonly PersonRef[];
    readonly projects: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  };
  readonly access: RequestAccessView;
}

function toApprovalView(row: ApprovalViewRow): RequestApprovalView {
  return {
    id: row.id,
    approver: toPersonRef(row.approver),
    status: row.status,
    decidedBy: row.decidedBy === null ? null : toPersonRef(row.decidedBy),
    delegated: row.delegationId !== null,
    comment: row.comment,
    decidedAt: iso(row.decidedAt),
    dueAt: iso(row.dueAt),
  };
}

const PAST_APPROVAL: ReadonlySet<RequestStatus> = new Set(['APPROVED', 'IN_FULFILLMENT', 'COMPLETED']);

/** Per-step progress for the request timeline, derived from the stored route and frozen approvals. */
export function toStepViews(
  status: RequestStatus,
  route: readonly number[],
  currentStepOrder: number | null,
  steps: readonly LoadedStep[],
  approvals: readonly ApprovalViewRow[],
): RequestStepView[] {
  const submitted = status !== 'DRAFT' && route.length > 0;
  return steps.map((step) => {
    const rows = approvals.filter((approval) => approval.stepOrder === step.order);
    const inRoute = route.includes(step.order);
    let state: StepState = 'NOT_REACHED';
    if (submitted && !inRoute) {
      state = 'SKIPPED';
    } else if (step.kind === 'APPROVAL') {
      const outcome = stepOutcome(step.mode, rows);
      if (outcome.kind === 'REJECTED') state = 'REJECTED';
      else if (outcome.kind === 'COMPLETED') state = 'COMPLETED';
      else if (status === 'PENDING_APPROVAL' && currentStepOrder === step.order) state = 'ACTIVE';
      else if (status === 'CANCELLED' && rows.length > 0) state = 'CANCELLED';
    } else if (inRoute) {
      if (status === 'COMPLETED') state = 'COMPLETED';
      else if (status === 'IN_FULFILLMENT' && currentStepOrder !== null) {
        state =
          step.order < currentStepOrder ? 'COMPLETED' : step.order === currentStepOrder ? 'ACTIVE' : 'NOT_REACHED';
      } else if (status === 'CANCELLED' && currentStepOrder === step.order) state = 'CANCELLED';
    }
    if (state === 'NOT_REACHED' && step.kind === 'APPROVAL' && PAST_APPROVAL.has(status) && inRoute) {
      state = 'COMPLETED';
    }
    return {
      order: step.order,
      kind: step.kind,
      name: step.name,
      mode: step.mode,
      state,
      unassigned: state === 'ACTIVE' && step.kind === 'APPROVAL' && !rows.some((row) => row.status === 'PENDING'),
      approvals: rows.map(toApprovalView),
    };
  });
}

export const eventViewSelect = {
  id: true,
  type: true,
  stepOrder: true,
  metadata: true,
  createdAt: true,
  actorMember: { select: memberRefSelect },
} satisfies Prisma.RequestEventSelect;

export type EventViewRow = Prisma.RequestEventGetPayload<{ select: typeof eventViewSelect }>;

export interface RequestEventView {
  readonly id: string;
  readonly type: string;
  readonly actor: PersonRef | null;
  readonly stepOrder: number | null;
  readonly subject: PersonRef | null;
  readonly note: string | null;
  readonly createdAt: string;
}

const metadataString = (metadata: Prisma.JsonValue, key: string): string | null => {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
};

export function eventSubjectId(row: EventViewRow): string | null {
  return metadataString(row.metadata, 'subjectMemberId');
}

export function toEventView(row: EventViewRow, subjects: ReadonlyMap<string, PersonRef>): RequestEventView {
  const subjectId = eventSubjectId(row);
  return {
    id: row.id,
    type: row.type,
    actor: row.actorMember === null ? null : toPersonRef(row.actorMember),
    stepOrder: row.stepOrder,
    subject: subjectId === null ? null : (subjects.get(subjectId) ?? null),
    note: metadataString(row.metadata, 'note'),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RequestTypeCatalogItemView extends RequestTypeRefView {
  readonly description: LocalizedText | null;
}

export function toCatalogItem(
  row: Prisma.RequestTypeGetPayload<{ select: typeof requestTypeRefSelect & { description: true } }>,
): RequestTypeCatalogItemView {
  return { ...toTypeRef(row), description: parseLongLabel(row.description) };
}
