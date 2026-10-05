import { z } from 'zod';

import { dataResponseSchema, isoDateTimeSchema, pageQueryShape, pageResponseSchema } from './pagination.js';

const actionSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_.]*$/, 'lowercase dotted action name');

export const auditEventSchema = z.strictObject({
  id: z.uuid(),
  createdAt: isoDateTimeSchema,
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorType: z.enum(['USER', 'SYSTEM', 'INTEGRATION']),
  actor: z.strictObject({
    memberId: z.uuid().nullable(),
    userId: z.uuid().nullable(),
    displayName: z.string().nullable(),
  }),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Redacted when written; never contains secrets. */
  metadata: z.record(z.string(), z.unknown()),
});

export const auditEventResponseSchema = dataResponseSchema(auditEventSchema);
export const auditEventPageResponseSchema = pageResponseSchema(auditEventSchema);

export const auditEventListQuerySchema = z
  .strictObject({
    action: actionSchema.optional(),
    actionPrefix: actionSchema.optional(),
    entityType: z
      .string()
      .max(64)
      .regex(/^[a-z_]+$/)
      .optional(),
    entityId: z.string().max(64).optional(),
    actorMemberId: z.uuid().optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    ...pageQueryShape,
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from < value.to, {
    message: '`from` must be before `to`',
    path: ['from'],
  });

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventListQuery = z.infer<typeof auditEventListQuerySchema>;
