import { randomUUID } from 'node:crypto';

import { workflowContentSchema } from '@company-ops/validation';
import type { RequestFormData, WorkflowContent } from '@company-ops/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { AttachmentService } from '../../src/modules/attachments/attachment.service.js';
import { ApprovalService } from '../../src/modules/requests/approval.service.js';
import { DelegationService } from '../../src/modules/requests/delegation.service.js';
import { RequestAttachmentPolicy } from '../../src/modules/requests/request-attachment-policy.js';
import {
  RequestAlreadyDecidedError,
  RequestApproverUnresolvedError,
  RequestFormOutdatedError,
} from '../../src/modules/requests/request-errors.js';
import { RequestTypeAdminService } from '../../src/modules/requests/request-type-admin.service.js';
import type { RequestView } from '../../src/modules/requests/request-views.js';
import { RequestService } from '../../src/modules/requests/request.service.js';
import { Prisma } from '../../src/platform/db/prisma.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidFieldsError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../src/platform/errors.js';
import { NO_SCAN } from '../../src/platform/storage/storage-port.js';
import type { StoragePort } from '../../src/platform/storage/storage-port.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Requests and approvals (ADR-0021) against PostgreSQL 18 with the real migrations and the development
 * seed: versioned workflows (immutable once published, in the service and the database), submission,
 * approver resolution, ANY/ALL steps, conditional routes, concurrency, delegation, fulfillment,
 * cancellation, effects, notifications, attachments, tenant isolation and append-only history.
 *
 * Actors (seed): EMP-00001 org admin, EMP-00003 HR admin (request.admin + request.fulfill), EMP-00002
 * general manager (no manager), EMP-00009 employee whose manager is EMP-00008 (team lead) in a department
 * managed by EMP-00007, EMP-00010 a colleague (SELF scope), EMP-00013 the other team lead, NW-001 a
 * member of another organization.
 */
let s: SeededDatabase;
let types: RequestTypeAdminService;
let requests: RequestService;
let approvals: ApprovalService;
let delegations: DelegationService;
let attachments: AttachmentService;

let admin: ActionContext;
let hr: ActionContext;
let gm: ActionContext;
let requester: ActionContext;
let lead: ActionContext;
let deptManager: ActionContext;
let colleague: ActionContext;
let otherLead: ActionContext;
let foreign: ActionContext;

const storage: StoragePort = {
  presignUpload: ({ key }) => Promise.resolve(`http://storage.test/${key}?signed`),
  presignDownload: ({ key }) => Promise.resolve(`http://storage.test/${key}?download`),
  head: () => Promise.resolve(null),
  read: () => Promise.reject(new Error('missing object')),
  delete: () => Promise.resolve(),
};

const roleId = async (key: string): Promise<string> =>
  (await s.prisma.role.findFirstOrThrow({ where: { organizationId: s.demoId, key }, select: { id: true } })).id;

const MANAGER_STEP = {
  kind: 'APPROVAL',
  name: { en: 'Manager approval' },
  mode: 'ANY_ONE',
  approver: { type: 'DIRECT_MANAGER' },
  condition: null,
  slaHours: 24,
} as const;
const NOTIFY = { emailApprovers: true, emailRequester: true } as const;
const REASON_FORM = {
  fields: [{ key: 'reason', type: 'textarea', label: { en: 'Reason' }, required: true, maxLength: 500 }],
} as const;

const content = (value: unknown): WorkflowContent => workflowContentSchema.parse(value);

const simpleContent = (
  steps: readonly unknown[] = [MANAGER_STEP],
  extra: Record<string, unknown> = {},
): WorkflowContent =>
  content({
    form: REASON_FORM,
    steps,
    attachments: { requirement: 'NONE', maxFiles: 0 },
    effects: {},
    notifications: NOTIFY,
    ...extra,
  });

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
};

/** Creates, publishes and activates a request type as the org admin. */
const publishType = async (
  workflow: WorkflowContent,
  options: { requesterRoleIds?: string[] } = {},
): Promise<{ typeId: string; versionId: string }> => {
  const key = `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const created = await s.as(admin, () =>
    types.create(admin, {
      key,
      name: { en: `Type ${key}`, ar: `نوع ${key}` },
      category: 'OTHER',
      icon: 'file-text',
      ...options,
    }),
  );
  const draft = must(created.draftVersion, 'draft');
  const saved = await s.as(admin, () => types.updateDraft(admin, created.id, draft.id, workflow, draft.revision));
  const published = await s.as(admin, () => types.publish(admin, created.id, draft.id, saved.revision));
  const current = await s.as(admin, () => types.get(admin, created.id));
  await s.as(admin, () => types.update(admin, created.id, { version: current.version, active: true }));
  return { typeId: created.id, versionId: published.id };
};

const submit = (
  actor: ActionContext,
  requestTypeId: string,
  formData: RequestFormData,
  key?: string,
): Promise<RequestView> => s.as(actor, () => requests.create(actor, { requestTypeId, formData, submit: true }, key));

const view = (actor: ActionContext, id: string): Promise<RequestView> => s.as(actor, () => requests.get(actor, id));

/** The pending approval of `member` on the request (read as an administrator). */
const pendingFor = async (requestId: string, member: ActionContext): Promise<string> => {
  const row = await s.prisma.requestApproval.findFirstOrThrow({
    where: { requestId, approverMemberId: member.principal.memberId, status: 'PENDING' },
    select: { id: true },
  });
  return row.id;
};

const approve = (actor: ActionContext, approvalId: string, comment?: string): Promise<RequestView> =>
  s.as(actor, () => approvals.approve(actor, approvalId, comment));

const eventTypes = async (requestId: string): Promise<string[]> =>
  (
    await s.prisma.requestEvent.findMany({
      where: { requestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true },
    })
  ).map((row) => row.type);

const notificationsFor = async (requestId: string, type: string) =>
  (
    await s.prisma.outboxEvent.findMany({
      where: { organizationId: s.demoId, eventType: 'notification.requested', aggregateId: requestId },
      select: { payload: true },
    })
  )
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload.type === type);

beforeAll(async () => {
  s = await startSeededDatabase();
  types = new RequestTypeAdminService(s.tenantDb, s.tenant);
  requests = new RequestService(s.tenantDb, s.tenant);
  approvals = new ApprovalService(s.tenantDb, s.tenant);
  delegations = new DelegationService(s.tenantDb, s.tenant);
  attachments = new AttachmentService(s.tenantDb, s.tenant, storage, [new RequestAttachmentPolicy(requests)], NO_SCAN);
  admin = await s.actionFor('EMP-00001');
  gm = await s.actionFor('EMP-00002');
  hr = await s.actionFor('EMP-00003');
  deptManager = await s.actionFor('EMP-00007');
  lead = await s.actionFor('EMP-00008');
  requester = await s.actionFor('EMP-00009');
  colleague = await s.actionFor('EMP-00010');
  otherLead = await s.actionFor('EMP-00013');
  foreign = await s.actionFor('NW-001', s.northwindId);
}, 240_000);

afterAll(async () => {
  await s.stop();
});

describe('seeded request types', () => {
  it('seeds the six demo types, active, each with one published version', async () => {
    const rows = await s.prisma.requestType.findMany({
      where: {
        organizationId: s.demoId,
        key: { in: ['leave', 'work_from_home', 'laptop', 'software_access', 'purchase', 'business_mission'] },
      },
      select: { key: true, active: true, definition: { select: { versions: { select: { status: true } } } } },
    });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.active).toBe(true);
      expect(row.definition?.versions.map((version) => version.status)).toEqual(['PUBLISHED']);
    }
  });
});

describe('workflow versions', () => {
  it('keeps published versions immutable in the service and in the database', async () => {
    const { typeId, versionId } = await publishType(
      simpleContent([MANAGER_STEP, { kind: 'FULFILLMENT', name: { en: 'Deliver' }, condition: null }]),
    );
    await expect(
      s.as(admin, () => types.updateDraft(admin, typeId, versionId, simpleContent(), 1)),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(s.as(admin, () => types.publish(admin, typeId, versionId, 1))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    const sql = async (statement: string) => (await s.db.psql('ops_app', statement)).output;
    expect(await sql(`UPDATE workflow_versions SET form_schema = '{"fields":[]}' WHERE id = '${versionId}';`)).toMatch(
      /immutable/,
    );
    expect(await sql(`UPDATE workflow_steps SET sla_hours = 1 WHERE version_id = '${versionId}';`)).toMatch(
      /immutable/,
    );
    expect(
      await sql(
        `INSERT INTO workflow_steps (id, organization_id, version_id, step_order, kind, name, mode) VALUES (gen_random_uuid(), '${s.demoId}', '${versionId}', 3, 'FULFILLMENT', '{"en":"x"}', 'ANY_ONE');`,
      ),
    ).toMatch(/immutable/);
    expect(await sql(`DELETE FROM workflow_versions WHERE id = '${versionId}';`)).toMatch(
      /cannot be deleted|permission denied/,
    );
  });

  it('edits a published workflow as a new draft version without changing requests on the old one', async () => {
    const { typeId, versionId } = await publishType(simpleContent());
    const old = await submit(requester, typeId, { reason: 'Before the change' });
    expect(old.workflowVersion).toEqual({ id: versionId, number: 1 });

    const draft = await s.as(admin, () => types.createDraft(admin, typeId));
    expect(draft).toMatchObject({ number: 2, status: 'DRAFT', editable: true });
    await expect(s.as(admin, () => types.createDraft(admin, typeId))).rejects.toBeInstanceOf(ConflictError);
    const changed = content({
      form: { fields: [...REASON_FORM.fields, { key: 'urgent', type: 'boolean', label: { en: 'Urgent' } }] },
      steps: [MANAGER_STEP, { ...MANAGER_STEP, name: { en: 'Department' }, approver: { type: 'DEPARTMENT_MANAGER' } }],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {},
      notifications: NOTIFY,
    });
    const saved = await s.as(admin, () => types.updateDraft(admin, typeId, draft.id, changed, draft.revision));
    await expect(
      s.as(admin, () => types.updateDraft(admin, typeId, draft.id, changed, draft.revision)),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await s.as(admin, () => types.publish(admin, typeId, draft.id, saved.revision));

    const versions = await s.as(admin, () => types.listVersions(admin, typeId, {}));
    expect(versions.items.map((item) => [item.number, item.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'RETIRED'],
    ]);
    const reread = await view(requester, old.id);
    expect(reread.workflowVersion.number).toBe(1);
    expect(reread.form.fields.map((field) => field.key)).toEqual(['reason']);
    expect(reread.steps.map((step) => step.order)).toEqual([1]);
    const fresh = await submit(requester, typeId, { reason: 'After the change', urgent: true });
    expect(fresh.workflowVersion.number).toBe(2);
    expect(fresh.steps).toHaveLength(2);
  });

  it('refuses to submit a draft request whose pinned version was replaced', async () => {
    const { typeId } = await publishType(simpleContent());
    const draftRequest = await s.as(requester, () =>
      requests.create(requester, { requestTypeId: typeId, formData: { reason: 'Draft' } }),
    );
    const draft = await s.as(admin, () => types.createDraft(admin, typeId));
    await s.as(admin, () => types.publish(admin, typeId, draft.id, draft.revision));
    await expect(
      s.as(requester, () => requests.submit(requester, draftRequest.id, draftRequest.version)),
    ).rejects.toBeInstanceOf(RequestFormOutdatedError);
  });

  it('rejects unsafe or invalid workflows at publish time', async () => {
    const created = await s.as(admin, () =>
      types.create(admin, {
        key: `bad_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
        name: { en: 'Bad' },
        category: 'OTHER',
        icon: 'file-text',
      }),
    );
    const draft = must(created.draftVersion, 'draft');
    const conditionalFirst = simpleContent([
      { ...MANAGER_STEP, condition: { match: 'all', rules: [{ field: 'reason', op: 'isSet' }] } },
    ]);
    const saved = await s.as(admin, () =>
      types.updateDraft(admin, created.id, draft.id, conditionalFirst, draft.revision),
    );
    const publishing = s.as(admin, () => types.publish(admin, created.id, draft.id, saved.revision));
    await expect(publishing).rejects.toBeInstanceOf(InvalidFieldsError);
    await expect(publishing).rejects.toMatchObject({ code: 'WORKFLOW_INVALID' });

    // Drafts may be saved half-finished, but a condition on an unknown field never publishes.
    const unknownField = simpleContent([
      MANAGER_STEP,
      { ...MANAGER_STEP, condition: { match: 'all', rules: [{ field: 'nope', op: 'isSet' }] } },
    ]);
    const withUnknown = await s.as(admin, () =>
      types.updateDraft(admin, created.id, draft.id, unknownField, saved.revision),
    );
    await expect(
      s.as(admin, () => types.publish(admin, created.id, draft.id, withUnknown.revision)),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_INVALID',
      fieldErrors: [{ path: 'steps.1.condition.rules.0', code: 'invalid' }],
    });

    // A role approver must hold request.approve: a custom role without it cannot be used.
    const silent = await s.prisma.role.create({
      data: { organizationId: s.demoId, key: `SILENT_${randomUUID().slice(0, 8).toUpperCase()}`, name: 'No approvals' },
    });
    const roleStep = simpleContent([MANAGER_STEP, { ...MANAGER_STEP, approver: { type: 'ROLE', roleId: silent.id } }]);
    const withRole = await s.as(admin, () =>
      types.updateDraft(admin, created.id, draft.id, roleStep, withUnknown.revision),
    );
    await expect(
      s.as(admin, () => types.publish(admin, created.id, draft.id, withRole.revision)),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_INVALID',
    });
    // Another organization's role is not even a valid reference.
    const nwRole = await s.prisma.role.findFirstOrThrow({
      where: { organizationId: s.northwindId },
      select: { id: true },
    });
    await expect(
      s.as(admin, () =>
        types.updateDraft(
          admin,
          created.id,
          draft.id,
          simpleContent([MANAGER_STEP, { ...MANAGER_STEP, approver: { type: 'ROLE', roleId: nwRole.id } }]),
          withRole.revision,
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidFieldsError);
  });

  it('limits administration to request.admin and audits configuration changes', async () => {
    await expect(s.as(requester, () => types.list(requester))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(lead, () =>
        types.create(lead, { key: 'nope_type', name: { en: 'x' }, category: 'OTHER', icon: 'file-text' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { typeId, versionId } = await publishType(simpleContent());
    await expect(s.as(foreign, () => requests.form(foreign, typeId))).rejects.toBeInstanceOf(NotFoundError);
    const audit = await s.prisma.auditLog.findMany({
      where: { organizationId: s.demoId, entityId: { in: [typeId, versionId] } },
      select: { action: true, actorMemberId: true },
    });
    expect(audit.map((row) => row.action).sort()).toEqual([
      'request_type.activated',
      'request_type.created',
      'workflow.published',
    ]);
    expect(new Set(audit.map((row) => row.actorMemberId))).toEqual(new Set([admin.principal.memberId]));
  });
});

describe('submission', () => {
  it('numbers requests, pins the version and freezes the approvers resolved at activation', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Conference travel' });
    expect(created).toMatchObject({ status: 'PENDING_APPROVAL', key: `REQ-${String(created.number)}` });
    expect(created.steps[0]?.approvals.map((approval) => approval.approver.memberId)).toEqual([
      lead.principal.memberId,
    ]);

    // A later change of manager does not move an assignment that already exists.
    const profile = await s.employee('EMP-00009');
    const otherLeadProfile = await s.employee('EMP-00013');
    const original = await s.prisma.employeeProfile.findUniqueOrThrow({
      where: { id: profile.profileId },
      select: { managerProfileId: true },
    });
    await s.prisma.employeeProfile.update({
      where: { id: profile.profileId },
      data: { managerProfileId: otherLeadProfile.profileId },
    });
    try {
      const reread = await view(requester, created.id);
      expect(reread.steps[0]?.approvals.map((approval) => approval.approver.memberId)).toEqual([
        lead.principal.memberId,
      ]);
      await expect(approve(otherLead, await pendingFor(created.id, lead))).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await s.prisma.employeeProfile.update({
        where: { id: profile.profileId },
        data: { managerProfileId: original.managerProfileId },
      });
    }
    expect(await eventTypes(created.id)).toEqual(['CREATED', 'SUBMITTED', 'STEP_ACTIVATED']);
  });

  it('replays an idempotent submission and rejects a reused key with different content', async () => {
    const { typeId } = await publishType(simpleContent());
    const key = randomUUID();
    const first = await submit(requester, typeId, { reason: 'Same' }, key);
    const replay = await submit(requester, typeId, { reason: 'Same' }, key);
    expect(replay.id).toBe(first.id);
    await expect(submit(requester, typeId, { reason: 'Different' }, key)).rejects.toBeInstanceOf(ConflictError);
    expect(await s.prisma.requestInstance.count({ where: { organizationId: s.demoId, idempotencyKey: key } })).toBe(1);
  });

  it('validates form data on the server: required, unknown and hidden fields, sizes and injection', async () => {
    const { typeId } = await publishType(
      content({
        form: {
          fields: [
            {
              key: 'kind',
              type: 'select',
              label: { en: 'Kind' },
              required: true,
              options: [
                { value: 'a', label: { en: 'A' } },
                { value: 'b', label: { en: 'B' } },
              ],
            },
            {
              key: 'detail',
              type: 'text',
              label: { en: 'Detail' },
              maxLength: 20,
              visibleWhen: { match: 'all', rules: [{ field: 'kind', op: 'eq', value: 'b' }] },
            },
            { key: 'amount', type: 'number', label: { en: 'Amount' }, min: 1, max: 10 },
          ],
        },
        steps: [MANAGER_STEP],
        attachments: { requirement: 'NONE', maxFiles: 0 },
        effects: {},
        notifications: NOTIFY,
      }),
    );
    const fieldErrors = async (formData: RequestFormData) => {
      const error: unknown = await submit(requester, typeId, formData).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(InvalidFieldsError);
      return (error as InvalidFieldsError).fieldErrors.map((field) => `${field.path}:${field.code}`).sort();
    };
    expect(await fieldErrors({})).toEqual(['formData.kind:required']);
    expect(await fieldErrors({ kind: 'c' })).toEqual(['formData.kind:not_allowed']);
    expect(await fieldErrors({ kind: 'a', injected: '<script>alert(1)</script>' })).toEqual([
      'formData.injected:unknown',
    ]);
    expect(await fieldErrors({ kind: 'a', detail: 'smuggled' })).toEqual(['formData.detail:hidden']);
    expect(await fieldErrors({ kind: 'b', detail: 'x'.repeat(21) })).toEqual(['formData.detail:too_long']);
    expect(await fieldErrors({ kind: 'a', amount: 11 })).toEqual(['formData.amount:too_large']);
    // Markup is stored as plain text, never interpreted.
    const ok = await submit(requester, typeId, { kind: 'b', detail: '<b>bold</b>' });
    expect(ok.formData.detail).toBe('<b>bold</b>');
    expect(
      await s.prisma.requestInstance.count({
        where: { requesterMemberId: requester.principal.memberId, requestTypeId: typeId },
      }),
    ).toBe(1);
  });

  it('never auto-approves: an unresolvable approver fails the submission and nothing is stored', async () => {
    const { typeId } = await publishType(simpleContent());
    // The general manager has no manager.
    await expect(submit(gm, typeId, { reason: 'Mine' })).rejects.toBeInstanceOf(RequestApproverUnresolvedError);
    // Self-approval is impossible: the only holder of the role is the requester.
    const sole = await publishType(
      simpleContent([{ ...MANAGER_STEP, approver: { type: 'ROLE', roleId: await roleId('GENERAL_MANAGER') } }]),
    );
    await expect(submit(gm, sole.typeId, { reason: 'Mine' })).rejects.toBeInstanceOf(RequestApproverUnresolvedError);
    expect(await s.prisma.requestInstance.count({ where: { requestTypeId: { in: [typeId, sole.typeId] } } })).toBe(0);
  });

  it('restricts types to their requester roles', async () => {
    const { typeId } = await publishType(simpleContent(), { requesterRoleIds: [await roleId('HR_ADMIN')] });
    await expect(submit(requester, typeId, { reason: 'Not for me' })).rejects.toBeInstanceOf(NotFoundError);
    const catalog = await s.as(requester, () => requests.catalog(requester));
    expect(catalog.some((item) => item.id === typeId)).toBe(false);
  });
});

describe('approvals', () => {
  it('lists assignments in the inbox, approves with a comment and notifies the requester', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Inbox' });
    const inbox = await s.as(lead, () => approvals.inbox(lead, {}));
    const item = inbox.items.find((entry) => entry.request.id === created.id);
    expect(item).toBeDefined();
    expect(item?.onBehalfOf).toBeNull();
    expect(
      (await s.as(requester, () => approvals.inbox(requester, {}))).items.some(
        (entry) => entry.request.id === created.id,
      ),
    ).toBe(false);

    const approved = await approve(lead, must(item, 'item').approvalId, 'Enjoy the trip');
    expect(approved.status).toBe('APPROVED');
    expect(approved.steps[0]?.approvals[0]).toMatchObject({
      status: 'APPROVED',
      comment: 'Enjoy the trip',
      delegated: false,
    });
    expect(await eventTypes(created.id)).toEqual([
      'CREATED',
      'SUBMITTED',
      'STEP_ACTIVATED',
      'APPROVED',
      'STEP_COMPLETED',
    ]);
    const assigned = await notificationsFor(created.id, 'REQUEST_APPROVAL_ASSIGNED');
    expect(assigned).toEqual([expect.objectContaining({ recipientMemberId: lead.principal.memberId, email: true })]);
    expect(assigned[0]?.params).toMatchObject({ requestNumber: created.key });
    // Notifications never carry form contents or comments.
    for (const payload of [...assigned, ...(await notificationsFor(created.id, 'REQUEST_APPROVED'))]) {
      expect(Object.keys(payload.params as object).sort()).toEqual(['requestNumber', 'typeName', 'typeNameAr']);
      expect(JSON.stringify(payload)).not.toContain('Inbox');
    }
    const approvedNotices = await notificationsFor(created.id, 'REQUEST_APPROVED');
    expect(approvedNotices.map((notice) => notice.recipientMemberId)).toEqual([requester.principal.memberId]);
    expect(approvedNotices[0]?.dedupeKey).toContain(created.id);
  });

  it('rejects with a reason that the requester can read', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Reject me' });
    const approvalId = await pendingFor(created.id, lead);
    const rejected = await s.as(lead, () => approvals.reject(lead, approvalId, 'Budget is frozen'));
    expect(rejected.status).toBe('REJECTED');
    const reread = await view(requester, created.id);
    expect(reread.steps[0]?.approvals[0]).toMatchObject({ status: 'REJECTED', comment: 'Budget is frozen' });
    expect(await notificationsFor(created.id, 'REQUEST_REJECTED')).toHaveLength(1);
  });

  it('refuses approvals by members who are not assigned (404 when invisible, 403 when visible)', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Guarded' });
    const approvalId = await pendingFor(created.id, lead);
    await expect(approve(colleague, approvalId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(view(colleague, created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(approve(deptManager, approvalId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approve(requester, approvalId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approve(foreign, approvalId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(approve(lead, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    expect((await view(requester, created.id)).status).toBe('PENDING_APPROVAL');
  });

  it('treats a repeated identical decision as a replay and any other second decision as already decided', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Twice' });
    const approvalId = await pendingFor(created.id, lead);
    await approve(lead, approvalId);
    const replay = await approve(lead, approvalId);
    expect(replay.status).toBe('APPROVED');
    await expect(s.as(lead, () => approvals.reject(lead, approvalId, 'Changed my mind'))).rejects.toBeInstanceOf(
      RequestAlreadyDecidedError,
    );
    expect((await eventTypes(created.id)).filter((type) => type === 'APPROVED')).toHaveLength(1);
  });

  it('lets exactly one of two concurrent ANY-ONE approvers decide', async () => {
    const { typeId } = await publishType(
      simpleContent([{ ...MANAGER_STEP, approver: { type: 'ROLE', roleId: await roleId('TEAM_LEAD') } }]),
    );
    const created = await submit(requester, typeId, { reason: 'Race' });
    const [first, second] = await Promise.allSettled([
      approve(lead, await pendingFor(created.id, lead)),
      s.as(otherLead, async () => approvals.reject(otherLead, await pendingFor(created.id, otherLead), 'No')),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const failure = [first, second].find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' ? failure.reason : null).toBeInstanceOf(RequestAlreadyDecidedError);
    const rows = await s.prisma.requestApproval.findMany({
      where: { requestId: created.id },
      select: { status: true },
    });
    expect(rows.map((row) => row.status).sort()).toEqual(
      first.status === 'fulfilled' ? ['APPROVED', 'SUPERSEDED'] : ['REJECTED', 'SUPERSEDED'],
    );
    const decisions = (await eventTypes(created.id)).filter((type) => type === 'APPROVED' || type === 'REJECTED');
    expect(decisions).toHaveLength(1);
  });

  it('needs every approver of an ALL step, including under concurrency, and completes the step once', async () => {
    const { typeId } = await publishType(
      simpleContent([
        { ...MANAGER_STEP, mode: 'ALL', approver: { type: 'ROLE', roleId: await roleId('DEPARTMENT_MANAGER') } },
      ]),
    );
    const created = await submit(requester, typeId, { reason: 'Everyone' });
    const assignees = must(created.steps[0], 'step').approvals.map((approval) => approval.approver.memberId);
    expect(assignees.length).toBeGreaterThanOrEqual(3);
    const actors = await Promise.all(
      (
        await s.prisma.employeeProfile.findMany({
          where: { organizationId: s.demoId, memberId: { in: assignees } },
          select: { employeeNumber: true },
        })
      ).map((row) => s.actionFor(row.employeeNumber)),
    );
    const [firstActor, ...rest] = actors;
    await approve(must(firstActor, 'approver'), await pendingFor(created.id, must(firstActor, 'approver')));
    expect((await view(requester, created.id)).status).toBe('PENDING_APPROVAL');
    const results = await Promise.allSettled(
      rest.map(async (actor) => approve(actor, await pendingFor(created.id, actor))),
    );
    expect(results.map((result) => result.status)).toEqual(rest.map(() => 'fulfilled'));
    expect((await view(requester, created.id)).status).toBe('APPROVED');
    expect((await eventTypes(created.id)).filter((type) => type === 'STEP_COMPLETED')).toHaveLength(1);
  });

  it('rejects an ALL step on the first rejection and supersedes the rest', async () => {
    const { typeId } = await publishType(
      simpleContent([{ ...MANAGER_STEP, mode: 'ALL', approver: { type: 'ROLE', roleId: await roleId('TEAM_LEAD') } }]),
    );
    const created = await submit(requester, typeId, { reason: 'Veto' });
    await s.as(otherLead, async () => approvals.reject(otherLead, await pendingFor(created.id, otherLead), 'Veto'));
    const rows = await s.prisma.requestApproval.findMany({
      where: { requestId: created.id },
      select: { status: true },
    });
    expect(rows.map((row) => row.status).sort()).toEqual(['REJECTED', 'SUPERSEDED']);
    expect((await view(requester, created.id)).status).toBe('REJECTED');
  });

  it('routes through conditional steps: skipped when the condition does not match', async () => {
    const workflow = content({
      form: { fields: [{ key: 'amount', type: 'money', label: { en: 'Amount' }, currency: 'EGP', required: true }] },
      steps: [
        MANAGER_STEP,
        {
          ...MANAGER_STEP,
          name: { en: 'Department' },
          approver: { type: 'DEPARTMENT_MANAGER' },
          condition: { match: 'all', rules: [{ field: 'amount', op: 'gte', value: 1000 }] },
        },
      ],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {},
      notifications: NOTIFY,
    });
    const { typeId } = await publishType(workflow);
    const small = await submit(requester, typeId, { amount: 50 });
    expect(small.steps.map((step) => step.state)).toEqual(['ACTIVE', 'SKIPPED']);
    expect((await approve(lead, await pendingFor(small.id, lead))).status).toBe('APPROVED');

    const large = await submit(requester, typeId, { amount: 5000 });
    expect(large.steps.map((step) => step.state)).toEqual(['ACTIVE', 'NOT_REACHED']);
    const afterFirst = await approve(lead, await pendingFor(large.id, lead));
    expect(afterFirst.status).toBe('PENDING_APPROVAL');
    expect(afterFirst.steps[1]?.approvals.map((approval) => approval.approver.memberId)).toEqual([
      deptManager.principal.memberId,
    ]);
    expect((await approve(deptManager, await pendingFor(large.id, deptManager))).status).toBe('APPROVED');
    // The route was fixed at submission: the stored form data cannot be changed afterwards.
    const tamper = await s.db.psql(
      'ops_app',
      `UPDATE request_instances SET form_data = '{"amount": 1}' WHERE id = '${large.id}';`,
    );
    expect(tamper.output).toMatch(/immutable/);
  });

  it('rejects stale versions on request changes', async () => {
    const { typeId } = await publishType(simpleContent());
    const draft = await s.as(requester, () =>
      requests.create(requester, { requestTypeId: typeId, formData: { reason: 'v1' } }),
    );
    await s.as(requester, () => requests.updateDraft(requester, draft.id, draft.version, { reason: 'v2' }));
    await expect(
      s.as(requester, () => requests.updateDraft(requester, draft.id, draft.version, { reason: 'stale' })),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      s.as(requester, () => requests.cancel(requester, draft.id, draft.version, undefined)),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('delegation', () => {
  const window = () => ({
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  it('lets an active delegate decide on behalf of the approver, audited, until revoked', async () => {
    const { typeId } = await publishType(simpleContent());
    const delegation = await s.as(lead, () =>
      delegations.create(lead, { delegateMemberId: colleague.principal.memberId, ...window(), reason: 'Holiday' }),
    );
    expect(delegation.status).toBe('ACTIVE');
    try {
      const created = await submit(requester, typeId, { reason: 'Delegated' });
      const inbox = await s.as(colleague, () => approvals.inbox(colleague, {}));
      const item = must(
        inbox.items.find((entry) => entry.request.id === created.id),
        'delegated item',
      );
      expect(item.onBehalfOf?.memberId).toBe(lead.principal.memberId);
      const decided = await approve(colleague, item.approvalId, 'On behalf');
      expect(decided.status).toBe('APPROVED');
      expect(decided.steps[0]?.approvals[0]).toMatchObject({
        delegated: true,
        decidedBy: { memberId: colleague.principal.memberId },
      });
      const audit = await s.prisma.auditLog.findFirstOrThrow({
        where: { organizationId: s.demoId, action: 'request.approval.approved', entityId: created.id },
        select: { actorMemberId: true, metadata: true },
      });
      expect(audit.actorMemberId).toBe(colleague.principal.memberId);
      expect(audit.metadata).toMatchObject({
        onBehalfOfMemberId: lead.principal.memberId,
        delegationId: delegation.id,
      });
    } finally {
      await s.as(lead, () => delegations.revoke(lead, delegation.id, delegation.version));
    }
    const after = await submit(requester, typeId, { reason: 'After revoke' });
    expect(
      (await s.as(colleague, () => approvals.inbox(colleague, {}))).items.some(
        (entry) => entry.request.id === after.id,
      ),
    ).toBe(false);
    await expect(approve(colleague, await pendingFor(after.id, lead))).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await s.prisma.auditLog.count({
        where: {
          entityId: delegation.id,
          action: { in: ['request.delegation.created', 'request.delegation.revoked'] },
        },
      }),
    ).toBe(2);
  });

  it('enforces delegation safety: no self, overlap, cycles, foreign members, impersonation or overlong periods', async () => {
    await expect(
      s.as(lead, () => delegations.create(lead, { delegateMemberId: lead.principal.memberId, ...window() })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(colleague, () =>
        delegations.create(colleague, {
          delegatorMemberId: lead.principal.memberId,
          delegateMemberId: colleague.principal.memberId,
          ...window(),
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.as(lead, () =>
        delegations.create(lead, {
          delegateMemberId: colleague.principal.memberId,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 91 * 86_400_000).toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
    const nw = await s.employee('NW-002', s.northwindId);
    await expect(
      s.as(lead, () => delegations.create(lead, { delegateMemberId: nw.memberId, ...window() })),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const first = await s.as(lead, () =>
      delegations.create(lead, { delegateMemberId: otherLead.principal.memberId, ...window() }),
    );
    try {
      await expect(
        s.as(lead, () => delegations.create(lead, { delegateMemberId: colleague.principal.memberId, ...window() })),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        s.as(otherLead, () =>
          delegations.create(otherLead, { delegateMemberId: lead.principal.memberId, ...window() }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        s.as(colleague, () => delegations.revoke(colleague, first.id, first.version)),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await s.as(admin, () => delegations.revoke(admin, first.id, first.version));
    }
  });

  it('is not transitive and never lets a delegate approve their own request', async () => {
    const { typeId } = await publishType(simpleContent());
    // lead -> requester: the requester must not see or decide approvals of their own requests.
    const toRequester = await s.as(lead, () =>
      delegations.create(lead, { delegateMemberId: requester.principal.memberId, ...window() }),
    );
    // requester -> colleague: the colleague does not inherit the lead's delegation.
    const chained = await s.as(requester, () =>
      delegations.create(requester, { delegateMemberId: colleague.principal.memberId, ...window() }),
    );
    try {
      const created = await submit(requester, typeId, { reason: 'Own request' });
      const approvalId = await pendingFor(created.id, lead);
      expect(
        (await s.as(requester, () => approvals.inbox(requester, {}))).items.some(
          (entry) => entry.request.id === created.id,
        ),
      ).toBe(false);
      await expect(approve(requester, approvalId)).rejects.toBeInstanceOf(ForbiddenError);
      expect(
        (await s.as(colleague, () => approvals.inbox(colleague, {}))).items.some(
          (entry) => entry.request.id === created.id,
        ),
      ).toBe(false);
      await expect(approve(colleague, approvalId)).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await s.as(admin, () => delegations.revoke(admin, toRequester.id, toRequester.version));
      await s.as(admin, () => delegations.revoke(admin, chained.id, chained.version));
    }
  });
});

describe('cancellation, fulfillment and reassignment', () => {
  it('lets the requester cancel a pending request; open approvals are superseded', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Never mind' });
    const approvalId = await pendingFor(created.id, lead);
    const cancelled = await s.as(requester, () => requests.cancel(requester, created.id, created.version, undefined));
    expect(cancelled.status).toBe('CANCELLED');
    expect((await s.prisma.requestApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('SUPERSEDED');
    await expect(approve(lead, approvalId)).rejects.toBeInstanceOf(RequestAlreadyDecidedError);
    await expect(
      s.as(colleague, () => requests.cancel(colleague, created.id, cancelled.version, 'x')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('fulfils approved requests by fulfillers only, never by the requester', async () => {
    const { typeId } = await publishType(
      simpleContent([MANAGER_STEP, { kind: 'FULFILLMENT', name: { en: 'Deliver' }, condition: null }]),
    );
    const created = await submit(requester, typeId, { reason: 'Laptop' });
    const approved = await approve(lead, await pendingFor(created.id, lead));
    expect(approved.status).toBe('APPROVED');
    expect(await notificationsFor(created.id, 'REQUEST_FULFILLMENT_REQUIRED')).not.toHaveLength(0);
    await expect(
      s.as(requester, () => requests.fulfil(requester, created.id, approved.version, 'START', undefined)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const started = await s.as(hr, () => requests.fulfil(hr, created.id, approved.version, 'START', 'Ordered'));
    expect(started.status).toBe('IN_FULFILLMENT');
    await expect(
      s.as(hr, () => requests.fulfil(hr, created.id, approved.version, 'COMPLETE_STEP', undefined)),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const done = await s.as(hr, () => requests.fulfil(hr, created.id, started.version, 'COMPLETE_STEP', 'Handed over'));
    expect(done.status).toBe('COMPLETED');
    expect(await notificationsFor(created.id, 'REQUEST_COMPLETED')).toHaveLength(1);
  });

  it('lets only request administrators reassign, never to the requester or a member already on the step', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Reassign' });
    const approvalId = await pendingFor(created.id, lead);
    const input = {
      version: created.version,
      memberId: otherLead.principal.memberId,
      replaceApprovalId: approvalId,
      reason: 'Lead is away',
    };
    await expect(s.as(deptManager, () => requests.reassign(deptManager, created.id, input))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      s.as(admin, () => requests.reassign(admin, created.id, { ...input, memberId: requester.principal.memberId })),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      s.as(admin, () =>
        requests.reassign(admin, created.id, {
          ...input,
          memberId: lead.principal.memberId,
          replaceApprovalId: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const reassigned = await s.as(admin, () => requests.reassign(admin, created.id, input));
    expect(
      reassigned.steps[0]?.approvals.map((approval) => [approval.approver.memberId, approval.status]).sort(),
    ).toEqual(
      [
        [lead.principal.memberId, 'SUPERSEDED'],
        [otherLead.principal.memberId, 'PENDING'],
      ].sort(),
    );
    await expect(approve(lead, approvalId)).rejects.toBeInstanceOf(RequestAlreadyDecidedError);
    expect((await approve(otherLead, await pendingFor(created.id, otherLead))).status).toBe('APPROVED');
  });
});

describe('effects (Phase 7 boundary)', () => {
  it('records one trusted attendance effect on approval and revokes it when an administrator cancels', async () => {
    const { typeId } = await publishType(
      content({
        form: { fields: [{ key: 'dates', type: 'date_range', label: { en: 'Dates' }, required: true, maxDays: 10 }] },
        steps: [MANAGER_STEP],
        attachments: { requirement: 'NONE', maxFiles: 0 },
        effects: { attendance: { mode: 'LEAVE', dateField: 'dates' } },
        notifications: NOTIFY,
      }),
    );
    const created = await submit(requester, typeId, { dates: { start: '2027-03-01', end: '2027-03-03' } });
    expect(created).toMatchObject({ startsOn: '2027-03-01', endsOn: '2027-03-03' });
    const approved = await approve(lead, await pendingFor(created.id, lead));
    const effects = await s.prisma.requestEffect.findMany({ where: { requestId: created.id } });
    expect(effects).toEqual([expect.objectContaining({ kind: 'ATTENDANCE', mode: 'LEAVE', status: 'RECORDED' })]);
    expect(
      await s.prisma.outboxEvent.count({ where: { aggregateId: created.id, eventType: 'request.approved' } }),
    ).toBe(1);
    // The decision is replay-safe: approving again records nothing new.
    await approve(
      lead,
      await s.prisma.requestApproval
        .findFirstOrThrow({ where: { requestId: created.id }, select: { id: true } })
        .then((row) => row.id),
    );
    expect(await s.prisma.requestEffect.count({ where: { requestId: created.id } })).toBe(1);

    await expect(
      s.as(requester, () => requests.cancel(requester, created.id, approved.version, undefined)),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const cancelled = await s.as(admin, () => requests.cancel(admin, created.id, approved.version, 'Plans changed'));
    expect(cancelled.status).toBe('CANCELLED');
    expect((await s.prisma.requestEffect.findFirstOrThrow({ where: { requestId: created.id } })).status).toBe(
      'REVOKED',
    );
    expect(
      await s.prisma.outboxEvent.count({ where: { aggregateId: created.id, eventType: 'request.effect.revoked' } }),
    ).toBe(1);
    const tamper = await s.db.psql(
      'ops_app',
      `UPDATE request_effects SET status = 'RECORDED' WHERE request_id = '${created.id}';`,
    );
    expect(tamper.output).toMatch(/immutable/);
  });
});

describe('attachments', () => {
  it('lets the requester attach files and hides them from everyone else (no IDOR)', async () => {
    const { typeId } = await publishType(
      simpleContent([MANAGER_STEP], { attachments: { requirement: 'OPTIONAL', maxFiles: 2 } }),
    );
    const draft = await s.as(requester, () =>
      requests.create(requester, { requestTypeId: typeId, formData: { reason: 'Receipt' } }),
    );
    const input = {
      ownerType: 'REQUEST' as const,
      ownerId: draft.id,
      filename: 'receipt.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    };
    const intent = await s.as(requester, () => attachments.createUploadIntent(requester, input));
    expect(intent.attachment.status).toBe('PENDING_UPLOAD');
    await expect(s.as(colleague, () => attachments.createUploadIntent(colleague, input))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(foreign, () => attachments.createUploadIntent(foreign, input))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(colleague, () => attachments.get(colleague, intent.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      s.as(colleague, () => attachments.listForOwner(colleague, 'REQUEST', draft.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(foreign, () => attachments.get(foreign, intent.attachment.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Drafts are private to the requester, even from their future approver.
    await expect(s.as(lead, () => attachments.createUploadIntent(lead, input))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses attachments where the workflow does not allow them', async () => {
    const { typeId } = await publishType(simpleContent());
    const draft = await s.as(requester, () =>
      requests.create(requester, { requestTypeId: typeId, formData: { reason: 'No files' } }),
    );
    await expect(
      s.as(requester, () =>
        attachments.createUploadIntent(requester, {
          ownerType: 'REQUEST',
          ownerId: draft.id,
          filename: 'a.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('tenant isolation', () => {
  it('returns 404 for every cross-organization access and forged id', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'Private' });
    await expect(view(foreign, created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.as(foreign, () => requests.history(foreign, created.id, {}))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(foreign, () => requests.cancel(foreign, created.id, created.version, 'x')),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(submit(foreign, typeId, { reason: 'Forged type' })).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await s.as(foreign, () => requests.list(foreign, { view: 'all' }))).items.some((item) => item.id === created.id),
    ).toBe(false);
    expect((await s.as(foreign, () => approvals.inbox(foreign, {}))).items).toEqual([]);
    await expect(view(requester, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects rows that reference another organization at the database level', async () => {
    const { typeId, versionId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'FK' });
    const nw = await s.employee('NW-002', s.northwindId);
    const step = await s.prisma.workflowStep.findFirstOrThrow({ where: { versionId }, select: { id: true } });
    const expectFkViolation = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toSatisfy(
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
      );
    };
    await expectFkViolation(
      s.prisma.requestApproval.create({
        data: {
          organizationId: s.demoId,
          requestId: created.id,
          stepId: step.id,
          stepOrder: 1,
          approverMemberId: nw.memberId,
        },
      }),
    );
    await expectFkViolation(
      s.prisma.requestEvent.create({
        data: { organizationId: s.northwindId, requestId: created.id, type: 'APPROVED' },
      }),
    );
    await expectFkViolation(
      s.prisma.approvalDelegation.create({
        data: {
          organizationId: s.demoId,
          delegatorMemberId: lead.principal.memberId,
          delegateMemberId: nw.memberId,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 86_400_000),
          createdByMemberId: lead.principal.memberId,
        },
      }),
    );
  });
});

describe('append-only history', () => {
  it('keeps events, requests and decided approvals tamper-proof for the runtime role', async () => {
    const { typeId } = await publishType(simpleContent());
    const created = await submit(requester, typeId, { reason: 'History' });
    const approvalId = await pendingFor(created.id, lead);
    await approve(lead, approvalId);
    const sql = async (statement: string) => (await s.db.psql('ops_app', statement)).output;
    expect(await sql(`UPDATE request_events SET type = 'REJECTED' WHERE request_id = '${created.id}';`)).toMatch(
      /permission denied|append-only/,
    );
    expect(await sql(`DELETE FROM request_events WHERE request_id = '${created.id}';`)).toMatch(
      /permission denied|append-only/,
    );
    expect(await sql(`DELETE FROM request_instances WHERE id = '${created.id}';`)).toMatch(
      /permission denied|never deleted/,
    );
    expect(await sql(`UPDATE request_approvals SET status = 'REJECTED' WHERE id = '${approvalId}';`)).toMatch(
      /immutable/,
    );
    expect(await sql(`UPDATE request_instances SET status = 'DRAFT' WHERE id = '${created.id}';`)).toMatch(/immutable/);
    const history = await s.as(requester, () => requests.history(requester, created.id, {}));
    expect(history.items.map((event) => event.type)).toEqual([
      'CREATED',
      'SUBMITTED',
      'STEP_ACTIVATED',
      'APPROVED',
      'STEP_COMPLETED',
    ]);
  });
});
