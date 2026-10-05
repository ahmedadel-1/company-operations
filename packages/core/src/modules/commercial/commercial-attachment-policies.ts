import type { ActionContext } from '../action-context.js';
import type { AttachmentOwnerPolicy, OwnerAccess } from '../attachments/attachment.service.js';
import type { CommercialDocumentService } from './commercial-document.service.js';
import type { ContractWorkService } from './contract-work.service.js';
import type { CorporateDocumentService } from './corporate-document.service.js';
import type { GuaranteeService } from './guarantee.service.js';
import type { TenderRequirementService } from './tender-requirement.service.js';

/** Business documents: PDF, Office (OOXML), images and plain text; ZIP stays disabled (SECURITY §6). */
export const COMMERCIAL_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
] as const;
export const COMMERCIAL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Attachment owners of the commercial domain (ADR-0026) on the shared attachment foundation. Each
 * policy delegates to its record's access rule; files of documents become versions only through the
 * document services, and downloads are authorized per request like every other attachment.
 */
abstract class CommercialAttachmentPolicy implements AttachmentOwnerPolicy {
  abstract readonly ownerType: AttachmentOwnerPolicy['ownerType'];
  readonly allowedContentTypes = COMMERCIAL_CONTENT_TYPES;
  readonly maxSizeBytes = COMMERCIAL_ATTACHMENT_MAX_BYTES;
  readonly listable: boolean = true;
  abstract access(action: ActionContext, ownerId: string): Promise<OwnerAccess>;
}

/** Version files of tender/contract documents; not listable (versions reference their file). */
export class CommercialDocumentAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'COMMERCIAL_DOCUMENT' as const;
  override readonly listable = false;

  constructor(private readonly documents: CommercialDocumentService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.documents.attachmentAccess(action, ownerId);
  }
}

/** Version files of corporate vault documents; not listable (versions reference their file). */
export class CorporateDocumentAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'CORPORATE_DOCUMENT' as const;
  override readonly listable = false;

  constructor(private readonly documents: CorporateDocumentService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.documents.attachmentAccess(action, ownerId);
  }
}

export class TenderRequirementAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'TENDER_REQUIREMENT' as const;

  constructor(private readonly requirements: TenderRequirementService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.requirements.attachmentAccess(action, ownerId);
  }
}

export class ObligationOccurrenceAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'OBLIGATION_OCCURRENCE' as const;

  constructor(private readonly work: ContractWorkService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.work.occurrenceAttachmentAccess(action, ownerId);
  }
}

export class ContractMilestoneAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'CONTRACT_MILESTONE' as const;

  constructor(private readonly work: ContractWorkService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.work.milestoneAttachmentAccess(action, ownerId);
  }
}

export class GuaranteeAttachmentPolicy extends CommercialAttachmentPolicy {
  readonly ownerType = 'GUARANTEE' as const;

  constructor(private readonly guarantees: GuaranteeService) {
    super();
  }

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.guarantees.attachmentAccess(action, ownerId);
  }
}
