-- Phase 5 (GitHub App): installations, repository cache, project mappings, pull-request metadata
-- cache, PR↔Jira links, webhook deliveries, sync runs/failures and direct ticket↔PR links, plus
-- technical-record retention policies and the bounded purge function (ADR-0020).
-- Generated with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- against a database at the previous migration, then extended by hand with the statements marked
-- "Hand-written" (not expressible in schema.prisma).

-- CreateEnum
CREATE TYPE "RetentionCategory" AS ENUM ('WEBHOOK_DELIVERIES', 'SYNC_FAILURES');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('DELETE_ROWS');

-- CreateEnum
CREATE TYPE "GithubInstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "GithubAccountType" AS ENUM ('ORGANIZATION', 'USER', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "GithubRepositorySelection" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "GithubRepositoryStatus" AS ENUM ('AVAILABLE', 'REMOVED', 'DELETED');

-- CreateEnum
CREATE TYPE "GithubSyncState" AS ENUM ('NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "GithubPullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "GithubReviewState" AS ENUM ('NONE', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "GithubChecksState" AS ENUM ('UNKNOWN', 'PENDING', 'SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "GithubPrJiraLinkSource" AS ENUM ('MANUAL', 'BRANCH_NAME', 'TITLE', 'BODY');

-- CreateEnum
CREATE TYPE "GithubPrJiraLinkState" AS ENUM ('SUGGESTED', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "GithubWebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "GithubSyncRunType" AS ENUM ('INITIAL_SYNC', 'RECONCILIATION', 'MANUAL_RESYNC');

-- CreateEnum
CREATE TYPE "GithubSyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GithubFailureClass" AS ENUM ('RETRYABLE', 'PERMANENT');

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "category" "RetentionCategory" NOT NULL,
    "retain_days" INTEGER NOT NULL,
    "action" "RetentionAction" NOT NULL DEFAULT 'DELETE_ROWS',
    "configured_by_member_id" UUID,
    "configured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_purged_at" TIMESTAMPTZ(6),
    "last_purged_count" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "github_installation_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" "GithubAccountType" NOT NULL,
    "repository_selection" "GithubRepositorySelection" NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "GithubInstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspended_at" TIMESTAMPTZ(6),
    "installed_by_member_id" UUID,
    "bound_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repositories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "node_id" TEXT NOT NULL,
    "owner_login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "default_branch" TEXT,
    "html_url" TEXT NOT NULL,
    "status" "GithubRepositoryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "unavailable_at" TIMESTAMPTZ(6),
    "sync_state" "GithubSyncState" NOT NULL DEFAULT 'NOT_STARTED',
    "last_full_sync_at" TIMESTAMPTZ(6),
    "last_reconciled_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repository_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_by_member_id" UUID,
    "removed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_repository_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_pull_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_pr_id" BIGINT NOT NULL,
    "node_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" "GithubPullRequestState" NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "author_login" TEXT,
    "head_ref" TEXT NOT NULL,
    "base_ref" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "review_state" "GithubReviewState" NOT NULL DEFAULT 'NONE',
    "requested_reviewers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checks_state" "GithubChecksState" NOT NULL DEFAULT 'UNKNOWN',
    "checks_total" INTEGER NOT NULL DEFAULT 0,
    "checks_failed" INTEGER NOT NULL DEFAULT 0,
    "checks_pending" INTEGER NOT NULL DEFAULT 0,
    "html_url" TEXT NOT NULL,
    "gh_created_at" TIMESTAMPTZ(6) NOT NULL,
    "gh_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "merged_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "jira_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "details_sha" TEXT,
    "details_fetched_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_pr_jira_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "source" "GithubPrJiraLinkSource" NOT NULL,
    "state" "GithubPrJiraLinkState" NOT NULL,
    "decided_by_member_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_pr_jira_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "github_repo_id" BIGINT,
    "pr_number" INTEGER,
    "head_sha" TEXT,
    "status" "GithubWebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" TEXT,
    "error_code" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_sync_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "type" "GithubSyncRunType" NOT NULL,
    "status" "GithubSyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_member_id" UUID,
    "request_id" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "records_processed" INTEGER NOT NULL DEFAULT 0,
    "records_created" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "records_unchanged" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "last_cursor" JSONB NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "github_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_sync_failures" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "pr_number" INTEGER,
    "error_code" TEXT NOT NULL,
    "classification" "GithubFailureClass" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_sync_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_github_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_github_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organization_id_id_key" ON "retention_policies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organization_id_category_key" ON "retention_policies"("organization_id", "category");

-- CreateIndex
CREATE INDEX "github_installations_status_idx" ON "github_installations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_organization_id_id_key" ON "github_installations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_github_installation_id_key" ON "github_installations"("github_installation_id");

-- CreateIndex
CREATE INDEX "github_repositories_organization_id_installation_id_status_idx" ON "github_repositories"("organization_id", "installation_id", "status");

-- CreateIndex
CREATE INDEX "github_repositories_organization_id_full_name_idx" ON "github_repositories"("organization_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "github_repositories_organization_id_id_key" ON "github_repositories"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_repositories_organization_id_github_repo_id_key" ON "github_repositories"("organization_id", "github_repo_id");

-- CreateIndex
CREATE INDEX "github_repository_mappings_organization_id_project_id_idx" ON "github_repository_mappings"("organization_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_repository_mappings_organization_id_id_key" ON "github_repository_mappings"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_repository_mappings_organization_id_repository_id_pr_key" ON "github_repository_mappings"("organization_id", "repository_id", "project_id");

-- CreateIndex
CREATE INDEX "github_pull_requests_organization_id_repository_id_state_idx" ON "github_pull_requests"("organization_id", "repository_id", "state");

-- CreateIndex
CREATE INDEX "github_pull_requests_organization_id_state_review_state_idx" ON "github_pull_requests"("organization_id", "state", "review_state");

-- CreateIndex
CREATE INDEX "github_pull_requests_organization_id_repository_id_head_sha_idx" ON "github_pull_requests"("organization_id", "repository_id", "head_sha");

-- CreateIndex
CREATE INDEX "github_pull_requests_jira_keys_idx" ON "github_pull_requests" USING GIN ("jira_keys");

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_requests_organization_id_id_key" ON "github_pull_requests"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_requests_organization_id_repository_id_github_p_key" ON "github_pull_requests"("organization_id", "repository_id", "github_pr_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_requests_organization_id_repository_id_number_key" ON "github_pull_requests"("organization_id", "repository_id", "number");

-- CreateIndex
CREATE INDEX "github_pr_jira_links_organization_id_issue_id_state_idx" ON "github_pr_jira_links"("organization_id", "issue_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "github_pr_jira_links_organization_id_id_key" ON "github_pr_jira_links"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pr_jira_links_organization_id_pull_request_id_issue__key" ON "github_pr_jira_links"("organization_id", "pull_request_id", "issue_id");

-- CreateIndex
CREATE INDEX "github_webhook_deliveries_organization_id_status_received_a_idx" ON "github_webhook_deliveries"("organization_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "github_webhook_deliveries_organization_id_received_at_idx" ON "github_webhook_deliveries"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_webhook_deliveries_organization_id_id_key" ON "github_webhook_deliveries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_webhook_deliveries_delivery_id_key" ON "github_webhook_deliveries"("delivery_id");

-- CreateIndex
CREATE INDEX "github_sync_runs_organization_id_created_at_id_idx" ON "github_sync_runs"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "github_sync_runs_organization_id_repository_id_created_at_idx" ON "github_sync_runs"("organization_id", "repository_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "github_sync_runs_status_updated_at_idx" ON "github_sync_runs"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_sync_runs_organization_id_id_key" ON "github_sync_runs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "github_sync_runs_active_key" ON "github_sync_runs"("organization_id", "repository_id") WHERE (status = ANY (ARRAY['QUEUED'::"GithubSyncRunStatus", 'RUNNING'::"GithubSyncRunStatus"]));

-- CreateIndex
CREATE INDEX "github_sync_failures_organization_id_run_id_created_at_idx" ON "github_sync_failures"("organization_id", "run_id", "created_at");

-- CreateIndex
CREATE INDEX "github_sync_failures_organization_id_created_at_idx" ON "github_sync_failures"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_sync_failures_organization_id_id_key" ON "github_sync_failures"("organization_id", "id");

-- CreateIndex
CREATE INDEX "support_ticket_github_links_organization_id_pull_request_id_idx" ON "support_ticket_github_links"("organization_id", "pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_github_links_organization_id_id_key" ON "support_ticket_github_links"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_github_links_organization_id_ticket_id_pull__key" ON "support_ticket_github_links"("organization_id", "ticket_id", "pull_request_id");

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_configured_by_member_id_fkey" FOREIGN KEY ("organization_id", "configured_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_installed_by_member_i_fkey" FOREIGN KEY ("organization_id", "installed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_organization_id_installation_id_fkey" FOREIGN KEY ("organization_id", "installation_id") REFERENCES "github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repository_mappings" ADD CONSTRAINT "github_repository_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repository_mappings" ADD CONSTRAINT "github_repository_mappings_organization_id_repository_id_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "github_repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repository_mappings" ADD CONSTRAINT "github_repository_mappings_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_repository_mappings" ADD CONSTRAINT "github_repository_mappings_organization_id_created_by_memb_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_organization_id_repository_id_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "github_repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_organization_id_pull_request_id_fkey" FOREIGN KEY ("organization_id", "pull_request_id") REFERENCES "github_pull_requests"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_organization_id_issue_id_fkey" FOREIGN KEY ("organization_id", "issue_id") REFERENCES "jira_issues"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_organization_id_decided_by_member_id_fkey" FOREIGN KEY ("organization_id", "decided_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_organization_id_installation_id_fkey" FOREIGN KEY ("organization_id", "installation_id") REFERENCES "github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_organization_id_installation_id_fkey" FOREIGN KEY ("organization_id", "installation_id") REFERENCES "github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_organization_id_repository_id_fkey" FOREIGN KEY ("organization_id", "repository_id") REFERENCES "github_repositories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_organization_id_requested_by_member_id_fkey" FOREIGN KEY ("organization_id", "requested_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_failures" ADD CONSTRAINT "github_sync_failures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "github_sync_failures" ADD CONSTRAINT "github_sync_failures_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "github_sync_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_github_links" ADD CONSTRAINT "support_ticket_github_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_github_links" ADD CONSTRAINT "support_ticket_github_links_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_github_links" ADD CONSTRAINT "support_ticket_github_links_organization_id_pull_request_i_fkey" FOREIGN KEY ("organization_id", "pull_request_id") REFERENCES "github_pull_requests"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_github_links" ADD CONSTRAINT "support_ticket_github_links_organization_id_created_by_mem_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints. GitHub ids are positive; text is bounded.
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_days_check"
  CHECK ("retain_days" BETWEEN 7 AND 3650);
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_version_check" CHECK ("version" >= 1);
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_count_check"
  CHECK ("last_purged_count" IS NULL OR "last_purged_count" >= 0);

ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_ids_check"
  CHECK ("github_installation_id" > 0 AND "account_id" > 0);
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_text_check"
  CHECK (length("account_login") BETWEEN 1 AND 100 AND jsonb_typeof("permissions") = 'object'
    AND "events" IS NOT NULL AND cardinality("events") <= 100 AND length("last_error_code") <= 64);
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_version_check" CHECK ("version" >= 1);
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_suspended_check"
  CHECK (("status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL) OR "status" IN ('DELETED', 'DISCONNECTED'));
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_deleted_check"
  CHECK (("status" = 'DELETED') = ("deleted_at" IS NOT NULL));
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_disconnected_check"
  CHECK (("status" = 'DISCONNECTED') = ("disconnected_at" IS NOT NULL));

ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_ids_check"
  CHECK ("github_repo_id" > 0 AND length("node_id") BETWEEN 1 AND 100);
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_text_check"
  CHECK (length("owner_login") BETWEEN 1 AND 100 AND length("name") BETWEEN 1 AND 100
    AND length("full_name") BETWEEN 3 AND 201 AND length("default_branch") <= 255
    AND length("html_url") BETWEEN 8 AND 500 AND "html_url" ~ '^https?://');
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_unavailable_check"
  CHECK (("status" = 'AVAILABLE') = ("unavailable_at" IS NULL));

ALTER TABLE "github_repository_mappings" ADD CONSTRAINT "github_repository_mappings_version_check"
  CHECK ("version" >= 1);

ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_ids_check"
  CHECK ("github_pr_id" > 0 AND "number" > 0 AND length("node_id") BETWEEN 1 AND 100);
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_text_check"
  CHECK (length("title") <= 1000 AND length("author_login") <= 100 AND length("head_ref") BETWEEN 1 AND 255
    AND length("base_ref") BETWEEN 1 AND 255 AND "head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    AND ("details_sha" IS NULL OR "details_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
    AND length("html_url") BETWEEN 8 AND 600 AND "html_url" ~ '^https?://');
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_arrays_check"
  CHECK ("requested_reviewers" IS NOT NULL AND cardinality("requested_reviewers") <= 100
    AND "jira_keys" IS NOT NULL AND cardinality("jira_keys") <= 50);
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_checks_count_check"
  CHECK ("checks_total" >= 0 AND "checks_failed" >= 0 AND "checks_pending" >= 0
    AND "checks_failed" + "checks_pending" <= "checks_total");
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_merged_check"
  CHECK (("state" = 'MERGED') = ("merged_at" IS NOT NULL) AND ("state" = 'OPEN') = ("closed_at" IS NULL));

ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_decided_check"
  CHECK ("state" = 'SUGGESTED' OR "decided_at" IS NOT NULL);
ALTER TABLE "github_pr_jira_links" ADD CONSTRAINT "github_pr_jira_links_manual_check"
  CHECK ("source" <> 'MANUAL' OR "state" <> 'SUGGESTED');

ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_text_check"
  CHECK (length("delivery_id") BETWEEN 1 AND 100 AND length("event") BETWEEN 1 AND 64
    AND length("action") <= 64 AND length("outcome") <= 64 AND length("error_code") <= 64
    AND length("head_sha") <= 64 AND ("github_repo_id" IS NULL OR "github_repo_id" > 0)
    AND ("pr_number" IS NULL OR "pr_number" > 0));
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_processed_check"
  CHECK (("status" = 'RECEIVED') = ("processed_at" IS NULL));

ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_counts_check"
  CHECK ("records_processed" >= 0 AND "records_created" >= 0 AND "records_updated" >= 0
    AND "records_unchanged" >= 0 AND "records_failed" >= 0 AND "pages" >= 0 AND "consecutive_errors" >= 0);
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_cursor_check" CHECK (jsonb_typeof("last_cursor") = 'object');
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_finished_check"
  CHECK (("status" IN ('SUCCEEDED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED')) = ("finished_at" IS NOT NULL));
ALTER TABLE "github_sync_runs" ADD CONSTRAINT "github_sync_runs_error_check"
  CHECK (length("error_code") <= 64 AND length("error_summary") <= 500 AND length("request_id") <= 128);

ALTER TABLE "github_sync_failures" ADD CONSTRAINT "github_sync_failures_text_check"
  CHECK (length("error_code") BETWEEN 1 AND 64 AND length("message") BETWEEN 1 AND 500
    AND ("pr_number" IS NULL OR "pr_number" > 0));

-- Hand-written: sync failures are append-only evidence (SECURITY §8). The only exception is a purge
-- performed by "purge_integration_records" under an explicit retention policy: the function runs as its
-- owner (current_user <> session_user) and raises a transaction-local flag. A session cannot get the
-- exemption by setting the flag itself, and ops_app holds no DELETE privilege on these tables anyway.
CREATE FUNCTION "forbid_append_only_mutation_unless_retention"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ops.retention_purge', true) = 'on'
     AND current_user <> session_user THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER "jira_sync_failures_append_only" ON "jira_sync_failures";
CREATE TRIGGER "jira_sync_failures_append_only" BEFORE UPDATE OR DELETE ON "jira_sync_failures"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation_unless_retention"();
CREATE TRIGGER "github_sync_failures_append_only" BEFORE UPDATE OR DELETE ON "github_sync_failures"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation_unless_retention"();
CREATE TRIGGER "github_sync_failures_no_truncate" BEFORE TRUNCATE ON "github_sync_failures"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: bounded, tenant-scoped purge of technical integration records (ADR-0020). Does nothing
-- unless the organization has an explicit retention policy for the category. Webhook deliveries still
-- awaiting processing (RECEIVED) are never removed; the 7-day minimum keeps dedupe rows well beyond
-- GitHub's 3-day manual-redelivery window and Jira's retry window. Audit history, business links,
-- issue/PR caches and runs are outside its reach.
CREATE FUNCTION "purge_integration_records"(p_org uuid, p_category "RetentionCategory", p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer;
  v_cutoff timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 0), 0), 5000);
  v_first integer := 0;
  v_second integer := 0;
BEGIN
  SELECT "retain_days" INTO v_days FROM "retention_policies"
    WHERE "organization_id" = p_org AND "category" = p_category AND "action" = 'DELETE_ROWS';
  IF v_days IS NULL OR v_limit = 0 THEN
    RETURN 0;
  END IF;
  v_cutoff := now() - make_interval(days => v_days);

  IF p_category = 'WEBHOOK_DELIVERIES' THEN
    DELETE FROM "jira_webhook_deliveries" WHERE "id" IN (
      SELECT "id" FROM "jira_webhook_deliveries"
       WHERE "organization_id" = p_org AND "status" <> 'RECEIVED' AND "received_at" < v_cutoff
       ORDER BY "received_at" LIMIT v_limit);
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_limit - v_first > 0 THEN
      DELETE FROM "github_webhook_deliveries" WHERE "id" IN (
        SELECT "id" FROM "github_webhook_deliveries"
         WHERE "organization_id" = p_org AND "status" <> 'RECEIVED' AND "received_at" < v_cutoff
         ORDER BY "received_at" LIMIT v_limit - v_first);
      GET DIAGNOSTICS v_second = ROW_COUNT;
    END IF;
  ELSIF p_category = 'SYNC_FAILURES' THEN
    PERFORM set_config('ops.retention_purge', 'on', true);
    DELETE FROM "jira_sync_failures" WHERE "id" IN (
      SELECT "id" FROM "jira_sync_failures"
       WHERE "organization_id" = p_org AND "created_at" < v_cutoff
       ORDER BY "created_at" LIMIT v_limit);
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_limit - v_first > 0 THEN
      DELETE FROM "github_sync_failures" WHERE "id" IN (
        SELECT "id" FROM "github_sync_failures"
         WHERE "organization_id" = p_org AND "created_at" < v_cutoff
         ORDER BY "created_at" LIMIT v_limit - v_first);
      GET DIAGNOSTICS v_second = ROW_COUNT;
    END IF;
    PERFORM set_config('ops.retention_purge', 'off', true);
  END IF;

  RETURN v_first + v_second;
END;
$$;

REVOKE ALL ON FUNCTION "purge_integration_records"(uuid, "RetentionCategory", integer) FROM PUBLIC;

-- Hand-written: least privilege for the runtime role (SECURITY §8). Only direct ticket↔PR links and
-- retention policies are ever deleted by the app; mappings are soft-removed, PR↔Jira links are
-- dismissed, everything else is kept as history (purges go through the function above). Skipped where
-- the role does not exist (deployments with other role names apply equivalent grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "github_sync_failures" FROM ops_app;
    REVOKE DELETE, TRUNCATE ON "github_installations", "github_repositories", "github_repository_mappings",
      "github_pull_requests", "github_pr_jira_links", "github_webhook_deliveries", "github_sync_runs" FROM ops_app;
    REVOKE TRUNCATE ON "support_ticket_github_links", "retention_policies" FROM ops_app;
    GRANT EXECUTE ON FUNCTION "purge_integration_records"(uuid, "RetentionCategory", integer) TO ops_app;
  END IF;
END;
$$;