import type { ActionContext } from '../action-context.js';
import type { AttachmentOwnerPolicy, OwnerAccess } from '../attachments/attachment.service.js';
import type { EmployeeService } from './employee.service.js';

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** First attachment consumer (P1-14): an employee's avatar image. */
export class EmployeeAvatarPolicy implements AttachmentOwnerPolicy {
  readonly ownerType = 'EMPLOYEE_AVATAR' as const;
  readonly allowedContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
  readonly maxSizeBytes = AVATAR_MAX_BYTES;
  readonly listable = false;

  constructor(private readonly employees: EmployeeService) {}

  /** Avatars are replaced, never deleted directly: the profile references the current one. */
  async access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    const access = await this.employees.avatarAccess(action, ownerId);
    return { canView: access.canView, canUpload: access.canChange, canDelete: false };
  }
}
