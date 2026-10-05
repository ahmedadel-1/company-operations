import { formDataSchema } from '@company-ops/validation';
import type { FormSchema, RequestFormData } from '@company-ops/validation';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { fulfillmentOrders } from './engine/workflow.js';
import { canFulfil, isRequestAdmin, loadVisibleRequest } from './request-access.js';
import type { LoadedRequest } from './request-access.js';
import { mustLoadVersion } from './request-config.js';
import { approvalViewSelect, requestSummarySelect, toRequestSummary, toStepViews } from './request-views.js';
import type { RequestAccessView, RequestView } from './request-views.js';

const ADMIN_CANCELLABLE = new Set(['PENDING_APPROVAL', 'APPROVED', 'IN_FULFILLMENT']);

/** Full request view for a caller who may see it (visibility is re-checked here). */
export async function buildRequestView(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  requestId: string,
  now: Date,
  preloaded?: LoadedRequest,
): Promise<RequestView> {
  const loaded = preloaded ?? (await loadVisibleRequest(db, action, organizationId, requestId, now));
  const row = await db.requestInstance.findFirstOrThrow({
    where: { organizationId, id: requestId },
    select: {
      ...requestSummarySelect,
      version: true,
      workflowVersionId: true,
      formData: true,
      route: true,
      cancelledAt: true,
      cancelReason: true,
      workflowVersion: {
        select: { number: true, steps: { select: { stepOrder: true, name: true }, orderBy: { stepOrder: 'asc' } } },
      },
    },
  });
  const version = await mustLoadVersion(db, organizationId, row.workflowVersionId);
  const approvals = await db.requestApproval.findMany({
    where: { organizationId, requestId },
    orderBy: [{ stepOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: approvalViewSelect,
  });
  const requester = row.requester.id === action.principal.memberId;
  const admin = isRequestAdmin(action.principal);
  const fulfiller = !requester && canFulfil(action.principal, loaded);
  const hasFulfillment = fulfillmentOrders(row.route, version.stepsByOrder).length > 0;
  const access: RequestAccessView = {
    canEdit: requester && row.status === 'DRAFT',
    canSubmit: requester && row.status === 'DRAFT',
    canCancel:
      (requester && (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL')) ||
      (admin && ADMIN_CANCELLABLE.has(row.status)),
    canAttach: requester && row.status === 'DRAFT' && version.attachments.requirement !== 'NONE',
    decidableApprovalIds: loaded.involvement.decidable.map((item) => item.approvalId),
    fulfillmentAction:
      fulfiller && row.status === 'APPROVED' && hasFulfillment
        ? 'START'
        : fulfiller && row.status === 'IN_FULFILLMENT'
          ? 'COMPLETE_STEP'
          : null,
    canReassign: admin && row.status === 'PENDING_APPROVAL',
  };
  const formData = formDataSchema.parse(row.formData);
  return {
    ...toRequestSummary(row),
    version: row.version,
    workflowVersion: { id: row.workflowVersionId, number: row.workflowVersion.number },
    form: version.form,
    formData,
    attachments: version.attachments,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    steps: toStepViews(row.status, row.route, row.currentStepOrder, version.steps, approvals),
    references: await loadReferences(db, organizationId, version.form, formData),
    access,
  };
}

/** Names for the member and project ids in the form data (only ids of this organization resolve). */
async function loadReferences(
  db: TenantDb,
  organizationId: string,
  form: FormSchema,
  formData: RequestFormData,
): Promise<RequestView['references']> {
  const idsOf = (type: 'member' | 'project'): string[] => [
    ...new Set(
      form.fields
        .filter((field) => field.type === type)
        .map((field) => formData[field.key])
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
  const memberIds = idsOf('member');
  const projectIds = idsOf('project');
  const members =
    memberIds.length === 0
      ? []
      : await db.organizationMember.findMany({
          where: { organizationId, id: { in: memberIds } },
          select: memberRefSelect,
        });
  const projects =
    projectIds.length === 0
      ? []
      : await db.project.findMany({
          where: { organizationId, id: { in: projectIds } },
          select: { id: true, code: true, name: true },
        });
  return { members: members.map(toPersonRef), projects };
}
