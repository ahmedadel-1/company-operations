import type { CorporateDocumentType, DocumentClassification, Prisma } from '@company-ops/db';
import type {
  AddCorporateVersionRequest,
  CorporateDocumentListQuery,
  CreateCorporateDocumentRequest,
  UpdateCorporateDocumentRequest,
} from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { OwnerAccess } from '../attachments/attachment.service.js';
import type { Principal, ResourceFacts } from '../authorization/policy.js';
import { addDays, daysBetween } from '../projects/business-date.js';
import {
  canManageCorporate,
  canViewCorporate,
  corporateAccessSelect,
  corporateFacts,
  corporateScopeWhere,
  fullTenderWhere,
} from './commercial-access.js';
import {
  announceCommercialChange,
  assertActiveMembers,
  dateOnly,
  iso,
  memberRefSelect,
  organizationToday,
  personOrNull,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { DOCUMENT_EXPIRING_DAYS, documentValidity } from './engine/dates.js';
import type { DocumentValidity } from './engine/dates.js';
import { tenderRefSelect, toTenderRef } from './tender-views.js';

export interface CorporateDocumentSummaryView {
  readonly id: string;
  readonly documentType: CorporateDocumentType;
  readonly title: string;
  readonly documentNumber: string | null;
  readonly owner: PersonRef | null;
  readonly classification: DocumentClassification;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly currentVersion: number;
  readonly currentExpiryDate: string | null;
  readonly validity: DocumentValidity;
  readonly daysToExpiry: number | null;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CorporateDocumentView extends CorporateDocumentSummaryView {
  readonly notes: string | null;
  readonly versions: {
    readonly id: string;
    readonly versionNumber: number;
    readonly attachmentId: string;
    readonly filename: string;
    readonly issueDate: string | null;
    readonly validFrom: string | null;
    readonly expiryDate: string | null;
    readonly notes: string | null;
    readonly uploadedBy: PersonRef | null;
    readonly uploadedAt: string;
    readonly supersededByVersionId: string | null;
    readonly isCurrent: boolean;
  }[];
  readonly linkedRequirements: {
    readonly linkId: string;
    readonly versionNumber: number;
    readonly requirement: { readonly id: string; readonly title: string };
    readonly tender: ReturnType<typeof toTenderRef>;
  }[];
  readonly createdBy: PersonRef | null;
  readonly createdAt: string;
  readonly canManage: boolean;
}

const summarySelect = {
  ...corporateAccessSelect,
  documentType: true,
  title: true,
  documentNumber: true,
  currentVersion: true,
  currentExpiryDate: true,
  updatedAt: true,
  version: true,
  owner: {
    select: { ...memberRefSelect, profile: { select: { fullName: true, employmentStatus: true, departmentId: true } } },
  },
} satisfies Prisma.CorporateDocumentSelect;
type SummaryRow = Prisma.CorporateDocumentGetPayload<{ select: typeof summarySelect }>;

/**
 * Corporate Document Vault (spec §26-§29): reusable company documents (registrations, certificates,
 * bank letters...) with append-only versions, each with its own validity. The document mirrors the
 * latest version's expiry (`current_expiry_date`) in the same transaction for expiry queries and
 * reminders. `corporate_document.view` reads GENERAL documents; other classifications also need
 * `corporate_document.restricted.view`; `corporate_document.manage` changes them.
 */
/**
 * Row filter of the document vault list (scope and classification plus every list filter except
 * paging), shared with the dashboard. Null when no document can be visible.
 */
export function corporateDocumentListWhere(
  principal: Principal,
  query: Omit<CorporateDocumentListQuery, 'cursor' | 'limit'>,
  today: string,
): Prisma.CorporateDocumentWhereInput[] | null {
  const scope = corporateScopeWhere(principal);
  if (scope === null) return null;
  const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
  const and: Prisma.CorporateDocumentWhereInput[] = [scope];
  and.push({ status: { in: query.status === undefined ? ['ACTIVE'] : [...query.status] } });
  if (query.type !== undefined) and.push({ documentType: { in: [...query.type] } });
  if (query.ownerMemberId !== undefined) and.push({ ownerMemberId: query.ownerMemberId });
  if (query.q !== undefined) {
    and.push({
      OR: [
        { title: { contains: escapeLike(query.q), mode: 'insensitive' } },
        { documentNumber: { contains: escapeLike(query.q), mode: 'insensitive' } },
      ],
    });
  }
  if (query.expiringWithinDays !== undefined) {
    and.push({ currentExpiryDate: { gte: day(today), lte: day(addDays(today, query.expiringWithinDays)) } });
  }
  if (query.validity !== undefined) {
    const expiringEnd = day(addDays(today, DOCUMENT_EXPIRING_DAYS));
    const byValidity: Record<DocumentValidity, Prisma.CorporateDocumentWhereInput> = {
      NO_VERSION: { currentVersion: 0 },
      NO_EXPIRY: { currentVersion: { gt: 0 }, currentExpiryDate: null },
      EXPIRED: { currentVersion: { gt: 0 }, currentExpiryDate: { lt: day(today) } },
      EXPIRING: { currentVersion: { gt: 0 }, currentExpiryDate: { gte: day(today), lte: expiringEnd } },
      VALID: { currentVersion: { gt: 0 }, currentExpiryDate: { gt: expiringEnd } },
    };
    and.push({ OR: query.validity.map((validity) => byValidity[validity]) });
  }
  return and;
}

export class CorporateDocumentService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, query: CorporateDocumentListQuery): Promise<Page<CorporateDocumentSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const filter = corporateDocumentListWhere(action.principal, query, today);
    if (filter === null) return { items: [], nextCursor: null };
    const size = pageSize(query.limit);
    const and: Prisma.CorporateDocumentWhereInput[] = [...filter];
    if (query.cursor !== undefined) {
      const [updatedAt = '', id = ''] = decodeCursor(query.cursor, 2);
      const at = new Date(updatedAt);
      and.push({ OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.corporateDocument.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: summarySelect,
    });
    const page = toPage(rows, size, (row) => [row.updatedAt.toISOString(), row.id]);
    return { items: page.items.map((row) => toSummary(row, today)), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, documentId: string): Promise<CorporateDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.corporateDocument.findFirst({
      where: { organizationId, id: documentId },
      select: {
        ...summarySelect,
        notes: true,
        createdAt: true,
        createdBy: { select: memberRefSelect },
        versions: {
          orderBy: { versionNumber: 'asc' },
          select: {
            id: true,
            versionNumber: true,
            attachmentId: true,
            issueDate: true,
            validFrom: true,
            expiryDate: true,
            notes: true,
            uploadedAt: true,
            uploadedBy: { select: memberRefSelect },
            attachment: { select: { originalFilename: true } },
          },
        },
      },
    });
    if (row === null) throw new NotFoundError('Document');
    const facts = corporateFacts(organizationId, row);
    if (!canViewCorporate(action.principal, facts, row.classification)) throw new NotFoundError('Document');
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const me = action.principal.memberId;
    const fullTenders = fullTenderWhere(action.principal);
    const readable: Prisma.TenderRequirementWhereInput[] = [{ ownerMemberId: me }, { reviewerMemberId: me }];
    if (fullTenders !== null) readable.push({ tender: { is: fullTenders } });
    const orgWide = fullTenders !== null && Object.keys(fullTenders).length === 0;
    const links = await this.db.tenderRequirementLink.findMany({
      where: {
        organizationId,
        removedAt: null,
        corporateDocumentVersion: { is: { organizationId, documentId } },
        ...(orgWide ? {} : { requirement: { is: { OR: readable } } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        corporateDocumentVersion: { select: { versionNumber: true } },
        requirement: { select: { id: true, title: true, tender: { select: tenderRefSelect } } },
      },
    });
    return {
      ...toSummary(row, today),
      notes: row.notes,
      versions: row.versions.map((version, index) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        attachmentId: version.attachmentId,
        filename: version.attachment.originalFilename,
        issueDate: dateOnly(version.issueDate),
        validFrom: dateOnly(version.validFrom),
        expiryDate: dateOnly(version.expiryDate),
        notes: version.notes,
        uploadedBy: personOrNull(version.uploadedBy),
        uploadedAt: iso(version.uploadedAt),
        supersededByVersionId: row.versions[index + 1]?.id ?? null,
        isCurrent: version.versionNumber === row.currentVersion,
      })),
      linkedRequirements: links.map((link) => ({
        linkId: link.id,
        versionNumber: link.corporateDocumentVersion?.versionNumber ?? 0,
        requirement: { id: link.requirement.id, title: link.requirement.title },
        tender: toTenderRef(link.requirement.tender),
      })),
      createdBy: personOrNull(row.createdBy),
      createdAt: iso(row.createdAt),
      canManage: row.status === 'ACTIVE' && canManageCorporate(action.principal, facts, row.classification),
    };
  }

  async create(action: ActionContext, input: CreateCorporateDocumentRequest): Promise<CorporateDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const classification = input.classification ?? 'GENERAL';
    const id = await this.db.$transaction(async (tx) => {
      await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
      const facts = await proposedFacts(tx, organizationId, input.ownerMemberId ?? null);
      if (!canManageCorporate(action.principal, facts, classification)) throw new ForbiddenError();
      const created = await tx.corporateDocument.create({
        data: {
          organizationId,
          documentType: input.documentType,
          title: input.title,
          documentNumber: input.documentNumber ?? null,
          ownerMemberId: input.ownerMemberId ?? null,
          classification,
          notes: input.notes ?? null,
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      await recordAudit(tx, organizationId, {
        action: 'corporate_document.created',
        entityType: 'corporate_document',
        entityId: created.id,
        actor: userActor(action),
        metadata: { documentType: input.documentType, classification },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'corporate_document', created.id);
      return created.id;
    });
    return this.get(action, id);
  }

  async update(
    action: ActionContext,
    documentId: string,
    input: UpdateCorporateDocumentRequest,
  ): Promise<CorporateDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const current = await tx.corporateDocument.findFirst({
        where: { organizationId, id: documentId },
        select: { ...corporateAccessSelect, archivedAt: true },
      });
      if (current === null) throw new NotFoundError('Document');
      const facts = corporateFacts(organizationId, current);
      if (!canViewCorporate(action.principal, facts, current.classification)) throw new NotFoundError('Document');
      if (!canManageCorporate(action.principal, facts, current.classification)) throw new ForbiddenError();
      const restoring = input.status === 'ACTIVE' && current.status === 'ARCHIVED';
      if (current.status === 'ARCHIVED' && !restoring) {
        throw new InvalidTransitionError('Restore the document before changing it.');
      }
      await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
      const nextOwner = input.ownerMemberId !== undefined ? input.ownerMemberId : current.ownerMemberId;
      const nextClassification = input.classification ?? current.classification;
      if (nextOwner !== current.ownerMemberId || nextClassification !== current.classification) {
        const nextFacts = await proposedFacts(tx, organizationId, nextOwner);
        if (!canManageCorporate(action.principal, nextFacts, nextClassification)) {
          throw new ForbiddenError('The change would move the document outside what you may manage.');
        }
      }
      const data: Prisma.CorporateDocumentUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.documentType !== undefined) data.documentType = input.documentType;
      if (input.title !== undefined) data.title = input.title;
      if (input.documentNumber !== undefined) data.documentNumber = input.documentNumber;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.classification !== undefined) data.classification = input.classification;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.status !== undefined && input.status !== current.status) {
        data.status = input.status;
        data.archivedAt = input.status === 'ARCHIVED' ? this.clock() : null;
      }
      const result = await tx.corporateDocument.updateMany({
        where: { organizationId, id: documentId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Document');
      await recordAudit(tx, organizationId, {
        action:
          input.status === 'ARCHIVED'
            ? 'corporate_document.archived'
            : restoring
              ? 'corporate_document.restored'
              : 'corporate_document.updated',
        entityType: 'corporate_document',
        entityId: documentId,
        actor: userActor(action),
        metadata: {
          fields: Object.keys(input).filter((key) => key !== 'version'),
          ...(input.classification !== undefined && input.classification !== current.classification
            ? { classificationFrom: current.classification, classificationTo: input.classification }
            : {}),
        },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'corporate_document', documentId);
    });
    return this.get(action, documentId);
  }

  /** Appends a version (with its own validity) from an AVAILABLE upload to this document. */
  async addVersion(
    action: ActionContext,
    documentId: string,
    input: AddCorporateVersionRequest,
  ): Promise<CorporateDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const current = await tx.corporateDocument.findFirst({
        where: { organizationId, id: documentId },
        select: { ...corporateAccessSelect, currentVersion: true },
      });
      if (current === null) throw new NotFoundError('Document');
      const facts = corporateFacts(organizationId, current);
      if (!canViewCorporate(action.principal, facts, current.classification)) throw new NotFoundError('Document');
      if (!canManageCorporate(action.principal, facts, current.classification)) throw new ForbiddenError();
      if (current.status !== 'ACTIVE')
        throw new InvalidTransitionError('Restore the document before adding a version.');
      const attachment = await tx.attachment.findFirst({
        where: { organizationId, id: input.attachmentId, ownerType: 'CORPORATE_DOCUMENT', ownerId: documentId },
        select: { status: true },
      });
      if (attachment === null) throw new InvalidInputError('attachmentId', 'Upload the file to this document first.');
      if (attachment.status !== 'AVAILABLE') throw new InvalidInputError('attachmentId', 'The upload is not complete.');
      const versionNumber = current.currentVersion + 1;
      const expiryDate = toDate(input.expiryDate);
      const bumped = await tx.corporateDocument.updateMany({
        where: { organizationId, id: documentId, currentVersion: current.currentVersion },
        data: { currentVersion: versionNumber, currentExpiryDate: expiryDate, version: { increment: 1 } },
      });
      if (bumped.count === 0) throw new ConflictError('Another version was added at the same time; reload and retry.');
      try {
        await tx.corporateDocumentVersion.create({
          data: {
            organizationId,
            documentId,
            versionNumber,
            attachmentId: input.attachmentId,
            issueDate: toDate(input.issueDate),
            validFrom: toDate(input.validFrom),
            expiryDate,
            notes: input.notes ?? null,
            uploadedByMemberId: action.principal.memberId,
            uploadedAt: this.clock(),
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('This file is already a version of a document.');
        throw error;
      }
      await recordAudit(tx, organizationId, {
        action: 'corporate_document.version_added',
        entityType: 'corporate_document',
        entityId: documentId,
        actor: userActor(action),
        metadata: { versionNumber, attachmentId: input.attachmentId, expiryDate: input.expiryDate ?? null },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'corporate_document', documentId);
    });
    return this.get(action, documentId);
  }

  /** Attachment owner policy of CORPORATE_DOCUMENT (versions are permanent: no delete). */
  async attachmentAccess(action: ActionContext, documentId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.corporateDocument.findFirst({
      where: { organizationId, id: documentId },
      select: corporateAccessSelect,
    });
    if (row === null) return { canView: false, canUpload: false, canDelete: false };
    const facts = corporateFacts(organizationId, row);
    const canView = canViewCorporate(action.principal, facts, row.classification);
    return {
      canView,
      canUpload: canView && row.status === 'ACTIVE' && canManageCorporate(action.principal, facts, row.classification),
      canDelete: false,
    };
  }

  /** Whether a member may see the document (notification recipients are re-checked with this). */
  async memberCanView(organizationId: string, principal: Principal, documentId: string): Promise<boolean> {
    const row = await this.db.corporateDocument.findFirst({
      where: { organizationId, id: documentId },
      select: corporateAccessSelect,
    });
    return row !== null && canViewCorporate(principal, corporateFacts(organizationId, row), row.classification);
  }
}

function toDate(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(`${value}T00:00:00.000Z`);
}

function toSummary(row: SummaryRow, today: string): CorporateDocumentSummaryView {
  const currentExpiryDate = dateOnly(row.currentExpiryDate);
  return {
    id: row.id,
    documentType: row.documentType,
    title: row.title,
    documentNumber: row.documentNumber,
    owner: personOrNull(row.owner),
    classification: row.classification,
    status: row.status,
    currentVersion: row.currentVersion,
    currentExpiryDate,
    validity: documentValidity(row.currentVersion, currentExpiryDate, today),
    daysToExpiry: currentExpiryDate === null ? null : daysBetween(today, currentExpiryDate),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

async function proposedFacts(
  tx: TenantDb,
  organizationId: string,
  ownerMemberId: string | null,
): Promise<ResourceFacts> {
  const owner =
    ownerMemberId === null
      ? null
      : await tx.organizationMember.findFirst({
          where: { organizationId, id: ownerMemberId },
          select: { profile: { select: { departmentId: true } } },
        });
  const department = owner?.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: ownerMemberId === null ? [] : [ownerMemberId],
    subjectMemberIds: ownerMemberId === null ? [] : [ownerMemberId],
    departmentIds: department === null ? [] : [department],
  };
}
