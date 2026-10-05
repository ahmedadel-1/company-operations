import type { CommercialDocumentCategory, DocumentClassification, Prisma } from '@company-ops/db';
import type { AddDocumentVersionRequest, CreateCommercialDocumentRequest } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { OwnerAccess } from '../attachments/attachment.service.js';
import {
  canViewCommercialDocument,
  loadContractForAccess,
  loadTenderForAccess,
  loadVisibleContract,
  loadVisibleTender,
  minimumClassification,
  satisfiesMinimum,
  visibleDocumentWhere,
} from './commercial-access.js';
import type { LoadedContract, LoadedTender } from './commercial-access.js';
import {
  announceCommercialChange,
  appendContractEvent,
  appendTenderEvent,
  iso,
  isoOrNull,
  memberRefSelect,
  personOrNull,
} from './commercial-support.js';
import type { EventParams, PersonRef } from './commercial-support.js';

export type DocumentParent =
  | { readonly type: 'TENDER'; readonly loaded: LoadedTender }
  | { readonly type: 'CONTRACT'; readonly loaded: LoadedContract };

export interface CommercialDocumentVersionView {
  readonly id: string;
  readonly versionNumber: number;
  readonly attachmentId: string;
  readonly filename: string;
  readonly notes: string | null;
  readonly uploadedBy: PersonRef | null;
  readonly uploadedAt: string;
  readonly supersededByVersionId: string | null;
  readonly isCurrent: boolean;
}

export interface CommercialDocumentView {
  readonly id: string;
  readonly parent: { readonly type: 'TENDER' | 'CONTRACT'; readonly id: string };
  readonly category: CommercialDocumentCategory;
  readonly classification: DocumentClassification;
  readonly title: string;
  readonly description: string | null;
  readonly currentVersion: number;
  readonly archivedAt: string | null;
  readonly versions: CommercialDocumentVersionView[];
  readonly createdBy: PersonRef | null;
  readonly createdAt: string;
  readonly version: number;
  readonly canManage: boolean;
}

const documentSelect = {
  id: true,
  tenderId: true,
  contractId: true,
  category: true,
  classification: true,
  title: true,
  description: true,
  currentVersion: true,
  archivedAt: true,
  version: true,
  createdAt: true,
  createdBy: { select: memberRefSelect },
  versions: {
    orderBy: { versionNumber: 'asc' },
    select: {
      id: true,
      versionNumber: true,
      attachmentId: true,
      notes: true,
      uploadedAt: true,
      uploadedBy: { select: memberRefSelect },
      attachment: { select: { originalFilename: true } },
    },
  },
} satisfies Prisma.CommercialDocumentSelect;
type DocumentRow = Prisma.CommercialDocumentGetPayload<{ select: typeof documentSelect }>;

const financialPermission = (parent: DocumentParent): 'tender.financial.view' | 'contract.financial.view' =>
  parent.type === 'TENDER' ? 'tender.financial.view' : 'contract.financial.view';

/** Documents of closed records stay readable; new documents and versions need the manage permission. */
export function canManageCommercialDocuments(parent: DocumentParent): boolean {
  if (parent.loaded.level !== 'FULL') return false;
  if (parent.type === 'TENDER') {
    const status = parent.loaded.row.status;
    return status !== 'ARCHIVED' && status !== 'CANCELLED' && parent.loaded.can('tender.edit');
  }
  return parent.loaded.row.status !== 'CLOSED' && parent.loaded.can('contract.manage_documents');
}

/**
 * Tender and contract documents (spec §19-§20, §37): business metadata and append-only versions over
 * the attachment service (binaries are never duplicated; a version references one AVAILABLE
 * attachment uploaded to the document). Visibility follows the parent and the classification
 * (`canViewCommercialDocument`); a hidden document is filtered in SQL, so neither it nor its count,
 * timeline entries or references reach the caller.
 */
export class CommercialDocumentService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listForTender(action: ActionContext, tenderId: string): Promise<{ items: CommercialDocumentView[] }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    return this.listFor(organizationId, { type: 'TENDER', loaded: tender }, { tenderId });
  }

  async listForContract(action: ActionContext, contractId: string): Promise<{ items: CommercialDocumentView[] }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    return this.listFor(organizationId, { type: 'CONTRACT', loaded: contract }, { contractId });
  }

  async createForTender(
    action: ActionContext,
    tenderId: string,
    input: CreateCommercialDocumentRequest,
  ): Promise<CommercialDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      return this.create(tx, action, organizationId, { type: 'TENDER', loaded: tender }, input);
    });
    return this.get(action, id);
  }

  async createForContract(
    action: ActionContext,
    contractId: string,
    input: CreateCommercialDocumentRequest,
  ): Promise<CommercialDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      return this.create(tx, action, organizationId, { type: 'CONTRACT', loaded: contract }, input);
    });
    return this.get(action, id);
  }

  async get(action: ActionContext, documentId: string): Promise<CommercialDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.commercialDocument.findFirst({
      where: { organizationId, id: documentId },
      select: documentSelect,
    });
    if (row === null) throw new NotFoundError('Document');
    const parent = await this.parentOf(this.db, action, organizationId, row);
    if (parent === null || !canViewCommercialDocument(parent.loaded, financialPermission(parent), row.classification)) {
      throw new NotFoundError('Document');
    }
    return toView(row, canManageCommercialDocuments(parent));
  }

  /** Adds the next version from an AVAILABLE attachment uploaded to this document. */
  async addVersion(
    action: ActionContext,
    documentId: string,
    input: AddDocumentVersionRequest,
  ): Promise<CommercialDocumentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const row = await tx.commercialDocument.findFirst({
        where: { organizationId, id: documentId },
        select: {
          id: true,
          tenderId: true,
          contractId: true,
          classification: true,
          category: true,
          currentVersion: true,
          archivedAt: true,
          title: true,
        },
      });
      if (row === null) throw new NotFoundError('Document');
      const parent = await this.parentOf(tx, action, organizationId, row);
      if (
        parent === null ||
        !canViewCommercialDocument(parent.loaded, financialPermission(parent), row.classification)
      ) {
        throw new NotFoundError('Document');
      }
      if (!canManageCommercialDocuments(parent)) throw new ForbiddenError();
      if (row.archivedAt !== null) throw new InvalidTransitionError('The document is archived.');
      const attachment = await tx.attachment.findFirst({
        where: { organizationId, id: input.attachmentId, ownerType: 'COMMERCIAL_DOCUMENT', ownerId: documentId },
        select: { status: true },
      });
      if (attachment === null) throw new InvalidInputError('attachmentId', 'Upload the file to this document first.');
      if (attachment.status !== 'AVAILABLE') throw new InvalidInputError('attachmentId', 'The upload is not complete.');
      const versionNumber = row.currentVersion + 1;
      const bumped = await tx.commercialDocument.updateMany({
        where: { organizationId, id: documentId, currentVersion: row.currentVersion },
        data: { currentVersion: versionNumber, version: { increment: 1 } },
      });
      if (bumped.count === 0) throw new ConflictError('Another version was added at the same time; reload and retry.');
      try {
        await tx.commercialDocumentVersion.create({
          data: {
            organizationId,
            documentId,
            versionNumber,
            attachmentId: input.attachmentId,
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
      await this.appendEvent(tx, organizationId, parent, 'document_version_added', action.principal.memberId, {
        documentId,
        category: row.category,
        versionNumber,
        ...(row.classification === 'GENERAL' ? { title: row.title } : {}),
      });
      await recordAudit(tx, organizationId, {
        action: 'commercial_document.version_added',
        entityType: 'commercial_document',
        entityId: documentId,
        actor: userActor(action),
        metadata: {
          parentType: parent.type,
          parentId: parent.loaded.row.id,
          versionNumber,
          attachmentId: input.attachmentId,
        },
        context: action.request,
      });
      await announceCommercialChange(
        tx,
        organizationId,
        parent.type === 'TENDER' ? 'tender' : 'contract',
        parent.loaded.row.id,
      );
    });
    return this.get(action, documentId);
  }

  /** Attachment owner policy of COMMERCIAL_DOCUMENT: view follows classification; versions are never deleted. */
  async attachmentAccess(action: ActionContext, documentId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.commercialDocument.findFirst({
      where: { organizationId, id: documentId },
      select: { tenderId: true, contractId: true, classification: true, archivedAt: true },
    });
    const none = { canView: false, canUpload: false, canDelete: false };
    if (row === null) return none;
    const parent = await this.parentOf(this.db, action, organizationId, row);
    if (parent === null || !canViewCommercialDocument(parent.loaded, financialPermission(parent), row.classification))
      return none;
    return {
      canView: true,
      canUpload: row.archivedAt === null && canManageCommercialDocuments(parent),
      canDelete: false,
    };
  }

  // ---- internals ----

  private async listFor(
    organizationId: string,
    parent: DocumentParent,
    where: Prisma.CommercialDocumentWhereInput,
  ): Promise<{ items: CommercialDocumentView[] }> {
    const rows = await this.db.commercialDocument.findMany({
      where: { organizationId, ...where, ...visibleDocumentWhere(parent.loaded, financialPermission(parent)) },
      orderBy: [{ category: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 300,
      select: documentSelect,
    });
    const manage = canManageCommercialDocuments(parent);
    return { items: rows.map((row) => toView(row, manage)) };
  }

  private async create(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    parent: DocumentParent,
    input: CreateCommercialDocumentRequest,
  ): Promise<string> {
    if (!canManageCommercialDocuments(parent)) throw new ForbiddenError();
    const classification = input.classification ?? minimumClassification(input.category);
    if (!satisfiesMinimum(classification, input.category)) {
      throw new InvalidInputError(
        'classification',
        `${input.category} documents need at least ${minimumClassification(input.category)}.`,
      );
    }
    if (!canViewCommercialDocument(parent.loaded, financialPermission(parent), classification)) {
      throw new ForbiddenError('You cannot create a document you would not be allowed to view.');
    }
    const created = await tx.commercialDocument.create({
      data: {
        organizationId,
        tenderId: parent.type === 'TENDER' ? parent.loaded.row.id : null,
        contractId: parent.type === 'CONTRACT' ? parent.loaded.row.id : null,
        category: input.category,
        classification,
        title: input.title,
        description: input.description ?? null,
        createdByMemberId: action.principal.memberId,
      },
      select: { id: true },
    });
    await this.appendEvent(tx, organizationId, parent, 'document_added', action.principal.memberId, {
      documentId: created.id,
      category: input.category,
      ...(classification === 'GENERAL' ? { title: input.title } : {}),
    });
    await recordAudit(tx, organizationId, {
      action: 'commercial_document.created',
      entityType: 'commercial_document',
      entityId: created.id,
      actor: userActor(action),
      metadata: { parentType: parent.type, parentId: parent.loaded.row.id, category: input.category, classification },
      context: action.request,
    });
    return created.id;
  }

  private async parentOf(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    row: { tenderId: string | null; contractId: string | null },
  ): Promise<DocumentParent | null> {
    if (row.tenderId !== null) {
      const tender = await loadTenderForAccess(db, action.principal, organizationId, row.tenderId);
      return tender === null ? null : { type: 'TENDER', loaded: tender };
    }
    if (row.contractId !== null) {
      const contract = await loadContractForAccess(db, action.principal, organizationId, row.contractId);
      return contract === null ? null : { type: 'CONTRACT', loaded: contract };
    }
    return null;
  }

  private async appendEvent(
    tx: TenantDb,
    organizationId: string,
    parent: DocumentParent,
    type: 'document_added' | 'document_version_added',
    actorMemberId: string,
    params: EventParams,
  ): Promise<void> {
    if (parent.type === 'TENDER') {
      await appendTenderEvent(tx, organizationId, parent.loaded.row.id, `tender.${type}`, actorMemberId, params);
    } else {
      await appendContractEvent(tx, organizationId, parent.loaded.row.id, `contract.${type}`, actorMemberId, params);
    }
  }
}

function parentRef(row: { tenderId: string | null; contractId: string | null }): CommercialDocumentView['parent'] {
  if (row.tenderId !== null) return { type: 'TENDER', id: row.tenderId };
  if (row.contractId !== null) return { type: 'CONTRACT', id: row.contractId };
  throw new Error('A commercial document has exactly one parent (database CHECK).');
}

function toView(row: DocumentRow, canManage: boolean): CommercialDocumentView {
  return {
    id: row.id,
    parent: parentRef(row),
    category: row.category,
    classification: row.classification,
    title: row.title,
    description: row.description,
    currentVersion: row.currentVersion,
    archivedAt: isoOrNull(row.archivedAt),
    versions: row.versions.map((version, index) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      attachmentId: version.attachmentId,
      filename: version.attachment.originalFilename,
      notes: version.notes,
      uploadedBy: personOrNull(version.uploadedBy),
      uploadedAt: iso(version.uploadedAt),
      supersededByVersionId: row.versions[index + 1]?.id ?? null,
      isCurrent: version.versionNumber === row.currentVersion,
    })),
    createdBy: personOrNull(row.createdBy),
    createdAt: iso(row.createdAt),
    version: row.version,
    canManage: canManage && row.archivedAt === null,
  };
}
