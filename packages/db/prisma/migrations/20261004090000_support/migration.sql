-- Phase 3 (Support): taxonomies, business calendars, SLA policies, escalation rules, tickets,
-- ticket events/comments/watchers, SLA events, notification deliveries and projects.support_team_id.
-- Generated with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- against a database at the previous migration, then extended by hand with the statements marked
-- "Hand-written" (not expressible in schema.prisma).
-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('FIELD', 'CUSTOMER_PHONE', 'CUSTOMER_EMAIL', 'MONITORING', 'INTERNAL', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('P1', 'P2', 'P3', 'P4');

-- CreateEnum
CREATE TYPE "TicketImpact" AS ENUM ('SINGLE_USER', 'MULTIPLE_USERS', 'SITE', 'ALL_USERS');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'TRIAGED', 'IN_PROGRESS', 'ESCALATED', 'WAITING_FOR_DEVELOPMENT', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('ON_TRACK', 'AT_RISK', 'BREACHED', 'PAUSED', 'MET');

-- CreateEnum
CREATE TYPE "TicketCommentVisibility" AS ENUM ('PUBLIC_INTERNAL', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "SlaEventKind" AS ENUM ('FIRST_RESPONSE_AT_RISK', 'FIRST_RESPONSE_BREACHED', 'RESOLUTION_AT_RISK', 'RESOLUTION_BREACHED', 'PAUSED', 'RESUMED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "EscalationTrigger" AS ENUM ('RESOLUTION_ELAPSED_PERCENT', 'UNRESOLVED_AFTER_MINUTES', 'FIRST_RESPONSE_BREACHED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "support_team_id" UUID;

-- CreateTable
CREATE TABLE "support_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_components" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "project_id" UUID,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_calendars" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "time_zone" TEXT,
    "working_hours" JSONB NOT NULL,
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "match" JSONB NOT NULL DEFAULT '{}',
    "first_response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "at_risk_threshold_percent" SMALLINT NOT NULL DEFAULT 75,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "business_calendar_id" UUID,
    "pause_statuses" "TicketStatus"[] DEFAULT ARRAY['WAITING_FOR_CUSTOMER']::"TicketStatus"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "sla_policy_id" UUID,
    "match" JSONB NOT NULL DEFAULT '{}',
    "level" SMALLINT NOT NULL,
    "trigger" "EscalationTrigger" NOT NULL,
    "threshold" INTEGER NOT NULL,
    "notify" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "escalation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "project_id" UUID,
    "reporter_member_id" UUID NOT NULL,
    "source" "TicketSource" NOT NULL,
    "category_id" UUID,
    "component_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "TicketSeverity" NOT NULL,
    "priority" "TicketPriority" NOT NULL,
    "impact" "TicketImpact" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "assigned_team_id" UUID,
    "assignee_member_id" UUID,
    "escalation_level" SMALLINT NOT NULL DEFAULT 0,
    "sla_policy_id" UUID,
    "sla_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_response_due_at" TIMESTAMPTZ(6),
    "resolution_due_at" TIMESTAMPTZ(6),
    "first_responded_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "sla_paused_total_seconds" INTEGER NOT NULL DEFAULT 0,
    "sla_paused_since" TIMESTAMPTZ(6),
    "first_response_sla_state" "SlaState",
    "resolution_sla_state" "SlaState",
    "idempotency_key" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "actor_member_id" UUID,
    "type" TEXT NOT NULL,
    "from_value" JSONB,
    "to_value" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_member_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "TicketCommentVisibility" NOT NULL,
    "edited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_watchers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "added_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_watchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "kind" "SlaEventKind" NOT NULL,
    "level" SMALLINT NOT NULL DEFAULT 0,
    "escalation_rule_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_categories_organization_id_id_key" ON "support_categories"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_categories_organization_id_name_key" ON "support_categories"("organization_id", "name");

-- CreateIndex
CREATE INDEX "support_components_organization_id_project_id_idx" ON "support_components"("organization_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_components_organization_id_id_key" ON "support_components"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_components_organization_id_name_key" ON "support_components"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "business_calendars_organization_id_id_key" ON "business_calendars"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_calendars_organization_id_name_key" ON "business_calendars"("organization_id", "name");

-- CreateIndex
CREATE INDEX "sla_policies_organization_id_active_priority_idx" ON "sla_policies"("organization_id", "active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_id_key" ON "sla_policies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_name_key" ON "sla_policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "escalation_rules_organization_id_active_idx" ON "escalation_rules"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_rules_organization_id_id_key" ON "escalation_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_rules_organization_id_name_key" ON "escalation_rules"("organization_id", "name");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_status_severity_idx" ON "support_tickets"("organization_id", "status", "severity");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_project_id_status_idx" ON "support_tickets"("organization_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_assignee_member_id_status_idx" ON "support_tickets"("organization_id", "assignee_member_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_assigned_team_id_status_idx" ON "support_tickets"("organization_id", "assigned_team_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_reporter_member_id_created__idx" ON "support_tickets"("organization_id", "reporter_member_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_created_at_id_idx" ON "support_tickets"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_updated_at_id_idx" ON "support_tickets"("organization_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_category_id_idx" ON "support_tickets"("organization_id", "category_id");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_component_id_idx" ON "support_tickets"("organization_id", "component_id");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_sla_policy_id_idx" ON "support_tickets"("organization_id", "sla_policy_id");

-- CreateIndex
CREATE INDEX "support_tickets_open_resolution_due_idx" ON "support_tickets"("organization_id", "resolution_due_at") WHERE (status NOT IN ('RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED'));

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_organization_id_id_key" ON "support_tickets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_organization_id_number_key" ON "support_tickets"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_organization_id_reporter_member_id_idempote_key" ON "support_tickets"("organization_id", "reporter_member_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "support_ticket_events_organization_id_ticket_id_created_at__idx" ON "support_ticket_events"("organization_id", "ticket_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_events_organization_id_id_key" ON "support_ticket_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "support_ticket_comments_organization_id_ticket_id_created_a_idx" ON "support_ticket_comments"("organization_id", "ticket_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_comments_organization_id_id_key" ON "support_ticket_comments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "support_ticket_watchers_organization_id_member_id_idx" ON "support_ticket_watchers"("organization_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_watchers_organization_id_id_key" ON "support_ticket_watchers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_watchers_organization_id_ticket_id_member_id_key" ON "support_ticket_watchers"("organization_id", "ticket_id", "member_id");

-- CreateIndex
CREATE INDEX "sla_events_organization_id_ticket_id_created_at_idx" ON "sla_events"("organization_id", "ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "sla_events_organization_id_escalation_rule_id_idx" ON "sla_events"("organization_id", "escalation_rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_events_organization_id_id_key" ON "sla_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_events_once_key" ON "sla_events"("organization_id", "ticket_id", "kind", "level") WHERE (kind NOT IN ('PAUSED', 'RESUMED'));

-- CreateIndex
CREATE INDEX "notification_deliveries_organization_id_status_idx" ON "notification_deliveries"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_organization_id_id_key" ON "notification_deliveries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_organization_id_notification_id_cha_key" ON "notification_deliveries"("organization_id", "notification_id", "channel");

-- CreateIndex
CREATE INDEX "projects_organization_id_support_team_id_idx" ON "projects"("organization_id", "support_team_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_support_team_id_fkey" FOREIGN KEY ("organization_id", "support_team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_components" ADD CONSTRAINT "support_components_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_components" ADD CONSTRAINT "support_components_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_business_calendar_id_fkey" FOREIGN KEY ("organization_id", "business_calendar_id") REFERENCES "business_calendars"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_organization_id_sla_policy_id_fkey" FOREIGN KEY ("organization_id", "sla_policy_id") REFERENCES "sla_policies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_reporter_member_id_fkey" FOREIGN KEY ("organization_id", "reporter_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "support_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_component_id_fkey" FOREIGN KEY ("organization_id", "component_id") REFERENCES "support_components"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_assigned_team_id_fkey" FOREIGN KEY ("organization_id", "assigned_team_id") REFERENCES "teams"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_assignee_member_id_fkey" FOREIGN KEY ("organization_id", "assignee_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_sla_policy_id_fkey" FOREIGN KEY ("organization_id", "sla_policy_id") REFERENCES "sla_policies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_comments" ADD CONSTRAINT "support_ticket_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_comments" ADD CONSTRAINT "support_ticket_comments_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_comments" ADD CONSTRAINT "support_ticket_comments_organization_id_author_member_id_fkey" FOREIGN KEY ("organization_id", "author_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_organization_id_added_by_member_id_fkey" FOREIGN KEY ("organization_id", "added_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "support_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_organization_id_escalation_rule_id_fkey" FOREIGN KEY ("organization_id", "escalation_rule_id") REFERENCES "escalation_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_notification_id_fkey" FOREIGN KEY ("organization_id", "notification_id") REFERENCES "notifications"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints.
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_description_check" CHECK (length("description") <= 1000);
ALTER TABLE "support_components" ADD CONSTRAINT "support_components_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "support_components" ADD CONSTRAINT "support_components_description_check" CHECK (length("description") <= 1000);

ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_time_zone_check" CHECK (length("time_zone") <= 64);
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_json_check"
  CHECK (jsonb_typeof("working_hours") = 'array' AND jsonb_typeof("holidays") = 'array');

ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_priority_check" CHECK ("priority" BETWEEN 0 AND 10000);
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_minutes_check"
  CHECK ("first_response_minutes" BETWEEN 1 AND 525600 AND "resolution_minutes" BETWEEN 1 AND 525600
    AND "first_response_minutes" <= "resolution_minutes");
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_threshold_check" CHECK ("at_risk_threshold_percent" BETWEEN 1 AND 99);
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_match_check" CHECK (jsonb_typeof("match") = 'object');
-- Business-hours policies need a calendar; wall-clock policies must not reference one.
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_calendar_check"
  CHECK ("business_hours_only" = ("business_calendar_id" IS NOT NULL));
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_pause_statuses_check"
  CHECK ("pause_statuses" IS NOT NULL
    AND NOT ("pause_statuses" && ARRAY['NEW', 'RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED']::"TicketStatus"[]));

ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_level_check" CHECK ("level" BETWEEN 1 AND 5);
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_threshold_check" CHECK ("threshold" BETWEEN 1 AND 525600);
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_json_check"
  CHECK (jsonb_typeof("match") = 'object' AND jsonb_typeof("notify") = 'object');

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_number_check" CHECK ("number" > 0);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_version_check" CHECK ("version" >= 1);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_title_check" CHECK (length("title") BETWEEN 1 AND 200);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_text_lengths_check"
  CHECK (length("description") BETWEEN 1 AND 10000 AND length("resolution_note") <= 5000);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_escalation_level_check" CHECK ("escalation_level" BETWEEN 0 AND 5);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_paused_check" CHECK ("sla_paused_total_seconds" >= 0);
-- Lifecycle timestamps move with the status (the state machine is the only writer).
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_resolved_check"
  CHECK ("status" NOT IN ('RESOLVED', 'VERIFIED', 'CLOSED') OR ("resolved_at" IS NOT NULL AND "resolution_note" IS NOT NULL));
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_verified_check"
  CHECK ("status" <> 'VERIFIED' OR "verified_at" IS NOT NULL);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_check"
  CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_cancelled_check"
  CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
-- An SLA policy implies both due dates and both clock states; no policy implies none.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_sla_check"
  CHECK (("sla_policy_id" IS NULL) = ("resolution_due_at" IS NULL)
    AND ("sla_policy_id" IS NULL) = ("first_response_due_at" IS NULL)
    AND ("sla_policy_id" IS NULL) = ("resolution_sla_state" IS NULL)
    AND ("sla_policy_id" IS NULL) = ("first_response_sla_state" IS NULL));

ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_type_check" CHECK ("type" ~ '^[A-Z][A-Z_]{1,63}$');
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_metadata_check" CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "support_ticket_comments" ADD CONSTRAINT "support_ticket_comments_body_check" CHECK (length("body") BETWEEN 1 AND 10000);

ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_level_check" CHECK ("level" BETWEEN 0 AND 5);
ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_metadata_check" CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_last_error_check" CHECK (length("last_error") <= 500);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_check"
  CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));

-- Hand-written: append-only ticket and SLA history (SECURITY §8). The trigger function comes from the
-- first migration and applies to every role, including the table owner.
CREATE TRIGGER "support_ticket_events_append_only" BEFORE UPDATE OR DELETE ON "support_ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "support_ticket_events_no_truncate" BEFORE TRUNCATE ON "support_ticket_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "sla_events_append_only" BEFORE UPDATE OR DELETE ON "sla_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "sla_events_no_truncate" BEFORE TRUNCATE ON "sla_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: least privilege for the runtime role (SECURITY §8). Skipped where the role does not
-- exist (deployments with other role names apply equivalent grants).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "support_ticket_events", "sla_events" FROM ops_app;
  END IF;
END;
$$;

