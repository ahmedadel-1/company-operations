import { z } from 'zod';

/**
 * Response shapes of the Atlassian endpoints we call (verified against developer.atlassian.com on
 * 2026-10-03, ADR-0019). Only the fields we use are declared; unknown fields are ignored, and a
 * missing required field fails validation (`malformed`) instead of producing a partial record.
 */

const id = z.union([z.string().regex(/^[0-9]{1,20}$/), z.number().int().nonnegative()]).transform(String);

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.output<typeof tokenResponseSchema>;

export const accessibleResourcesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(255),
      url: z.url({ protocol: /^https?$/ }),
      scopes: z.array(z.string()).default([]),
    }),
  )
  .max(200);
export type AccessibleResource = z.output<typeof accessibleResourcesSchema>[number];

export const projectSchema = z.object({
  id,
  key: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
});
export type JiraProjectWire = z.output<typeof projectSchema>;

export const projectSearchSchema = z.object({
  values: z.array(projectSchema),
  isLast: z.boolean().optional(),
  total: z.number().int().optional(),
});

const named = z.object({ name: z.string() });

export const issueSchema = z.object({
  id,
  key: z.string().min(1).max(64),
  fields: z.object({
    summary: z.string(),
    issuetype: z.object({ name: z.string(), subtask: z.boolean().optional() }),
    status: z.object({
      name: z.string(),
      statusCategory: z.object({ key: z.string() }).optional(),
    }),
    priority: named.nullish(),
    assignee: z.object({ accountId: z.string().optional(), displayName: z.string().optional() }).nullish(),
    reporter: z.object({ displayName: z.string().optional() }).nullish(),
    created: z.string(),
    updated: z.string(),
    duedate: z.string().nullish(),
    resolution: named.nullish(),
    resolutiondate: z.string().nullish(),
    labels: z.array(z.string()).nullish(),
    parent: z.object({ id }).nullish(),
    project: z.object({ id, key: z.string().optional() }),
  }),
});
export type JiraIssueWire = z.output<typeof issueSchema>;

export const searchJqlSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

export const approximateCountSchema = z.object({ count: z.number().int().nonnegative() });

export const bulkFetchSchema = z.object({
  issues: z.array(issueSchema).default([]),
  issueErrors: z.array(z.unknown()).default([]),
});

const issueTypeSchema = z.object({ id, name: z.string().min(1).max(255), subtask: z.boolean().optional() });

/** `GET /issue/createmeta/{project}/issuetypes`; Atlassian documents `issueTypes`, older sites use `values`. */
export const createMetaIssueTypesSchema = z
  .object({ issueTypes: z.array(issueTypeSchema).optional(), values: z.array(issueTypeSchema).optional() })
  .transform((value) => value.issueTypes ?? value.values ?? []);
export type JiraIssueTypeWire = z.output<typeof issueTypeSchema>;

export const createdIssueSchema = z.object({ id, key: z.string().min(1).max(64) });

export const webhookRegisterSchema = z.object({
  webhookRegistrationResult: z.array(
    z.object({ createdWebhookId: id.optional(), errors: z.array(z.string()).optional() }),
  ),
});

/** `expirationDate` is documented as epoch milliseconds; an ISO string is accepted as well. */
export const webhookRefreshSchema = z.object({
  expirationDate: z.union([z.number(), z.string()]).transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'invalid expirationDate' });
      return z.NEVER;
    }
    return date;
  }),
});

export const webhookListSchema = z.object({
  values: z.array(z.object({ id, jqlFilter: z.string().optional() })).default([]),
  isLast: z.boolean().optional(),
});

/** The fields every search and fetch requests (keeps payloads small). */
export const ISSUE_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'created',
  'updated',
  'duedate',
  'resolution',
  'resolutiondate',
  'labels',
  'parent',
  'project',
] as const;
