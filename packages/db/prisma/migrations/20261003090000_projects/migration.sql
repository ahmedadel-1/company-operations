-- Phase 2 (Projects): customers, projects, project members, work locations, project locations,
-- daily reports and the project activity read model.
-- Generated with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- against a database at the previous migration, then extended by hand with the statements marked
-- "Hand-written" (not expressible in schema.prisma).
-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('GOVERNMENT', 'PRIVATE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectHealth" AS ENUM ('HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('PROJECT_MANAGER', 'TECHNICAL_MANAGER', 'DEVELOPER', 'SUPPORT', 'FIELD', 'QA', 'OBSERVER');

-- CreateEnum
CREATE TYPE "WorkLocationType" AS ENUM ('OFFICE', 'CUSTOMER_SITE', 'PROJECT_SITE', 'OTHER');

-- CreateEnum
CREATE TYPE "DailyReportStatus" AS ENUM ('NORMAL', 'DEGRADED', 'ISSUE', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ProjectActivitySource" AS ENUM ('SUPPORT', 'JIRA', 'GITHUB', 'DAILY_REPORT', 'PROJECT', 'REQUEST');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "contact_name" TEXT,
    "contact_email" CITEXT,
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "customer_id" UUID,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMPTZ(6),
    "health" "ProjectHealth" NOT NULL DEFAULT 'HEALTHY',
    "health_note" TEXT,
    "health_changed_at" TIMESTAMPTZ(6),
    "start_date" DATE,
    "target_end_date" DATE,
    "project_manager_profile_id" UUID,
    "technical_manager_profile_id" UUID,
    "time_zone" TEXT,
    "daily_report_policy" JSONB NOT NULL DEFAULT '{"required": false, "weekdays": [], "dueLocalTime": "18:00", "reporterRoles": ["FIELD"]}',
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "project_role" "ProjectRole" NOT NULL,
    "allocation_percent" SMALLINT,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "added_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "type" "WorkLocationType" NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "allowed_radius_meters" INTEGER NOT NULL,
    "address" TEXT,
    "time_zone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "work_location_id" UUID NOT NULL,
    "added_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "project_id" UUID NOT NULL,
    "reporter_profile_id" UUID NOT NULL,
    "report_date" DATE NOT NULL,
    "system_status" "DailyReportStatus" NOT NULL,
    "work_performed" TEXT NOT NULL,
    "operational_notes" TEXT,
    "customer_notes" TEXT,
    "problems" TEXT,
    "follow_up_required" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_notes" TEXT,
    "processed_requests_count" INTEGER,
    "failed_requests_count" INTEGER,
    "submitted_by_member_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_activity" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "source" "ProjectActivitySource" NOT NULL,
    "type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "summary_params" JSONB NOT NULL DEFAULT '{}',
    "actor_member_id" UUID,
    "source_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_name_key" ON "customers"("organization_id", "name");

-- CreateIndex
CREATE INDEX "projects_organization_id_status_idx" ON "projects"("organization_id", "status");

-- CreateIndex
CREATE INDEX "projects_organization_id_health_idx" ON "projects"("organization_id", "health");

-- CreateIndex
CREATE INDEX "projects_organization_id_customer_id_idx" ON "projects"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "projects_organization_id_project_manager_profile_id_idx" ON "projects"("organization_id", "project_manager_profile_id");

-- CreateIndex
CREATE INDEX "projects_organization_id_technical_manager_profile_id_idx" ON "projects"("organization_id", "technical_manager_profile_id");

-- CreateIndex
CREATE INDEX "projects_organization_id_updated_at_id_idx" ON "projects"("organization_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "projects_organization_id_name_idx" ON "projects"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_id_key" ON "projects"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_code_key" ON "projects"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_number_key" ON "projects"("organization_id", "number");

-- CreateIndex
CREATE INDEX "project_members_organization_id_profile_id_idx" ON "project_members"("organization_id", "profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_organization_id_id_key" ON "project_members"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_organization_id_project_id_profile_id_key" ON "project_members"("organization_id", "project_id", "profile_id");

-- CreateIndex
CREATE INDEX "work_locations_organization_id_active_idx" ON "work_locations"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "work_locations_organization_id_id_key" ON "work_locations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "work_locations_organization_id_name_key" ON "work_locations"("organization_id", "name");

-- CreateIndex
CREATE INDEX "project_locations_organization_id_work_location_id_idx" ON "project_locations"("organization_id", "work_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_locations_organization_id_id_key" ON "project_locations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_locations_organization_id_project_id_work_location__key" ON "project_locations"("organization_id", "project_id", "work_location_id");

-- CreateIndex
CREATE INDEX "daily_reports_organization_id_project_id_report_date_id_idx" ON "daily_reports"("organization_id", "project_id", "report_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "daily_reports_organization_id_reporter_profile_id_report_da_idx" ON "daily_reports"("organization_id", "reporter_profile_id", "report_date" DESC);

-- CreateIndex
CREATE INDEX "daily_reports_organization_id_report_date_idx" ON "daily_reports"("organization_id", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_organization_id_id_key" ON "daily_reports"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_organization_id_number_key" ON "daily_reports"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_organization_id_project_id_reporter_profile_i_key" ON "daily_reports"("organization_id", "project_id", "reporter_profile_id", "report_date");

-- CreateIndex
CREATE INDEX "project_activity_organization_id_project_id_occurred_at_id_idx" ON "project_activity"("organization_id", "project_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_activity_organization_id_id_key" ON "project_activity"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_activity_organization_id_source_event_id_key" ON "project_activity"("organization_id", "source_event_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_project_manager_profile_id_fkey" FOREIGN KEY ("organization_id", "project_manager_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_technical_manager_profile_id_fkey" FOREIGN KEY ("organization_id", "technical_manager_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_added_by_member_id_fkey" FOREIGN KEY ("organization_id", "added_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_organization_id_work_location_id_fkey" FOREIGN KEY ("organization_id", "work_location_id") REFERENCES "work_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_locations" ADD CONSTRAINT "project_locations_organization_id_added_by_member_id_fkey" FOREIGN KEY ("organization_id", "added_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_organization_id_reporter_profile_id_fkey" FOREIGN KEY ("organization_id", "reporter_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_organization_id_submitted_by_member_id_fkey" FOREIGN KEY ("organization_id", "submitted_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints.
ALTER TABLE "customers" ADD CONSTRAINT "customers_name_check" CHECK (length("name") BETWEEN 1 AND 200);
ALTER TABLE "customers" ADD CONSTRAINT "customers_text_lengths_check"
  CHECK (length("contact_name") <= 200 AND length("contact_email") <= 254 AND length("notes") <= 5000);

ALTER TABLE "projects" ADD CONSTRAINT "projects_name_check" CHECK (length("name") BETWEEN 1 AND 200);
ALTER TABLE "projects" ADD CONSTRAINT "projects_code_check" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$');
ALTER TABLE "projects" ADD CONSTRAINT "projects_number_check" CHECK ("number" > 0);
ALTER TABLE "projects" ADD CONSTRAINT "projects_version_check" CHECK ("version" >= 1);
ALTER TABLE "projects" ADD CONSTRAINT "projects_dates_check"
  CHECK ("start_date" IS NULL OR "target_end_date" IS NULL OR "target_end_date" >= "start_date");
ALTER TABLE "projects" ADD CONSTRAINT "projects_text_lengths_check"
  CHECK (length("description") <= 5000 AND length("notes") <= 5000 AND length("status_reason") <= 1000
    AND length("health_note") <= 1000 AND length("time_zone") <= 64);
ALTER TABLE "projects" ADD CONSTRAINT "projects_daily_report_policy_check"
  CHECK (jsonb_typeof("daily_report_policy") = 'object');
-- ARCHIVED and archived_at always move together (archive/restore are the only paths).
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_allocation_check"
  CHECK ("allocation_percent" IS NULL OR "allocation_percent" BETWEEN 1 AND 100);
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_dates_check"
  CHECK ("end_date" IS NULL OR "end_date" >= "start_date");

ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_coordinates_check"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_radius_check" CHECK ("allowed_radius_meters" BETWEEN 10 AND 5000);
ALTER TABLE "work_locations" ADD CONSTRAINT "work_locations_text_lengths_check"
  CHECK (length("address") <= 500 AND length("time_zone") <= 64);

ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_number_check" CHECK ("number" > 0);
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_work_performed_check" CHECK (length("work_performed") BETWEEN 1 AND 5000);
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_text_lengths_check"
  CHECK (length("operational_notes") <= 5000 AND length("customer_notes") <= 5000 AND length("problems") <= 5000
    AND length("follow_up_notes") <= 5000);
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_counts_check"
  CHECK (("processed_requests_count" IS NULL OR "processed_requests_count" >= 0)
    AND ("failed_requests_count" IS NULL OR "failed_requests_count" >= 0));

ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type_check" CHECK ("type" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$');
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_entity_type_check" CHECK (length("entity_type") BETWEEN 1 AND 64);
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_summary_params_check"
  CHECK (jsonb_typeof("summary_params") = 'object');
