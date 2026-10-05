import type { TenderRequirementStatus } from '@company-ops/db';

/**
 * The one readiness formula (ADR-0026, spec §16), used by the tender detail, list, dashboard,
 * needs-attention and reports:
 *
 *   percent = approved applicable mandatory / applicable mandatory   (rounded down)
 *
 * NOT_APPLICABLE requirements are excluded from every denominator. With no applicable mandatory
 * requirement the state is NO_MANDATORY and the percentage null, never a misleading 100%. Optional
 * requirements are counted separately and never affect the state.
 */
export interface RequirementFacts {
  readonly status: TenderRequirementStatus;
  readonly mandatory: boolean;
  readonly ownerMemberId: string | null;
  readonly dueDate: string | null;
}

/** Counters stored on the tender, recomputed in the transaction of every requirement change. */
export interface ReadinessCounters {
  readonly requirementsTotal: number;
  readonly mandatoryApplicable: number;
  readonly mandatoryApproved: number;
  readonly optionalApplicable: number;
  readonly optionalApproved: number;
  readonly blockedRequirements: number;
  readonly unassignedRequirements: number;
}

export type ReadinessState = 'NO_MANDATORY' | 'NOT_READY' | 'READY';

export interface ReadinessView {
  readonly state: ReadinessState;
  readonly percent: number | null;
  readonly mandatoryApplicable: number;
  readonly mandatoryApproved: number;
  readonly mandatoryMissing: number;
  readonly optionalApplicable: number;
  readonly optionalApproved: number;
  readonly total: number;
  readonly blocked: number;
  readonly unassigned: number;
  readonly inProgress: number | null;
  readonly overdue: number | null;
}

const IN_PROGRESS: readonly TenderRequirementStatus[] = ['IN_PROGRESS', 'READY_FOR_REVIEW', 'CHANGES_REQUIRED'];

export function readinessCounters(requirements: readonly RequirementFacts[]): ReadinessCounters {
  let mandatoryApplicable = 0;
  let mandatoryApproved = 0;
  let optionalApplicable = 0;
  let optionalApproved = 0;
  let blocked = 0;
  let unassigned = 0;
  for (const requirement of requirements) {
    if (requirement.status === 'NOT_APPLICABLE') {
      continue;
    }
    const approved = requirement.status === 'APPROVED';
    if (requirement.mandatory) {
      mandatoryApplicable += 1;
      if (approved) mandatoryApproved += 1;
    } else {
      optionalApplicable += 1;
      if (approved) optionalApproved += 1;
    }
    if (requirement.status === 'BLOCKED') blocked += 1;
    if (requirement.ownerMemberId === null && !approved) unassigned += 1;
  }
  return {
    requirementsTotal: requirements.length,
    mandatoryApplicable,
    mandatoryApproved,
    optionalApplicable,
    optionalApproved,
    blockedRequirements: blocked,
    unassignedRequirements: unassigned,
  };
}

export function readinessState(
  counters: Pick<ReadinessCounters, 'mandatoryApplicable' | 'mandatoryApproved'>,
): ReadinessState {
  if (counters.mandatoryApplicable === 0) return 'NO_MANDATORY';
  return counters.mandatoryApproved >= counters.mandatoryApplicable ? 'READY' : 'NOT_READY';
}

export function readinessPercent(
  counters: Pick<ReadinessCounters, 'mandatoryApplicable' | 'mandatoryApproved'>,
): number | null {
  if (counters.mandatoryApplicable === 0) return null;
  return Math.floor((counters.mandatoryApproved * 100) / counters.mandatoryApplicable);
}

/** An open requirement past its due date in the organization's zone (`today` is that local date). */
export function isRequirementOverdue(
  requirement: Pick<RequirementFacts, 'status' | 'dueDate'>,
  today: string,
): boolean {
  return (
    requirement.dueDate !== null &&
    requirement.dueDate < today &&
    requirement.status !== 'APPROVED' &&
    requirement.status !== 'NOT_APPLICABLE'
  );
}

/**
 * The readiness view. `details` (the requirements themselves) adds the read-time counters
 * (in progress, overdue); lists pass null and get them as null.
 */
export function readinessView(
  counters: ReadinessCounters,
  details: { readonly requirements: readonly RequirementFacts[]; readonly today: string } | null,
): ReadinessView {
  return {
    state: readinessState(counters),
    percent: readinessPercent(counters),
    mandatoryApplicable: counters.mandatoryApplicable,
    mandatoryApproved: counters.mandatoryApproved,
    mandatoryMissing: counters.mandatoryApplicable - counters.mandatoryApproved,
    optionalApplicable: counters.optionalApplicable,
    optionalApproved: counters.optionalApproved,
    total: counters.requirementsTotal,
    blocked: counters.blockedRequirements,
    unassigned: counters.unassignedRequirements,
    inProgress: details === null ? null : details.requirements.filter((r) => IN_PROGRESS.includes(r.status)).length,
    overdue:
      details === null ? null : details.requirements.filter((r) => isRequirementOverdue(r, details.today)).length,
  };
}

/**
 * Requirement status changes a member may make. Owners work the requirement (NOT_STARTED,
 * IN_PROGRESS, READY_FOR_REVIEW, BLOCKED); the reviewer (or a requirement manager) decides
 * (APPROVED, CHANGES_REQUIRED); NOT_APPLICABLE is a scoping decision of requirement managers.
 */
export type RequirementActor = 'MANAGER' | 'OWNER' | 'REVIEWER';

const WORK_TARGETS: readonly TenderRequirementStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED'];
const REVIEW_TARGETS: readonly TenderRequirementStatus[] = ['APPROVED', 'CHANGES_REQUIRED'];

export function requirementTransitionAllowed(
  from: TenderRequirementStatus,
  to: TenderRequirementStatus,
  actors: ReadonlySet<RequirementActor>,
): boolean {
  if (from === to) return false;
  if (to === 'NOT_APPLICABLE') return actors.has('MANAGER');
  if (from === 'NOT_APPLICABLE') return actors.has('MANAGER') && to === 'NOT_STARTED';
  if (REVIEW_TARGETS.includes(to)) {
    return (actors.has('REVIEWER') || actors.has('MANAGER')) && from === 'READY_FOR_REVIEW';
  }
  if (WORK_TARGETS.includes(to)) {
    if (!(actors.has('OWNER') || actors.has('MANAGER'))) return false;
    // Reopening an approved requirement is a manager decision (it lowers readiness).
    if (from === 'APPROVED') return actors.has('MANAGER');
    return true;
  }
  return false;
}
