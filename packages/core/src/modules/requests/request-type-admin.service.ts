import { Prisma } from '@company-ops/db';
import { ERROR_CODES } from '@company-ops/shared';
import { ATTENDANCE_CORRECTION_TYPE_KEY } from '@company-ops/validation';
import type { Condition, FormSchema, LocalizedText, WorkflowContent } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import {
  ConflictError,
  InvalidFieldsError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import type { DomainFieldError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { workflowPublishIssues } from './engine/workflow.js';
import type { ApproverType } from './engine/workflow.js';
import { assertRequestAdmin } from './request-access.js';
import { mustLoadVersion, parseLongLabel } from './request-config.js';
import type { LoadedVersion } from './request-config.js';
import { requestTypeRefSelect, toTypeRef } from './request-views.js';
import type { PersonRef, RequestTypeIcon, RequestTypeRefView } from './request-views.js';

export interface AdminRequestTypeView extends RequestTypeRefView {
  readonly description: LocalizedText | null;
  readonly active: boolean;
  readonly requesterRoles: readonly { readonly id: string; readonly name: string }[];
  readonly publishedVersion: { readonly id: string; readonly number: number; readonly publishedAt: string } | null;
  readonly draftVersion: { readonly id: string; readonly number: number; readonly revision: number } | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowVersionSummaryView {
  readonly id: string;
  readonly number: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
}

export interface AdminWorkflowStepView {
  readonly order: number;
  readonly kind: 'APPROVAL' | 'FULFILLMENT';
  readonly name: LocalizedText;
  readonly mode: 'ANY_ONE' | 'ALL';
  readonly approver: {
    readonly type: ApproverType;
    readonly member: PersonRef | null;
    readonly role: { readonly id: string; readonly name: string } | null;
    readonly projectField: string | null;
  } | null;
  readonly condition: Condition | null;
  readonly slaHours: number | null;
}

export interface WorkflowVersionView extends WorkflowVersionSummaryView {
  readonly requestTypeId: string;
  readonly revision: number;
  readonly editable: boolean;
  readonly form: FormSchema;
  readonly steps: readonly AdminWorkflowStepView[];
  readonly attachments: WorkflowContent['attachments'];
  readonly effects: WorkflowContent['effects'];
  readonly notifications: WorkflowContent['notifications'];
  readonly publishedBy: PersonRef | null;
}

export interface CreateRequestTypeInput {
  readonly key: string;
  readonly name: LocalizedText;
  readonly description?: LocalizedText | null | undefined;
  readonly category: 'HR' | 'IT' | 'FINANCE' | 'ACCESS' | 'OPERATIONS' | 'OTHER';
  readonly icon: RequestTypeIcon;
  readonly requesterRoleIds?: readonly string[] | undefined;
}

export interface UpdateRequestTypeInput {
  readonly version: number;
  readonly name?: LocalizedText | undefined;
  readonly description?: LocalizedText | null | undefined;
  readonly category?: CreateRequestTypeInput['category'] | undefined;
  readonly icon?: RequestTypeIcon | undefined;
  readonly requesterRoleIds?: readonly string[] | undefined;
  readonly active?: boolean | undefined;
}

export interface Paging {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const adminTypeSelect = {
  ...requestTypeRefSelect,
  description: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  requesterRoles: { select: { role: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
  definition: {
    select: {
      id: true,
      versions: {
        where: { status: { in: ['DRAFT', 'PUBLISHED'] } },
        select: { id: true, number: true, status: true, publishedAt: true, revision: true },
      },
    },
  },
} satisfies Prisma.RequestTypeSelect;

type AdminTypeRow = Prisma.RequestTypeGetPayload<{ select: typeof adminTypeSelect }>;

const versionSummarySelect = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  publishedAt: true,
  retiredAt: true,
} satisfies Prisma.WorkflowVersionSelect;

const DEFAULT_STEP_NAME: LocalizedText = { en: 'Manager approval', ar: 'موافقة المدير' };

/** Issues that would violate a database constraint; a draft must be free of them even before publishing. */
const STRUCTURAL_ISSUE = /^(steps\.\d+\.(approver|mode|slaHours)|attachments\.)/;

function toAdminType(row: AdminTypeRow): AdminRequestTypeView {
  const published = row.definition?.versions.find((version) => version.status === 'PUBLISHED');
  const draft = row.definition?.versions.find((version) => version.status === 'DRAFT');
  return {
    ...toTypeRef(row),
    description: parseLongLabel(row.description),
    active: row.active,
    requesterRoles: row.requesterRoles.map((item) => item.role),
    publishedVersion:
      published?.publishedAt === undefined || published.publishedAt === null
        ? null
        : { id: published.id, number: published.number, publishedAt: published.publishedAt.toISOString() },
    draftVersion: draft === undefined ? null : { id: draft.id, number: draft.number, revision: draft.revision },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The stored version as builder input (the same shape the draft editor sends back). */
function toContent(version: LoadedVersion): WorkflowContent {
  return {
    form: version.form,
    steps: version.steps.map((step) => ({
      kind: step.kind,
      name: step.name,
      ...(step.kind === 'APPROVAL' ? { mode: step.mode } : {}),
      ...(step.approverType === null
        ? {}
        : {
            approver: {
              type: step.approverType,
              ...(step.approverMemberId === null ? {} : { memberId: step.approverMemberId }),
              ...(step.approverRoleId === null ? {} : { roleId: step.approverRoleId }),
              ...(step.projectField === null ? {} : { projectField: step.projectField }),
            },
          }),
      condition: step.condition,
      slaHours: step.slaHours,
    })),
    attachments: version.attachments,
    effects: version.effects,
    notifications: version.notifications,
  };
}

export function stepRows(
  organizationId: string,
  versionId: string,
  steps: WorkflowContent['steps'],
): Prisma.WorkflowStepCreateManyInput[] {
  return steps.map((step, index) => {
    const approval = step.kind === 'APPROVAL';
    const approver = approval ? step.approver : undefined;
    return {
      organizationId,
      versionId,
      stepOrder: index + 1,
      kind: step.kind,
      name: step.name,
      mode: approval ? (step.mode ?? 'ANY_ONE') : 'ANY_ONE',
      approverType: approver?.type ?? null,
      approverMemberId: approver?.memberId ?? null,
      approverRoleId: approver?.roleId ?? null,
      projectField: approver?.projectField ?? null,
      condition: step.condition ?? Prisma.DbNull,
      slaHours: approval ? (step.slaHours ?? null) : null,
    };
  });
}

export interface VersionColumns {
  readonly formSchema: Prisma.InputJsonObject;
  readonly attachmentRequirement: WorkflowContent['attachments']['requirement'];
  readonly maxAttachments: number;
  readonly effects: Prisma.InputJsonObject;
  readonly emailApprovers: boolean;
  readonly emailRequester: boolean;
}

function toInputJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item: unknown) => toInputJson(item) ?? null);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toInputJson(item);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return undefined;
}

/** Validated configuration as a JSON column value (`undefined` members dropped). */
function toJsonColumn(value: FormSchema | WorkflowContent['effects']): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = toInputJson(item);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

export function versionColumns(content: WorkflowContent): VersionColumns {
  return {
    formSchema: toJsonColumn(content.form),
    attachmentRequirement: content.attachments.requirement,
    maxAttachments: content.attachments.maxFiles,
    effects: toJsonColumn(content.effects),
    emailApprovers: content.notifications.emailApprovers,
    emailRequester: content.notifications.emailRequester,
  };
}

/**
 * Request type and workflow administration (ADR-0021, ORG-wide `request.admin`). A definition has at
 * most one DRAFT and one PUBLISHED version; published versions are immutable (application and trigger),
 * editing starts a new draft copied from the published one, and publishing retires the previous version
 * while requests stay pinned to the version they were submitted on.
 */
export class RequestTypeAdminService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext): Promise<AdminRequestTypeView[]> {
    const organizationId = this.admin(action);
    const rows = await this.db.requestType.findMany({
      where: { organizationId },
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
      take: 200,
      select: adminTypeSelect,
    });
    return rows.map(toAdminType);
  }

  async get(action: ActionContext, typeId: string): Promise<AdminRequestTypeView> {
    const organizationId = this.admin(action);
    return toAdminType(await this.loadType(this.db, organizationId, typeId));
  }

  async create(action: ActionContext, input: CreateRequestTypeInput): Promise<AdminRequestTypeView> {
    const organizationId = this.admin(action);
    const memberId = action.principal.memberId;
    return await this.db.$transaction(async (tx) => {
      const existing = await tx.requestType.findFirst({
        where: { organizationId, key: input.key },
        select: { id: true },
      });
      if (existing !== null) {
        throw new ConflictError('A request type with this key already exists.');
      }
      if (input.key === ATTENDANCE_CORRECTION_TYPE_KEY) {
        throw new ConflictError('This key is reserved for attendance corrections.');
      }
      const roleIds = await this.checkRoles(tx, organizationId, input.requesterRoleIds ?? []);
      const type = await tx.requestType.create({
        data: {
          organizationId,
          key: input.key,
          name: input.name,
          description: input.description ?? Prisma.DbNull,
          category: input.category,
          icon: input.icon,
          createdByMemberId: memberId,
        },
        select: { id: true },
      });
      if (roleIds.length > 0) {
        await tx.requestTypeRole.createMany({
          data: roleIds.map((roleId) => ({ organizationId, requestTypeId: type.id, roleId })),
        });
      }
      const definition = await tx.workflowDefinition.create({
        data: { organizationId, requestTypeId: type.id },
        select: { id: true },
      });
      const version = await tx.workflowVersion.create({
        data: {
          organizationId,
          definitionId: definition.id,
          number: 1,
          formSchema: { fields: [] },
          createdByMemberId: memberId,
        },
        select: { id: true },
      });
      await tx.workflowStep.create({
        data: {
          organizationId,
          versionId: version.id,
          stepOrder: 1,
          kind: 'APPROVAL',
          name: DEFAULT_STEP_NAME,
          mode: 'ANY_ONE',
          approverType: 'DIRECT_MANAGER',
        },
      });
      await recordAudit(tx, organizationId, {
        action: 'request_type.created',
        entityType: 'request_type',
        entityId: type.id,
        actor: userActor(action),
        metadata: { key: input.key, category: input.category, requesterRoleIds: roleIds },
        context: action.request,
      });
      return toAdminType(await this.loadType(tx, organizationId, type.id));
    });
  }

  async update(action: ActionContext, typeId: string, input: UpdateRequestTypeInput): Promise<AdminRequestTypeView> {
    const organizationId = this.admin(action);
    return await this.db.$transaction(async (tx) => {
      const current = await this.loadType(tx, organizationId, typeId);
      if (
        input.active === true &&
        !current.active &&
        !current.definition?.versions.some((version) => version.status === 'PUBLISHED')
      ) {
        throw new InvalidTransitionError('Publish a workflow version before activating the request type.');
      }
      const updated = await tx.requestType.updateMany({
        where: { organizationId, id: typeId, version: input.version },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description ?? Prisma.DbNull }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.icon === undefined ? {} : { icon: input.icon }),
          ...(input.active === undefined ? {} : { active: input.active }),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Request type');
      }
      let roleIds: string[] | null = null;
      if (input.requesterRoleIds !== undefined) {
        roleIds = await this.checkRoles(tx, organizationId, input.requesterRoleIds);
        await tx.requestTypeRole.deleteMany({ where: { organizationId, requestTypeId: typeId } });
        if (roleIds.length > 0) {
          await tx.requestTypeRole.createMany({
            data: roleIds.map((roleId) => ({ organizationId, requestTypeId: typeId, roleId })),
          });
        }
      }
      const activation = input.active !== undefined && input.active !== current.active;
      await recordAudit(tx, organizationId, {
        action: activation
          ? input.active
            ? 'request_type.activated'
            : 'request_type.deactivated'
          : 'request_type.updated',
        entityType: 'request_type',
        entityId: typeId,
        actor: userActor(action),
        metadata: {
          key: current.key,
          changed: Object.keys(input).filter((key) => key !== 'version'),
          ...(roleIds === null ? {} : { requesterRoleIds: roleIds }),
        },
        context: action.request,
      });
      return toAdminType(await this.loadType(tx, organizationId, typeId));
    });
  }

  async listVersions(action: ActionContext, typeId: string, paging: Paging): Promise<Page<WorkflowVersionSummaryView>> {
    const organizationId = this.admin(action);
    const definitionId = await this.definitionId(this.db, organizationId, typeId);
    const size = pageSize(paging.limit);
    const and: Prisma.WorkflowVersionWhereInput[] = [];
    if (paging.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(paging.cursor, 2);
      const number = Number(value);
      if (!Number.isInteger(number)) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ number: { lt: number } }, { number, id: { lt: id } }] });
    }
    const rows = await this.db.workflowVersion.findMany({
      where: { organizationId, definitionId, AND: and },
      orderBy: [{ number: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: versionSummarySelect,
    });
    const page = toPage(rows, size, (row) => [String(row.number), row.id]);
    return {
      items: page.items.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        publishedAt: row.publishedAt?.toISOString() ?? null,
        retiredAt: row.retiredAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getVersion(action: ActionContext, typeId: string, versionId: string): Promise<WorkflowVersionView> {
    const organizationId = this.admin(action);
    return await this.versionView(this.db, organizationId, typeId, versionId);
  }

  /** Starts editing: a new DRAFT copied from the published version (or the latest one). One draft at a time. */
  async createDraft(action: ActionContext, typeId: string): Promise<WorkflowVersionView> {
    const organizationId = this.admin(action);
    return await this.db.$transaction(async (tx) => {
      const definitionId = await this.lockDefinition(tx, organizationId, typeId);
      const versions = await tx.workflowVersion.findMany({
        where: { organizationId, definitionId },
        orderBy: { number: 'desc' },
        select: { id: true, number: true, status: true },
        take: 1000,
      });
      if (versions.some((version) => version.status === 'DRAFT')) {
        throw new ConflictError('A draft version already exists.');
      }
      const source = versions.find((version) => version.status === 'PUBLISHED') ?? versions[0];
      if (source === undefined) {
        throw new Error('A workflow definition always has a version.');
      }
      const content = toContent(await mustLoadVersion(tx, organizationId, source.id));
      const created = await tx.workflowVersion.create({
        data: {
          organizationId,
          definitionId,
          number: (versions[0]?.number ?? 0) + 1,
          ...versionColumns(content),
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true, number: true },
      });
      await tx.workflowStep.createMany({ data: stepRows(organizationId, created.id, content.steps) });
      await recordAudit(tx, organizationId, {
        action: 'workflow.draft_created',
        entityType: 'workflow_version',
        entityId: created.id,
        actor: userActor(action),
        metadata: { requestTypeId: typeId, number: created.number, fromVersion: source.number },
        context: action.request,
      });
      return await this.versionView(tx, organizationId, typeId, created.id);
    });
  }

  async updateDraft(
    action: ActionContext,
    typeId: string,
    versionId: string,
    content: WorkflowContent,
    revision: number,
  ): Promise<WorkflowVersionView> {
    const organizationId = this.admin(action);
    return await this.db.$transaction(async (tx) => {
      const { key } = await this.loadType(tx, organizationId, typeId);
      const structural = workflowPublishIssues(content, key).filter(
        (issue) => STRUCTURAL_ISSUE.test(issue.path) || issue.code === 'reserved' || issue.code === 'reserved_contract',
      );
      if (structural.length > 0) {
        throw new InvalidFieldsError('The workflow has invalid steps.', structural, ERROR_CODES.WORKFLOW_INVALID);
      }
      await this.draftOf(tx, organizationId, typeId, versionId);
      await this.checkReferences(tx, organizationId, content, false);
      const updated = await tx.workflowVersion.updateMany({
        where: { organizationId, id: versionId, status: 'DRAFT', revision },
        data: { ...versionColumns(content), revision: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Workflow version');
      }
      await tx.workflowStep.deleteMany({ where: { organizationId, versionId } });
      await tx.workflowStep.createMany({ data: stepRows(organizationId, versionId, content.steps) });
      return await this.versionView(tx, organizationId, typeId, versionId);
    });
  }

  async discardDraft(action: ActionContext, typeId: string, versionId: string, revision: number): Promise<void> {
    const organizationId = this.admin(action);
    await this.db.$transaction(async (tx) => {
      const definitionId = await this.lockDefinition(tx, organizationId, typeId);
      const draft = await this.draftOf(tx, organizationId, typeId, versionId);
      const others = await tx.workflowVersion.count({
        where: { organizationId, definitionId, id: { not: versionId } },
      });
      if (others === 0) {
        throw new InvalidTransitionError('The only version of a workflow cannot be discarded.');
      }
      const deleted = await tx.workflowVersion.deleteMany({
        where: { organizationId, id: versionId, status: 'DRAFT', revision },
      });
      if (deleted.count === 0) {
        throw new VersionConflictError('Workflow version');
      }
      await recordAudit(tx, organizationId, {
        action: 'workflow.draft_discarded',
        entityType: 'workflow_version',
        entityId: versionId,
        actor: userActor(action),
        metadata: { requestTypeId: typeId, number: draft.number },
        context: action.request,
      });
    });
  }

  /**
   * Publishes a draft after the full structural check plus database references (active member approvers,
   * roles that can approve). The previous published version is retired in the same transaction.
   */
  async publish(
    action: ActionContext,
    typeId: string,
    versionId: string,
    revision: number,
  ): Promise<WorkflowVersionView> {
    const organizationId = this.admin(action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const definitionId = await this.lockDefinition(tx, organizationId, typeId);
      const draft = await this.draftOf(tx, organizationId, typeId, versionId);
      if (draft.revision !== revision) {
        throw new VersionConflictError('Workflow version');
      }
      const content = toContent(await mustLoadVersion(tx, organizationId, versionId));
      const { key } = await this.loadType(tx, organizationId, typeId);
      const issues: DomainFieldError[] = workflowPublishIssues(content, key).map((issue) => ({
        path: issue.path,
        code: issue.code,
      }));
      issues.push(...(await this.checkReferences(tx, organizationId, content, true)));
      if (issues.length > 0) {
        throw new InvalidFieldsError('The workflow cannot be published.', issues, ERROR_CODES.WORKFLOW_INVALID);
      }
      const previous = await tx.workflowVersion.findFirst({
        where: { organizationId, definitionId, status: 'PUBLISHED' },
        select: { id: true, number: true },
      });
      if (previous !== null) {
        await tx.workflowVersion.updateMany({
          where: { organizationId, id: previous.id, status: 'PUBLISHED' },
          data: { status: 'RETIRED', retiredAt: now },
        });
      }
      const published = await tx.workflowVersion.updateMany({
        where: { organizationId, id: versionId, status: 'DRAFT', revision },
        data: { status: 'PUBLISHED', publishedAt: now, publishedByMemberId: action.principal.memberId },
      });
      if (published.count === 0) {
        throw new VersionConflictError('Workflow version');
      }
      await recordAudit(tx, organizationId, {
        action: 'workflow.published',
        entityType: 'workflow_version',
        entityId: versionId,
        actor: userActor(action),
        metadata: { requestTypeId: typeId, number: draft.number, retiredVersion: previous?.number ?? null },
        context: action.request,
      });
      return await this.versionView(tx, organizationId, typeId, versionId);
    });
  }

  // ---- internals ----

  private admin(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertRequestAdmin(action.principal);
    return organizationId;
  }

  private async loadType(db: TenantDb, organizationId: string, typeId: string): Promise<AdminTypeRow> {
    const row = await db.requestType.findFirst({ where: { organizationId, id: typeId }, select: adminTypeSelect });
    if (row === null) {
      throw new NotFoundError('Request type');
    }
    return row;
  }

  private async definitionId(db: TenantDb, organizationId: string, typeId: string): Promise<string> {
    const definition = await db.workflowDefinition.findFirst({
      where: { organizationId, requestTypeId: typeId },
      select: { id: true },
    });
    if (definition === null) {
      throw new NotFoundError('Request type');
    }
    return definition.id;
  }

  /** Serializes version changes of one definition (draft creation, discard, publish). */
  private async lockDefinition(db: TenantDb, organizationId: string, typeId: string): Promise<string> {
    const definitionId = await this.definitionId(db, organizationId, typeId);
    await db.workflowDefinition.updateMany({
      where: { organizationId, id: definitionId },
      data: { version: { increment: 1 } },
    });
    return definitionId;
  }

  private async draftOf(
    db: TenantDb,
    organizationId: string,
    typeId: string,
    versionId: string,
  ): Promise<{ id: string; number: number; revision: number }> {
    const version = await db.workflowVersion.findFirst({
      where: { organizationId, id: versionId, definition: { is: { requestTypeId: typeId } } },
      select: { id: true, number: true, revision: true, status: true },
    });
    if (version === null) {
      throw new NotFoundError('Workflow version');
    }
    if (version.status !== 'DRAFT') {
      throw new InvalidTransitionError('Published versions are immutable; create a new draft to make changes.');
    }
    return version;
  }

  private async checkRoles(db: TenantDb, organizationId: string, roleIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(roleIds)];
    if (unique.length === 0) return [];
    const found = await db.role.findMany({ where: { organizationId, id: { in: unique } }, select: { id: true } });
    if (found.length !== unique.length) {
      throw new InvalidInputError('requesterRoleIds', 'Unknown role.');
    }
    return unique;
  }

  /**
   * Member and role approvers must exist in the organization. When publishing, member approvers must also
   * be active and roles must grant `request.approve`; a role cannot be used to route approvals to people
   * who could not approve otherwise.
   */
  private async checkReferences(
    db: TenantDb,
    organizationId: string,
    content: WorkflowContent,
    publishing: boolean,
  ): Promise<DomainFieldError[]> {
    const memberIds = [
      ...new Set(
        content.steps.flatMap((step) => (step.approver?.memberId === undefined ? [] : [step.approver.memberId])),
      ),
    ];
    const roleIds = [
      ...new Set(content.steps.flatMap((step) => (step.approver?.roleId === undefined ? [] : [step.approver.roleId]))),
    ];
    const members =
      memberIds.length === 0
        ? []
        : await db.organizationMember.findMany({
            where: { organizationId, id: { in: memberIds } },
            select: { id: true, status: true },
          });
    const roles =
      roleIds.length === 0
        ? []
        : await db.role.findMany({
            where: { organizationId, id: { in: roleIds } },
            select: {
              id: true,
              permissions: { where: { permissionKey: 'request.approve' }, select: { permissionKey: true } },
            },
          });
    const issues: DomainFieldError[] = [];
    content.steps.forEach((step, index) => {
      const memberId = step.approver?.memberId;
      if (memberId !== undefined) {
        const member = members.find((item) => item.id === memberId);
        if (member === undefined) issues.push({ path: `steps.${String(index)}.approver.memberId`, code: 'unknown' });
        else if (publishing && member.status !== 'ACTIVE')
          issues.push({ path: `steps.${String(index)}.approver.memberId`, code: 'inactive' });
      }
      const roleId = step.approver?.roleId;
      if (roleId !== undefined) {
        const role = roles.find((item) => item.id === roleId);
        if (role === undefined) issues.push({ path: `steps.${String(index)}.approver.roleId`, code: 'unknown' });
        else if (publishing && role.permissions.length === 0)
          issues.push({ path: `steps.${String(index)}.approver.roleId`, code: 'cannot_approve' });
      }
    });
    if (!publishing && issues.length > 0) {
      throw new InvalidFieldsError('The workflow references unknown approvers.', issues, ERROR_CODES.WORKFLOW_INVALID);
    }
    return issues;
  }

  private async versionView(
    db: TenantDb,
    organizationId: string,
    typeId: string,
    versionId: string,
  ): Promise<WorkflowVersionView> {
    const row = await db.workflowVersion.findFirst({
      where: { organizationId, id: versionId, definition: { is: { requestTypeId: typeId } } },
      select: {
        ...versionSummarySelect,
        revision: true,
        publishedBy: { select: memberRefSelect },
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: {
            stepOrder: true,
            approverMember: { select: memberRefSelect },
            approverRole: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (row === null) {
      throw new NotFoundError('Workflow version');
    }
    const version = await mustLoadVersion(db, organizationId, versionId);
    const refs = new Map(row.steps.map((step) => [step.stepOrder, step]));
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      retiredAt: row.retiredAt?.toISOString() ?? null,
      requestTypeId: typeId,
      revision: row.revision,
      editable: row.status === 'DRAFT',
      form: version.form,
      steps: version.steps.map((step) => {
        const ref = refs.get(step.order);
        return {
          order: step.order,
          kind: step.kind,
          name: step.name,
          mode: step.mode,
          approver:
            step.approverType === null
              ? null
              : {
                  type: step.approverType,
                  member:
                    ref?.approverMember === null || ref?.approverMember === undefined
                      ? null
                      : toPersonRef(ref.approverMember),
                  role: ref?.approverRole ?? null,
                  projectField: step.projectField,
                },
          condition: step.condition,
          slaHours: step.slaHours,
        };
      }),
      attachments: version.attachments,
      effects: version.effects,
      notifications: version.notifications,
      publishedBy: row.publishedBy === null ? null : toPersonRef(row.publishedBy),
    };
  }
}
