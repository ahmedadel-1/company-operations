import { ATTENDANCE_CORRECTION_TYPE_KEY, conditionIssues, FORM_LIMITS } from '@company-ops/validation';
import type { Condition, FormField, FormSchema, WorkflowContent } from '@company-ops/validation';

import { evaluateCondition } from './conditions.js';
import type { NormalizedData } from './conditions.js';

export type StepKind = 'APPROVAL' | 'FULFILLMENT';
export type ApprovalMode = 'ANY_ONE' | 'ALL';
export type ApproverType =
  'DIRECT_MANAGER' | 'DEPARTMENT_MANAGER' | 'TEAM_LEAD' | 'PROJECT_MANAGER' | 'TECHNICAL_MANAGER' | 'ROLE' | 'MEMBER';

/** A persisted step, as the engine sees it. */
export interface EngineStep {
  readonly order: number;
  readonly kind: StepKind;
  readonly mode: ApprovalMode;
  readonly approverType: ApproverType | null;
  readonly approverMemberId: string | null;
  readonly approverRoleId: string | null;
  readonly projectField: string | null;
  readonly condition: Condition | null;
  readonly slaHours: number | null;
}

export interface WorkflowIssue {
  readonly path: string;
  readonly code: string;
}

/** Form keys the attendance correction type must keep; the attendance module reads them (ADR-0022). */
export const CORRECTION_FORM_CONTRACT = {
  workDate: 'workDate',
  reasonCode: 'reasonCode',
  checkIn: 'checkIn',
  checkOut: 'checkOut',
  details: 'details',
} as const;

// ---- Publishing ----

/**
 * Structural checks a workflow version must pass before it can be published (ADR-0021). References to
 * members and roles are checked by the caller against the database.
 */
export function workflowPublishIssues(content: WorkflowContent, typeKey?: string): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (path: string, code: string): void => {
    issues.push({ path, code });
  };
  const fields = new Map<string, FormField>(content.form.fields.map((field) => [field.key, field]));

  if (JSON.stringify(content.form).length > FORM_LIMITS.maxSchemaBytes) add('form', 'too_large');

  const steps = content.steps;
  if (!steps.some((step) => step.kind === 'APPROVAL')) add('steps', 'approval_required');
  const first = steps[0];
  if (
    first !== undefined &&
    (first.kind !== 'APPROVAL' || (first.condition !== undefined && first.condition !== null))
  ) {
    add('steps.0', 'first_step_unconditional_approval');
  }
  let seenFulfillment = false;
  steps.forEach((step, index) => {
    const at = `steps.${String(index)}`;
    if (step.kind === 'FULFILLMENT') {
      seenFulfillment = true;
      if (step.approver !== undefined) add(`${at}.approver`, 'not_allowed');
      if (step.mode !== undefined && step.mode !== 'ANY_ONE') add(`${at}.mode`, 'not_allowed');
      if (step.slaHours !== undefined && step.slaHours !== null) add(`${at}.slaHours`, 'not_allowed');
    } else {
      if (seenFulfillment) add(at, 'approval_after_fulfillment');
      const approver = step.approver;
      if (approver === undefined) {
        add(`${at}.approver`, 'required');
      } else {
        const needsMember = approver.type === 'MEMBER';
        const needsRole = approver.type === 'ROLE';
        const needsProject = approver.type === 'PROJECT_MANAGER' || approver.type === 'TECHNICAL_MANAGER';
        if (needsMember !== (approver.memberId !== undefined))
          add(`${at}.approver.memberId`, needsMember ? 'required' : 'not_allowed');
        if (needsRole !== (approver.roleId !== undefined))
          add(`${at}.approver.roleId`, needsRole ? 'required' : 'not_allowed');
        if (needsProject !== (approver.projectField !== undefined)) {
          add(`${at}.approver.projectField`, needsProject ? 'required' : 'not_allowed');
        } else if (approver.projectField !== undefined && fields.get(approver.projectField)?.type !== 'project') {
          add(`${at}.approver.projectField`, 'invalid');
        }
      }
    }
    if (step.condition !== undefined && step.condition !== null) {
      for (const issue of conditionIssues(step.condition, fields)) {
        add(`${at}.condition.${issue.path.join('.')}`, 'invalid');
      }
    }
  });

  const attendance = content.effects.attendance;
  const requiredField = (key: string, types: readonly FormField['type'][], path: string): FormField | null => {
    const field = fields.get(key);
    if (field === undefined || !types.includes(field.type)) {
      add(path, 'invalid');
      return null;
    }
    if (field.type === 'info' || field.required !== true || field.visibleWhen !== undefined) {
      add(path, 'must_be_required');
      return null;
    }
    return field;
  };
  if (attendance !== undefined) {
    const timed = attendance.fromTimeField !== undefined || attendance.toTimeField !== undefined;
    requiredField(
      attendance.dateField,
      timed || attendance.mode === 'CORRECTION' ? ['date'] : ['date', 'date_range'],
      'effects.attendance.dateField',
    );
    if (timed) {
      if (attendance.mode !== 'SHORT_LEAVE') {
        add('effects.attendance.fromTimeField', 'not_allowed');
      } else {
        for (const [key, path] of [
          [attendance.fromTimeField, 'effects.attendance.fromTimeField'],
          [attendance.toTimeField, 'effects.attendance.toTimeField'],
        ] as const) {
          if (key === undefined) add(path, 'required');
          else requiredField(key, ['time'], path);
        }
        if (attendance.fromTimeField === attendance.toTimeField) add('effects.attendance.toTimeField', 'invalid');
      }
    }
    if (attendance.mode === 'CORRECTION' && typeKey !== ATTENDANCE_CORRECTION_TYPE_KEY) {
      add('effects.attendance.mode', 'reserved');
    }
  }
  if (typeKey === ATTENDANCE_CORRECTION_TYPE_KEY) {
    if (attendance?.mode !== 'CORRECTION' || attendance.dateField !== CORRECTION_FORM_CONTRACT.workDate) {
      add('effects.attendance', 'reserved_contract');
    }
    requiredField(CORRECTION_FORM_CONTRACT.workDate, ['date'], 'form.fields.workDate');
    requiredField(CORRECTION_FORM_CONTRACT.reasonCode, ['select'], 'form.fields.reasonCode');
    requiredField(CORRECTION_FORM_CONTRACT.details, ['textarea', 'text'], 'form.fields.details');
    for (const key of [CORRECTION_FORM_CONTRACT.checkIn, CORRECTION_FORM_CONTRACT.checkOut]) {
      if (fields.get(key)?.type !== 'time') add(`form.fields.${key}`, 'invalid');
    }
  }
  const { requirement, maxFiles } = content.attachments;
  if (requirement !== 'NONE' && maxFiles < 1) add('attachments.maxFiles', 'too_small');
  return issues;
}

// ---- Route planning ----

/** Step orders that apply to a submission, in order. Conditions are evaluated once over the immutable data. */
export function planRoute(steps: readonly EngineStep[], data: NormalizedData): number[] {
  return [...steps]
    .sort((left, right) => left.order - right.order)
    .filter((step) => evaluateCondition(step.condition, data))
    .map((step) => step.order);
}

/** The next applicable step after `current` (null when the route is exhausted). */
export function nextInRoute(route: readonly number[], current: number | null): number | null {
  const next = route.find((order) => current === null || order > current);
  return next ?? null;
}

// ---- Approver resolution ----

/** Organization facts needed to resolve approvers for one requester, loaded by persistence. */
export interface ApproverDirectory {
  readonly requesterMemberId: string;
  readonly directManagerMemberId: string | null;
  /** Managers of the requester's department, then of each parent department up to the root. */
  readonly departmentManagerChain: readonly (string | null)[];
  /** Leads of the requester's (non-archived) teams. */
  readonly teamLeadMemberIds: readonly string[];
  readonly projects: ReadonlyMap<
    string,
    { readonly managerMemberId: string | null; readonly technicalManagerMemberId: string | null }
  >;
  readonly roleHolders: ReadonlyMap<string, readonly string[]>;
  /**
   * Members who may approve at all: active membership with a sign-in identity, employment ACTIVE or
   * ON_LEAVE, holding `request.approve`.
   */
  readonly eligibleMemberIds: ReadonlySet<string>;
}

export type Resolution =
  | { readonly ok: true; readonly memberIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'NO_CANDIDATE' | 'TOO_MANY' };

/**
 * Who must approve `step` for this requester (ADR-0021). Never the requester; never a member who is not
 * eligible. Rules never read requester-filled member fields, so a requester cannot pick their approver.
 */
export function resolveApprovers(step: EngineStep, data: NormalizedData, directory: ApproverDirectory): Resolution {
  const usable = (memberId: string | null | undefined): memberId is string =>
    typeof memberId === 'string' &&
    memberId !== directory.requesterMemberId &&
    directory.eligibleMemberIds.has(memberId);

  let candidates: string[] = [];
  switch (step.approverType) {
    case 'DIRECT_MANAGER':
      candidates = usable(directory.directManagerMemberId) ? [directory.directManagerMemberId] : [];
      break;
    case 'DEPARTMENT_MANAGER': {
      const manager = directory.departmentManagerChain.find(usable);
      candidates = manager === undefined ? [] : [manager];
      break;
    }
    case 'TEAM_LEAD':
      candidates = directory.teamLeadMemberIds.filter(usable);
      break;
    case 'PROJECT_MANAGER':
    case 'TECHNICAL_MANAGER': {
      const projectId = step.projectField === null ? undefined : data[step.projectField];
      const project = typeof projectId === 'string' ? directory.projects.get(projectId) : undefined;
      const memberId =
        step.approverType === 'PROJECT_MANAGER' ? project?.managerMemberId : project?.technicalManagerMemberId;
      candidates = usable(memberId) ? [memberId] : [];
      break;
    }
    case 'ROLE':
      candidates = (step.approverRoleId === null ? [] : (directory.roleHolders.get(step.approverRoleId) ?? [])).filter(
        usable,
      );
      break;
    case 'MEMBER':
      candidates = usable(step.approverMemberId) ? [step.approverMemberId] : [];
      break;
    case null:
      candidates = [];
  }
  const unique = [...new Set(candidates)].sort();
  if (unique.length === 0) return { ok: false, reason: 'NO_CANDIDATE' };
  if (unique.length > FORM_LIMITS.maxStepApprovers) {
    if (step.mode === 'ALL') return { ok: false, reason: 'TOO_MANY' };
    return { ok: true, memberIds: unique.slice(0, FORM_LIMITS.maxStepApprovers) };
  }
  return { ok: true, memberIds: unique };
}

// ---- Decisions ----

export type AssignmentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';

export interface Assignment {
  readonly id: string;
  readonly status: AssignmentStatus;
}

export type StepOutcome =
  | { readonly kind: 'OPEN' }
  | { readonly kind: 'COMPLETED'; readonly supersede: readonly string[] }
  | { readonly kind: 'REJECTED'; readonly supersede: readonly string[] };

/**
 * Outcome of a step after one assignment was decided (`assignments` already reflects the decision).
 * ANY_ONE completes on the first approval; ALL needs every live assignment approved; any rejection
 * rejects. Remaining pending assignments are superseded when the step closes.
 */
export function stepOutcome(mode: ApprovalMode, assignments: readonly Assignment[]): StepOutcome {
  const live = assignments.filter((assignment) => assignment.status !== 'SUPERSEDED');
  const pending = live.filter((assignment) => assignment.status === 'PENDING').map((assignment) => assignment.id);
  if (live.some((assignment) => assignment.status === 'REJECTED')) return { kind: 'REJECTED', supersede: pending };
  const approved = live.filter((assignment) => assignment.status === 'APPROVED').length;
  if (mode === 'ANY_ONE' && approved > 0) return { kind: 'COMPLETED', supersede: pending };
  if (mode === 'ALL' && approved > 0 && pending.length === 0) return { kind: 'COMPLETED', supersede: [] };
  return { kind: 'OPEN' };
}

export type Progression =
  | { readonly kind: 'ACTIVATE_APPROVAL'; readonly order: number }
  | { readonly kind: 'APPROVED'; readonly fulfillmentOrders: readonly number[] };

/** What follows a completed approval step: the next applicable approval step, or final approval. */
export function progressAfterApproval(
  route: readonly number[],
  steps: ReadonlyMap<number, EngineStep>,
  completed: number,
): Progression {
  const remaining = route.filter((order) => order > completed);
  const nextApproval = remaining.find((order) => steps.get(order)?.kind === 'APPROVAL');
  if (nextApproval !== undefined) return { kind: 'ACTIVATE_APPROVAL', order: nextApproval };
  return { kind: 'APPROVED', fulfillmentOrders: remaining.filter((order) => steps.get(order)?.kind === 'FULFILLMENT') };
}

/** Applicable fulfillment steps of a route, in order. */
export function fulfillmentOrders(route: readonly number[], steps: ReadonlyMap<number, EngineStep>): number[] {
  return route.filter((order) => steps.get(order)?.kind === 'FULFILLMENT');
}

// ---- Effects and dates ----

export interface AttendanceEffect {
  readonly mode: 'LEAVE' | 'REMOTE' | 'BUSINESS_MISSION' | 'SHORT_LEAVE' | 'CORRECTION';
  readonly startsOn: string;
  readonly endsOn: string;
  /** SHORT_LEAVE window in local minutes of the day ([start, end)), when the version declares time fields. */
  readonly startsAtMinute: number | null;
  readonly endsAtMinute: number | null;
}

const minuteOf = (value: NormalizedData[string] | undefined): number | null => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * Submission checks that need more than one field: a SHORT_LEAVE window must end after it starts on the
 * same day (overnight permissions are expressed as leave).
 */
export function effectSubmissionIssues(effects: WorkflowContent['effects'], data: NormalizedData): WorkflowIssue[] {
  const attendance = effects.attendance;
  if (attendance?.fromTimeField === undefined || attendance.toTimeField === undefined) return [];
  const from = minuteOf(data[attendance.fromTimeField]);
  const to = minuteOf(data[attendance.toTimeField]);
  if (from === null || to === null) return [];
  return to > from ? [] : [{ path: attendance.toTimeField, code: 'must_be_after_start' }];
}

const dateSpan = (value: NormalizedData[string] | undefined): { start: string; end: string } | null => {
  if (typeof value === 'string') return { start: value, end: value };
  if (typeof value === 'object' && !Array.isArray(value) && 'start' in value)
    return { start: value.start, end: value.end };
  return null;
};

/** The attendance effect of an approved request, or null when the version declares none. */
export function attendanceEffect(effects: WorkflowContent['effects'], data: NormalizedData): AttendanceEffect | null {
  const attendance = effects.attendance;
  if (attendance === undefined) return null;
  const span = dateSpan(data[attendance.dateField]);
  if (span === null) return null;
  const from = attendance.fromTimeField === undefined ? null : minuteOf(data[attendance.fromTimeField]);
  const to = attendance.toTimeField === undefined ? null : minuteOf(data[attendance.toTimeField]);
  const windowed = from !== null && to !== null && to > from;
  return {
    mode: attendance.mode,
    startsOn: span.start,
    endsOn: span.end,
    startsAtMinute: windowed ? from : null,
    endsAtMinute: windowed ? to : null,
  };
}

/**
 * Dates of a request for lists and calendars: the effect's date field when declared, otherwise the first
 * date or date range with a value.
 */
export function requestDates(
  form: FormSchema,
  effects: WorkflowContent['effects'],
  data: NormalizedData,
): { startsOn: string; endsOn: string } | null {
  const preferred = effects.attendance?.dateField;
  const keys = [
    ...(preferred === undefined ? [] : [preferred]),
    ...form.fields.filter((field) => field.type === 'date_range' || field.type === 'date').map((field) => field.key),
  ];
  for (const key of keys) {
    const span = dateSpan(data[key]);
    if (span !== null) return { startsOn: span.start, endsOn: span.end };
  }
  return null;
}
