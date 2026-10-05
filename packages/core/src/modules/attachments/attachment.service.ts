import { randomUUID } from 'node:crypto';

import type { AttachmentOwnerType, AttachmentScanStatus, AttachmentStatus, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { ForbiddenError, InvalidInputError, InvalidTransitionError, NotFoundError } from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { AttachmentScanner, StoragePort } from '../../platform/storage/storage-port.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { contentDisposition, inspectContent, sanitizeFilename, verifyContentType } from './attachment-content.js';

export const UPLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Per-owner-type rules (the only module-specific part). Each consumer registers one policy: which
 * content types and sizes it accepts and who may upload to / view an owner.
 */
export interface AttachmentOwnerPolicy {
  readonly ownerType: AttachmentOwnerType;
  readonly allowedContentTypes: readonly string[];
  readonly maxSizeBytes: number;
  /**
   * Whether `listForOwner` may enumerate the owner's attachments. Owners that reference a single
   * current file (avatars) are not listable, so superseded or never-used uploads stay unreachable.
   */
  readonly listable: boolean;
  access(action: ActionContext, ownerId: string): Promise<OwnerAccess>;
  /**
   * Optional owner-side record of an attachment becoming AVAILABLE or being deleted, written in the
   * same transaction as the attachment change (for example a ticket history entry).
   */
  recordChange?(tx: TenantDb, change: AttachmentChange): Promise<void>;
}

export interface AttachmentChange {
  readonly kind: 'ADDED' | 'REMOVED';
  readonly organizationId: string;
  readonly ownerId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly actorMemberId: string;
}

export interface OwnerAccess {
  readonly canView: boolean;
  readonly canUpload: boolean;
  /** May remove attachments of this owner (soft delete; the stored object is removed). */
  readonly canDelete: boolean;
}

export const MAX_OWNER_ATTACHMENTS = 100;

export interface AttachmentView {
  readonly id: string;
  readonly ownerType: AttachmentOwnerType;
  readonly ownerId: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly status: AttachmentStatus;
  readonly scanStatus: AttachmentScanStatus;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface UploadIntent {
  readonly attachment: AttachmentView;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    readonly headers: { readonly 'content-type': string };
    readonly expiresAt: string;
  };
}

const select = {
  id: true,
  ownerType: true,
  ownerId: true,
  storageKey: true,
  originalFilename: true,
  declaredContentType: true,
  declaredSizeBytes: true,
  contentType: true,
  sizeBytes: true,
  checksumSha256: true,
  status: true,
  scanStatus: true,
  rejectionReason: true,
  uploadedByMemberId: true,
  uploadExpiresAt: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.AttachmentSelect;

type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof select }>;

const toView = (row: AttachmentRow): AttachmentView => ({
  id: row.id,
  ownerType: row.ownerType,
  ownerId: row.ownerId,
  filename: row.originalFilename,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  checksumSha256: row.checksumSha256,
  status: row.status,
  scanStatus: row.scanStatus,
  rejectionReason: row.rejectionReason,
  createdAt: row.createdAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
});

/**
 * Attachment foundation (P1-14, SECURITY §6). Upload intent -> pre-signed PUT straight to storage ->
 * complete (HEAD, size re-check, SHA-256, magic-byte sniffing, scan hook) -> authorized, short-lived
 * pre-signed GET. Storage keys are generated here (`org/<orgId>/<owner-type>/<uuid>`, also enforced
 * by a CHECK constraint) and never returned to clients. Owner access is decided by the registered
 * owner policy; foreign or invisible attachments are 404.
 */
export class AttachmentService {
  private readonly policies: ReadonlyMap<AttachmentOwnerType, AttachmentOwnerPolicy>;

  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly storage: StoragePort,
    policies: readonly AttachmentOwnerPolicy[],
    private readonly scanner: AttachmentScanner,
  ) {
    this.policies = new Map(policies.map((policy) => [policy.ownerType, policy]));
  }

  async createUploadIntent(
    action: ActionContext,
    input: {
      ownerType: AttachmentOwnerType;
      ownerId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
    },
  ): Promise<UploadIntent> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const policy = this.policyFor(input.ownerType);
    const access = await policy.access(action, input.ownerId);
    if (!access.canView) {
      throw new NotFoundError('Owner');
    }
    if (!access.canUpload) {
      throw new ForbiddenError();
    }
    if (!policy.allowedContentTypes.includes(input.contentType)) {
      throw new InvalidInputError('contentType', 'This file type is not allowed.');
    }
    if (input.sizeBytes > policy.maxSizeBytes) {
      throw new InvalidInputError('sizeBytes', 'The file is too large.');
    }
    const storageKey = `org/${organizationId}/${input.ownerType.toLowerCase().replaceAll('_', '-')}/${randomUUID()}`;
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.attachment.create({
        data: {
          organizationId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          storageKey,
          originalFilename: sanitizeFilename(input.filename),
          declaredContentType: input.contentType,
          declaredSizeBytes: input.sizeBytes,
          uploadedByMemberId: action.principal.memberId,
          uploadExpiresAt: expiresAt,
        },
        select,
      });
      await recordAudit(tx, organizationId, {
        action: 'attachment.upload_requested',
        entityType: 'attachment',
        entityId: created.id,
        actor: userActor(action),
        metadata: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          declaredContentType: input.contentType,
          declaredSizeBytes: input.sizeBytes,
        },
        context: action.request,
      });
      return created;
    });
    const url = await this.storage.presignUpload({
      key: storageKey,
      contentType: input.contentType,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      attachment: toView(row),
      upload: {
        method: 'PUT',
        url,
        headers: { 'content-type': input.contentType },
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /**
   * Verifies the uploaded object and marks it AVAILABLE, or REJECTED (object deleted) when it is
   * missing, too large, of a different type than declared, or infected. Only the uploader may
   * complete; completing twice returns the current state.
   */
  async complete(action: ActionContext, attachmentId: string): Promise<AttachmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.attachment.findFirst({
      where: { organizationId, id: attachmentId, uploadedByMemberId: action.principal.memberId },
      select,
    });
    if (row === null) {
      throw new NotFoundError('Attachment');
    }
    if (row.status !== 'PENDING_UPLOAD') {
      return toView(row);
    }
    if (row.uploadExpiresAt.getTime() < Date.now() - UPLOAD_URL_TTL_SECONDS * 1000) {
      throw new InvalidTransitionError('The upload window has expired.');
    }
    const policy = this.policyFor(row.ownerType);
    const verdict = await this.verify(row, policy);
    return this.db.$transaction(async (tx) => {
      const updated = await tx.attachment.updateManyAndReturn({
        where: { organizationId, id: row.id, status: 'PENDING_UPLOAD' },
        data: verdict.ok
          ? {
              status: 'AVAILABLE',
              contentType: verdict.contentType,
              sizeBytes: verdict.sizeBytes,
              checksumSha256: verdict.checksumSha256,
              scanStatus: verdict.scanStatus,
              completedAt: new Date(),
            }
          : { status: 'REJECTED', rejectionReason: verdict.reason, completedAt: new Date() },
        select,
      });
      const result = updated[0];
      if (result === undefined) {
        const current = await tx.attachment.findFirstOrThrow({ where: { organizationId, id: row.id }, select });
        return toView(current);
      }
      await recordAudit(tx, organizationId, {
        action: verdict.ok ? 'attachment.completed' : 'attachment.rejected',
        entityType: 'attachment',
        entityId: row.id,
        actor: userActor(action),
        metadata: verdict.ok
          ? { contentType: verdict.contentType, sizeBytes: verdict.sizeBytes, checksumSha256: verdict.checksumSha256 }
          : { reason: verdict.reason },
        context: action.request,
      });
      if (verdict.ok) {
        await policy.recordChange?.(tx, {
          kind: 'ADDED',
          organizationId,
          ownerId: row.ownerId,
          attachmentId: row.id,
          filename: row.originalFilename,
          actorMemberId: action.principal.memberId,
        });
      }
      return toView(result);
    });
  }

  async get(action: ActionContext, attachmentId: string): Promise<AttachmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return toView(await this.loadViewable(action, organizationId, attachmentId));
  }

  /** AVAILABLE attachments of an owner the caller may view (unknown or invisible owner = 404). */
  async listForOwner(
    action: ActionContext,
    ownerType: AttachmentOwnerType,
    ownerId: string,
  ): Promise<AttachmentView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const policy = this.policyFor(ownerType);
    if (!policy.listable) {
      throw new InvalidInputError('ownerType', 'Attachments of this owner type cannot be listed.');
    }
    const access = await policy.access(action, ownerId);
    if (!access.canView) {
      throw new NotFoundError('Owner');
    }
    const rows = await this.db.attachment.findMany({
      where: { organizationId, ownerType, ownerId, status: 'AVAILABLE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_OWNER_ATTACHMENTS,
      select,
    });
    return rows.map(toView);
  }

  /**
   * Soft-deletes an attachment when the owner policy allows it: the row becomes DELETED (kept for
   * audit) and the stored object is removed. Invisible attachments are 404, visible but not
   * deletable ones 403.
   */
  async delete(action: ActionContext, attachmentId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.loadViewable(action, organizationId, attachmentId);
    const policy = this.policies.get(row.ownerType);
    const access = policy === undefined ? null : await policy.access(action, row.ownerId);
    if (access?.canDelete !== true) {
      throw new ForbiddenError();
    }
    const deleted = await this.db.$transaction(async (tx) => {
      const result = await tx.attachment.updateMany({
        where: { organizationId, id: row.id, status: { not: 'DELETED' } },
        data: { status: 'DELETED' },
      });
      if (result.count === 0) {
        return false;
      }
      await recordAudit(tx, organizationId, {
        action: 'attachment.deleted',
        entityType: 'attachment',
        entityId: row.id,
        actor: userActor(action),
        metadata: { ownerType: row.ownerType, ownerId: row.ownerId },
        context: action.request,
      });
      if (row.status === 'AVAILABLE') {
        await policy?.recordChange?.(tx, {
          kind: 'REMOVED',
          organizationId,
          ownerId: row.ownerId,
          attachmentId: row.id,
          filename: row.originalFilename,
          actorMemberId: action.principal.memberId,
        });
      }
      await enqueueOutboxEvent(tx, organizationId, {
        eventType: 'attachment.object.delete',
        aggregateType: 'attachment',
        aggregateId: row.id,
        payload: { attachmentId: row.id },
      });
      return true;
    });
    if (!deleted) {
      throw new NotFoundError('Attachment');
    }
  }

  /**
   * Removes the stored object of a DELETED attachment (outbox consumer, system tenant context of
   * the attachment's organization). Idempotent: deleting an absent object succeeds. Returns false
   * when no DELETED attachment with this id exists in the organization.
   */
  async deleteStoredObject(attachmentId: string): Promise<boolean> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const row = await this.db.attachment.findFirst({
      where: { organizationId, id: attachmentId, status: 'DELETED' },
      select: { storageKey: true },
    });
    if (row === null) {
      return false;
    }
    await this.storage.delete(row.storageKey);
    return true;
  }

  /** Authorizes, audits and returns a 60-second pre-signed GET for an AVAILABLE attachment. */
  async downloadUrl(action: ActionContext, attachmentId: string): Promise<string> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.loadViewable(action, organizationId, attachmentId);
    if (row.status !== 'AVAILABLE' || row.contentType === null) {
      throw new NotFoundError('Attachment');
    }
    await recordAudit(this.db, organizationId, {
      action: 'attachment.downloaded',
      entityType: 'attachment',
      entityId: row.id,
      actor: userActor(action),
      context: action.request,
    });
    return this.storage.presignDownload({
      key: row.storageKey,
      contentType: row.contentType,
      contentDisposition: contentDisposition(row.originalFilename),
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    });
  }

  /**
   * Maintenance (system tenant context of the attachment's organization): an upload never completed
   * within its window is marked DELETED and its object, if any, removed.
   */
  async expirePendingUpload(attachmentId: string): Promise<boolean> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const row = await this.db.attachment.findFirst({
      where: { organizationId, id: attachmentId, status: 'PENDING_UPLOAD', uploadExpiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
    });
    if (row === null) {
      return false;
    }
    await this.storage.delete(row.storageKey);
    await this.db.$transaction(async (tx) => {
      await tx.attachment.updateMany({
        where: { organizationId, id: row.id, status: 'PENDING_UPLOAD' },
        data: { status: 'DELETED', rejectionReason: 'upload_expired' },
      });
      await recordAudit(tx, organizationId, {
        action: 'attachment.expired',
        entityType: 'attachment',
        entityId: row.id,
        actor: { type: 'SYSTEM' },
      });
    });
    return true;
  }

  private async loadViewable(
    action: ActionContext,
    organizationId: string,
    attachmentId: string,
  ): Promise<AttachmentRow> {
    const row = await this.db.attachment.findFirst({
      where: { organizationId, id: attachmentId, status: { not: 'DELETED' } },
      select,
    });
    if (row === null) {
      throw new NotFoundError('Attachment');
    }
    const policy = this.policies.get(row.ownerType);
    const visible =
      row.uploadedByMemberId === action.principal.memberId ||
      (policy !== undefined && (await policy.access(action, row.ownerId)).canView);
    if (!visible) {
      throw new NotFoundError('Attachment');
    }
    return row;
  }

  private policyFor(ownerType: AttachmentOwnerType): AttachmentOwnerPolicy {
    const policy = this.policies.get(ownerType);
    if (policy === undefined) {
      throw new InvalidInputError('ownerType', 'Attachments are not supported for this owner type.');
    }
    return policy;
  }

  private async verify(
    row: AttachmentRow,
    policy: AttachmentOwnerPolicy,
  ): Promise<
    | { ok: true; contentType: string; sizeBytes: number; checksumSha256: string; scanStatus: 'NOT_SCANNED' | 'CLEAN' }
    | { ok: false; reason: string }
  > {
    const reject = async (reason: string) => {
      await this.storage.delete(row.storageKey);
      return { ok: false as const, reason };
    };
    const head = await this.storage.head(row.storageKey);
    if (head === null) {
      throw new InvalidTransitionError('The file has not been uploaded yet.');
    }
    if (head.sizeBytes > policy.maxSizeBytes || head.sizeBytes !== row.declaredSizeBytes) {
      return reject('size_mismatch');
    }
    const inspected = await inspectContent(await this.storage.read(row.storageKey), policy.maxSizeBytes);
    if (inspected?.sizeBytes !== row.declaredSizeBytes) {
      return reject('size_mismatch');
    }
    const sniffed = await verifyContentType(inspected.head, row.declaredContentType, policy.allowedContentTypes);
    if (!sniffed.ok) {
      return reject(sniffed.reason);
    }
    const scan = await this.scanner.scan(row.storageKey);
    if (scan === 'INFECTED') {
      return reject('infected');
    }
    return {
      ok: true,
      contentType: sniffed.contentType,
      sizeBytes: inspected.sizeBytes,
      checksumSha256: inspected.checksumSha256,
      scanStatus: scan,
    };
  }
}
