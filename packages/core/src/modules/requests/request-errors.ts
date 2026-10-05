import { ERROR_CODES } from '@company-ops/shared';

import { DomainError } from '../../platform/errors.js';

/** A step of the workflow has no eligible approver; nothing was submitted (ADR-0021). */
export class RequestApproverUnresolvedError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.REQUEST_APPROVER_UNRESOLVED;

  constructor(stepOrders: readonly number[]) {
    super('No approver could be found for this request. Contact your administrator.', { steps: [...stepOrders] });
  }
}

/** The draft was filled in against a workflow version that is no longer current. */
export class RequestFormOutdatedError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.REQUEST_FORM_OUTDATED;

  constructor() {
    super('The form of this request type has changed. Review the draft and submit again.');
  }
}

/** The approval was already decided, superseded, or the request moved on. */
export class RequestAlreadyDecidedError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.REQUEST_ALREADY_DECIDED;

  constructor() {
    super('This approval has already been decided or is no longer open.');
  }
}
