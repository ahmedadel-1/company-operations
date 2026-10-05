-- Phase 4 (Jira Cloud): connections, project mappings, issue cache, sync runs/failures, webhook
-- registrations/deliveries, ticket links, issue-create reservations, plus the SUPPRESSED
-- notification-delivery status (recipient lost access before the email was sent).
-- Generated with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- against a database at the previous migration, then extended by hand with the statements marked
-- "Hand-written" (not expressible in schema.prisma).
-- CreateEnum
CREATE TYPE "JiraAuthType" AS ENUM ('OAUTH2_3LO');

-- CreateEnum
CREATE TYPE "JiraConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "JiraImportState" AS ENUM ('NOT_STARTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JiraStatusCategory" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "JiraSyncRunType" AS ENUM ('INITIAL_IMPORT', 'RECONCILIATION', 'DEEP_RECONCILIATION', 'MANUAL_RESYNC');

-- CreateEnum
CREATE TYPE "JiraSyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JiraFailureClass" AS ENUM ('RETRYABLE', 'PERMANENT');

-- CreateEnum
CREATE TYPE "JiraWebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "TicketJiraLinkType" AS ENUM ('CAUSED_BY', 'FIX_TRACKED_BY', 'RELATED');

-- CreateEnum
CREATE TYPE "TicketJiraLinkSource" AS ENUM ('LINKED_EXISTING', 'CREATED_FROM_TICKET');

-- CreateEnum
CREATE TYPE "JiraCreateRequestStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'SUPPRESSED';

-- CreateTable
CREATE TABLE "jira_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cloud_id" TEXT NOT NULL,
    "site_url" TEXT NOT NULL,
    "site_name" TEXT NOT NULL,
    "auth_type" "JiraAuthType" NOT NULL DEFAULT 'OAUTH2_3LO',
    "status" "JiraConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "encryption_key_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connected_by_member_id" UUID,
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "webhook_error_code" TEXT,
    "disconnected_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_project_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "jira_project_id" TEXT NOT NULL,
    "jira_project_key" TEXT NOT NULL,
    "jira_project_name" TEXT NOT NULL,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "import_state" "JiraImportState" NOT NULL DEFAULT 'NOT_STARTED',
    "blocked_statuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_full_sync_at" TIMESTAMPTZ(6),
    "last_reconciled_at" TIMESTAMPTZ(6),
    "last_deep_reconciled_at" TIMESTAMPTZ(6),
    "created_by_member_id" UUID,
    "removed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_project_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mapping_id" UUID,
    "jira_issue_id" TEXT NOT NULL,
    "issue_key" TEXT NOT NULL,
    "jira_project_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "issue_type" TEXT NOT NULL,
    "status_name" TEXT NOT NULL,
    "status_category" "JiraStatusCategory" NOT NULL,
    "priority_name" TEXT,
    "assignee_account_id" TEXT,
    "assignee_display_name" TEXT,
    "reporter_display_name" TEXT,
    "jira_created_at" TIMESTAMPTZ(6) NOT NULL,
    "jira_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "due_date" DATE,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parent_issue_id" TEXT,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "sync_hash" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_in_jira_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_sync_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mapping_id" UUID NOT NULL,
    "type" "JiraSyncRunType" NOT NULL,
    "status" "JiraSyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_member_id" UUID,
    "request_id" TEXT,
    "job_id" TEXT,
    "resumed_from_run_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "records_estimated" INTEGER,
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

    CONSTRAINT "jira_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_sync_failures" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "jira_issue_id" TEXT,
    "error_code" TEXT NOT NULL,
    "classification" "JiraFailureClass" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_sync_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_webhook_registrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "jira_webhook_id" TEXT NOT NULL,
    "jql_filter" TEXT NOT NULL,
    "events" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_refreshed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_webhook_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "jira_issue_id" TEXT,
    "jira_project_id" TEXT,
    "webhook_timestamp" TIMESTAMPTZ(6),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "status" "JiraWebhookDeliveryStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" TEXT,
    "error_code" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_jira_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "link_type" "TicketJiraLinkType" NOT NULL,
    "created_via" "TicketJiraLinkSource" NOT NULL,
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_jira_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_issue_create_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "mapping_id" UUID NOT NULL,
    "requested_by_member_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "JiraCreateRequestStatus" NOT NULL DEFAULT 'PENDING',
    "jira_issue_id" TEXT,
    "link_id" UUID,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jira_issue_create_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jira_connections_status_idx" ON "jira_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_organization_id_id_key" ON "jira_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_organization_id_cloud_id_key" ON "jira_connections"("organization_id", "cloud_id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_live_key" ON "jira_connections"("organization_id") WHERE (status <> 'DISCONNECTED'::"JiraConnectionStatus");

-- CreateIndex
CREATE INDEX "jira_project_mappings_organization_id_project_id_idx" ON "jira_project_mappings"("organization_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_project_mappings_organization_id_id_key" ON "jira_project_mappings"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_project_mappings_organization_id_connection_id_jira_pr_key" ON "jira_project_mappings"("organization_id", "connection_id", "jira_project_id");

-- CreateIndex
CREATE INDEX "jira_issues_organization_id_mapping_id_status_category_idx" ON "jira_issues"("organization_id", "mapping_id", "status_category");

-- CreateIndex
CREATE INDEX "jira_issues_organization_id_mapping_id_jira_updated_at_idx" ON "jira_issues"("organization_id", "mapping_id", "jira_updated_at" DESC);

-- CreateIndex
CREATE INDEX "jira_issues_organization_id_connection_id_issue_key_idx" ON "jira_issues"("organization_id", "connection_id", "issue_key");

-- CreateIndex
CREATE UNIQUE INDEX "jira_issues_organization_id_id_key" ON "jira_issues"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_issues_organization_id_connection_id_jira_issue_id_key" ON "jira_issues"("organization_id", "connection_id", "jira_issue_id");

-- CreateIndex
CREATE INDEX "jira_sync_runs_organization_id_created_at_id_idx" ON "jira_sync_runs"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "jira_sync_runs_organization_id_mapping_id_created_at_idx" ON "jira_sync_runs"("organization_id", "mapping_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "jira_sync_runs_status_updated_at_idx" ON "jira_sync_runs"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "jira_sync_runs_organization_id_id_key" ON "jira_sync_runs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_sync_runs_active_key" ON "jira_sync_runs"("organization_id", "mapping_id") WHERE (status = ANY (ARRAY['QUEUED'::"JiraSyncRunStatus", 'RUNNING'::"JiraSyncRunStatus"]));

-- CreateIndex
CREATE INDEX "jira_sync_failures_organization_id_run_id_created_at_idx" ON "jira_sync_failures"("organization_id", "run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jira_sync_failures_organization_id_id_key" ON "jira_sync_failures"("organization_id", "id");

-- CreateIndex
CREATE INDEX "jira_webhook_registrations_expires_at_idx" ON "jira_webhook_registrations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "jira_webhook_registrations_organization_id_id_key" ON "jira_webhook_registrations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_webhook_registrations_organization_id_connection_id_ji_key" ON "jira_webhook_registrations"("organization_id", "connection_id", "jira_webhook_id");

-- CreateIndex
CREATE INDEX "jira_webhook_deliveries_organization_id_status_received_at_idx" ON "jira_webhook_deliveries"("organization_id", "status", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "jira_webhook_deliveries_organization_id_id_key" ON "jira_webhook_deliveries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_webhook_deliveries_organization_id_connection_id_deliv_key" ON "jira_webhook_deliveries"("organization_id", "connection_id", "delivery_key");

-- CreateIndex
CREATE INDEX "support_ticket_jira_links_organization_id_issue_id_idx" ON "support_ticket_jira_links"("organization_id", "issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_jira_links_organization_id_id_key" ON "support_ticket_jira_links"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_jira_links_organization_id_ticket_id_issue_i_key" ON "support_ticket_jira_links"("organization_id", "ticket_id", "issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_issue_create_requests_organization_id_id_key" ON "jira_issue_create_requests"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_issue_create_requests_organization_id_ticket_id_idempo_key" ON "jira_issue_create_requests"("organization_id", "ticket_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_organization_id_connected_by_member_id_fkey" FOREIGN KEY ("organization_id", "connected_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "jira_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "jira_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_organization_id_mapping_id_fkey" FOREIGN KEY ("organization_id", "mapping_id") REFERENCES "jira_project_mappings"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "jira_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_organization_id_mapping_id_fkey" FOREIGN KEY ("organization_id", "mapping_id") REFERENCES "jira_project_mappings"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_organization_id_requested_by_member_id_fkey" FOREIGN KEY ("organization_id", "requested_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_failures" ADD CONSTRAINT "jira_sync_failures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_sync_failures" ADD CONSTRAINT "jira_sync_failures_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "jira_sync_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_webhook_registrations" ADD CONSTRAINT "jira_webhook_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_webhook_registrations" ADD CONSTRAINT "jira_webhook_registrations_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "jira_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_webhook_deliveries" ADD CONSTRAINT "jira_webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_webhook_deliveries" ADD CONSTRAINT "jira_webhook_deliveries_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "jira_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_jira_links" ADD CONSTRAINT "support_ticket_jira_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_jira_links" ADD CONSTRAINT "support_ticket_jira_links_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_jira_links" ADD CONSTRAINT "support_ticket_jira_links_organization_id_issue_id_fkey" FOREIGN KEY ("organization_id", "issue_id") REFERENCES "jira_issues"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_jira_links" ADD CONSTRAINT "support_ticket_jira_links_organization_id_created_by_membe_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_organization_id_mapping_id_fkey" FOREIGN KEY ("organization_id", "mapping_id") REFERENCES "jira_project_mappings"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_organization_id_requested_by_me_fkey" FOREIGN KEY ("organization_id", "requested_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints.
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_text_check"
  CHECK (length("cloud_id") BETWEEN 1 AND 100 AND length("site_name") BETWEEN 1 AND 255
    AND length("site_url") BETWEEN 8 AND 500 AND "site_url" ~ '^https?://');
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_version_check" CHECK ("version" >= 1);
-- Token columns hold cipher envelopes only (never plaintext) and an ACTIVE connection has both tokens.
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_token_format_check"
  CHECK (("access_token_enc" IS NULL OR "access_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.')
    AND ("refresh_token_enc" IS NULL OR "refresh_token_enc" ~ '^v1\.[A-Za-z0-9_-]+\.'));
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_active_tokens_check"
  CHECK ("status" <> 'ACTIVE' OR ("access_token_enc" IS NOT NULL AND "refresh_token_enc" IS NOT NULL
    AND "token_expires_at" IS NOT NULL AND "encryption_key_id" IS NOT NULL));
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_disconnected_check"
  CHECK (("status" = 'DISCONNECTED') = ("disconnected_at" IS NOT NULL));
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_error_code_check"
  CHECK (length("last_error_code") <= 64 AND length("webhook_error_code") <= 64);

ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_text_check"
  CHECK ("jira_project_id" ~ '^[0-9]{1,20}$' AND length("jira_project_key") BETWEEN 1 AND 50
    AND length("jira_project_name") BETWEEN 1 AND 255);
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_version_check" CHECK ("version" >= 1);
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_blocked_check"
  CHECK ("blocked_statuses" IS NOT NULL AND cardinality("blocked_statuses") <= 20);
-- A removed mapping never syncs.
ALTER TABLE "jira_project_mappings" ADD CONSTRAINT "jira_project_mappings_removed_check"
  CHECK ("removed_at" IS NULL OR NOT "sync_enabled");

ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_ids_check"
  CHECK ("jira_issue_id" ~ '^[0-9]{1,20}$' AND "jira_project_id" ~ '^[0-9]{1,20}$'
    AND length("issue_key") BETWEEN 3 AND 64);
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_text_check"
  CHECK (length("summary") <= 1000 AND length("issue_type") <= 255 AND length("status_name") <= 255
    AND length("url") <= 600 AND "labels" IS NOT NULL);

ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_counts_check"
  CHECK ("records_processed" >= 0 AND "records_created" >= 0 AND "records_updated" >= 0
    AND "records_unchanged" >= 0 AND "records_failed" >= 0 AND "pages" >= 0 AND "consecutive_errors" >= 0
    AND ("records_estimated" IS NULL OR "records_estimated" >= 0));
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_cursor_check" CHECK (jsonb_typeof("last_cursor") = 'object');
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_finished_check"
  CHECK (("status" IN ('SUCCEEDED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED')) = ("finished_at" IS NOT NULL));
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_error_check"
  CHECK (length("error_code") <= 64 AND length("error_summary") <= 500);

ALTER TABLE "jira_sync_failures" ADD CONSTRAINT "jira_sync_failures_text_check"
  CHECK (length("error_code") BETWEEN 1 AND 64 AND length("message") BETWEEN 1 AND 500);

ALTER TABLE "jira_webhook_registrations" ADD CONSTRAINT "jira_webhook_registrations_text_check"
  CHECK ("jira_webhook_id" ~ '^[0-9]{1,20}$' AND length("jql_filter") BETWEEN 1 AND 4000
    AND "events" IS NOT NULL AND cardinality("events") BETWEEN 1 AND 20);

ALTER TABLE "jira_webhook_deliveries" ADD CONSTRAINT "jira_webhook_deliveries_text_check"
  CHECK (length("delivery_key") BETWEEN 1 AND 200 AND length("event_type") BETWEEN 1 AND 100
    AND length("outcome") <= 64 AND length("error_code") <= 64 AND "retry_count" >= 0);
ALTER TABLE "jira_webhook_deliveries" ADD CONSTRAINT "jira_webhook_deliveries_payload_check"
  CHECK (jsonb_typeof("payload") = 'object' AND length("payload"::text) <= 4000);

ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_created_check"
  CHECK (("status" = 'CREATED') = ("jira_issue_id" IS NOT NULL));
ALTER TABLE "jira_issue_create_requests" ADD CONSTRAINT "jira_issue_create_requests_text_check"
  CHECK (length("request_hash") = 64 AND length("error_code") <= 64);

-- Hand-written: sync failures are append-only evidence (SECURITY §8).
CREATE TRIGGER "jira_sync_failures_append_only" BEFORE UPDATE OR DELETE ON "jira_sync_failures"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "jira_sync_failures_no_truncate" BEFORE TRUNCATE ON "jira_sync_failures"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: least privilege for the runtime role (SECURITY §8). Only ticket links and webhook
-- registrations are ever deleted; everything else is kept as history. Skipped where the role does not
-- exist (deployments with other role names apply equivalent grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "jira_sync_failures" FROM ops_app;
    REVOKE DELETE, TRUNCATE ON "jira_connections", "jira_project_mappings", "jira_issues", "jira_sync_runs",
      "jira_webhook_deliveries", "jira_issue_create_requests" FROM ops_app;
    REVOKE TRUNCATE ON "jira_webhook_registrations", "support_ticket_jira_links" FROM ops_app;
  END IF;
END;
$$;