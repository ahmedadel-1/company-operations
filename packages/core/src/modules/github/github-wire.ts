import { z } from 'zod';

/**
 * Response shapes of the GitHub REST endpoints used (validated, unknown fields ignored). Only
 * metadata is read: no file lists, diffs, patches, contents or commit history.
 */

const id = z.number().int().positive();
const login = z.string().min(1).max(100);
const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be a timestamp');
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const installationSchema = z.object({
  id,
  app_id: id.optional(),
  account: z
    .object({
      id,
      login: login.optional(),
      slug: login.optional(),
      name: z.string().max(255).nullish(),
      type: z.string().max(40).optional(),
    })
    .nullable(),
  target_type: z.string().max(40).optional(),
  repository_selection: z.enum(['all', 'selected']),
  permissions: z.record(z.string().max(100), z.string().max(20)).default({}),
  events: z.array(z.string().max(100)).max(200).default([]),
  suspended_at: isoDate.nullish(),
});

export type InstallationWire = z.output<typeof installationSchema>;

export const accessTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  expires_at: isoDate,
});

export const userInstallationsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(installationSchema),
});

export const repositorySchema = z.object({
  id,
  node_id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  full_name: z.string().min(3).max(201),
  owner: z.object({ login }),
  private: z.boolean(),
  archived: z.boolean().default(false),
  default_branch: z.string().max(255).nullish(),
  html_url: z.url({ protocol: /^https?$/ }),
});

export type RepositoryWire = z.output<typeof repositorySchema>;

export const installationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(repositorySchema),
});

export const pullRequestSchema = z.object({
  id,
  node_id: z.string().min(1).max(100),
  number: z.number().int().positive(),
  title: z.string().transform((value) => value.slice(0, 1000)),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().default(false),
  merged_at: isoDate.nullish(),
  closed_at: isoDate.nullish(),
  created_at: isoDate,
  updated_at: isoDate,
  user: z.object({ login }).nullish(),
  head: z.object({ ref: z.string().min(1).max(255), sha }),
  base: z.object({ ref: z.string().min(1).max(255) }),
  html_url: z.url({ protocol: /^https?$/ }),
  /** Read only for Jira-key inference (capped) and never stored. */
  body: z.string().nullish(),
  requested_reviewers: z.array(z.object({ login })).max(200).default([]),
  requested_teams: z
    .array(z.object({ slug: z.string().min(1).max(100) }))
    .max(200)
    .default([]),
});

export type PullRequestWire = z.output<typeof pullRequestSchema>;

export const pullRequestListSchema = z.array(pullRequestSchema);

export const reviewSchema = z.object({
  id,
  user: z.object({ login }).nullish(),
  state: z.string().max(40),
  submitted_at: isoDate.nullish(),
});

export type ReviewWire = z.output<typeof reviewSchema>;

export const reviewListSchema = z.array(reviewSchema);

export const checkRunSchema = z.object({
  id,
  status: z.string().max(40),
  conclusion: z.string().max(40).nullish(),
});

export type CheckRunWire = z.output<typeof checkRunSchema>;

export const checkRunListSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(checkRunSchema),
});

export const combinedStatusSchema = z.object({
  state: z.string().max(40),
  total_count: z.number().int().nonnegative(),
  statuses: z.array(z.object({ state: z.string().max(40) })).default([]),
});

export type CombinedStatusWire = z.output<typeof combinedStatusSchema>;

/** `POST /login/oauth/access_token` answers 200 with either a token or an `error` field. */
export const userTokenSchema = z.object({
  access_token: z.string().min(1).max(4096).optional(),
  token_type: z.string().max(40).optional(),
  error: z.string().max(100).optional(),
});
