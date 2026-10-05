import { z } from 'zod';

import { dataResponseSchema, isoDateTimeSchema, listResponseSchema } from './pagination.js';

/**
 * Owner types with a registered owner policy (employee avatar, daily report, support ticket, request and
 * the Phase 10 commercial owners: a tender/contract document, a corporate vault document and the
 * evidence of a tender requirement, an obligation occurrence, a contract milestone or a guarantee).
 */
export const attachmentOwnerTypeSchema = z.enum([
  'EMPLOYEE_AVATAR',
  'DAILY_REPORT',
  'SUPPORT_TICKET',
  'REQUEST',
  'COMMERCIAL_DOCUMENT',
  'CORPORATE_DOCUMENT',
  'TENDER_REQUIREMENT',
  'OBLIGATION_OCCURRENCE',
  'CONTRACT_MILESTONE',
  'GUARANTEE',
]);

export const attachmentSchema = z.strictObject({
  id: z.uuid(),
  ownerType: z.enum([
    'SUPPORT_TICKET',
    'SUPPORT_COMMENT',
    'REQUEST',
    'DAILY_REPORT',
    'EMPLOYEE_AVATAR',
    'COMMERCIAL_DOCUMENT',
    'CORPORATE_DOCUMENT',
    'TENDER_REQUIREMENT',
    'OBLIGATION_OCCURRENCE',
    'CONTRACT_MILESTONE',
    'GUARANTEE',
  ]),
  ownerId: z.uuid(),
  /** Sanitized display name; storage keys are never exposed. */
  filename: z.string(),
  /** Server-sniffed type; null until the upload is verified. */
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  checksumSha256: z.string().nullable(),
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'REJECTED', 'DELETED']),
  scanStatus: z.enum(['NOT_SCANNED', 'CLEAN', 'INFECTED']),
  rejectionReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});

export const attachmentResponseSchema = dataResponseSchema(attachmentSchema);
export const attachmentListResponseSchema = listResponseSchema(attachmentSchema);

/** Available attachments of one owner the caller may view. */
export const attachmentListQuerySchema = z.strictObject({
  ownerType: attachmentOwnerTypeSchema,
  ownerId: z.uuid(),
});

export const createUploadIntentRequestSchema = z.strictObject({
  ownerType: attachmentOwnerTypeSchema,
  ownerId: z.uuid(),
  filename: z.string().min(1).max(1024),
  contentType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, 'a MIME type without parameters'),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024),
});

export const uploadIntentResponseSchema = dataResponseSchema(
  z.strictObject({
    attachment: attachmentSchema,
    upload: z.strictObject({
      method: z.literal('PUT'),
      /** Pre-signed URL; upload the bytes with exactly the listed headers before `expiresAt`. */
      url: z.url(),
      headers: z.strictObject({ 'content-type': z.string() }),
      expiresAt: isoDateTimeSchema,
    }),
  }),
);

export const downloadUrlResponseSchema = dataResponseSchema(
  z.strictObject({
    /** Short-lived (60 s) pre-signed URL. */
    url: z.url(),
  }),
);

export type Attachment = z.infer<typeof attachmentSchema>;
export type CreateUploadIntentRequest = z.infer<typeof createUploadIntentRequestSchema>;
export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>;
