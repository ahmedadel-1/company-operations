import type { ActionContext } from '../action-context.js';
import type { AttachmentOwnerPolicy, OwnerAccess } from '../attachments/attachment.service.js';
import type { RequestService } from './request.service.js';

export const REQUEST_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Supporting documents of requests (ADR-0021), on the shared attachment foundation. */
export class RequestAttachmentPolicy implements AttachmentOwnerPolicy {
  readonly ownerType = 'REQUEST' as const;
  readonly allowedContentTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
  ] as const;
  readonly maxSizeBytes = REQUEST_ATTACHMENT_MAX_BYTES;
  readonly listable = true;

  constructor(private readonly requests: RequestService) {}

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.requests.attachmentAccess(action, ownerId);
  }
}
