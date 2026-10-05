-- Generated with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- against a database at the previous migration, then extended by hand with the statements marked
-- "Hand-written" (not expressible in schema.prisma).
-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACTOR');

-- CreateEnum
CREATE TYPE "AttachmentOwnerType" AS ENUM ('SUPPORT_TICKET', 'SUPPORT_COMMENT', 'REQUEST', 'DAILY_REPORT', 'EMPLOYEE_AVATAR');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'AVAILABLE', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "AttachmentScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- AlterTable
ALTER TABLE "organization_members" ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" CITEXT NOT NULL,
    "parent_department_id" UUID,
    "manager_profile_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_titles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "department_id" UUID,
    "lead_profile_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "employee_number" CITEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "work_email" CITEXT,
    "phone" TEXT,
    "department_id" UUID,
    "job_title_id" UUID,
    "manager_profile_id" UUID,
    "employment_status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "employment_type" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "join_date" DATE,
    "avatar_attachment_id" UUID,
    "time_zone" TEXT,
    "locale" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" CITEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_counters" (
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "organization_counters_pkey" PRIMARY KEY ("organization_id","key")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_type" "AttachmentOwnerType" NOT NULL,
    "owner_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "declared_content_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "content_type" TEXT,
    "size_bytes" INTEGER,
    "checksum_sha256" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "scan_status" "AttachmentScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "rejection_reason" TEXT,
    "uploaded_by_member_id" UUID NOT NULL,
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipient_member_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_organization_id_parent_department_id_idx" ON "departments"("organization_id", "parent_department_id");

-- CreateIndex
CREATE INDEX "departments_organization_id_manager_profile_id_idx" ON "departments"("organization_id", "manager_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_id_key" ON "departments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_code_key" ON "departments"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_organization_id_id_key" ON "job_titles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_organization_id_name_key" ON "job_titles"("organization_id", "name");

-- CreateIndex
CREATE INDEX "teams_organization_id_lead_profile_id_idx" ON "teams"("organization_id", "lead_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_id_key" ON "teams"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_name_key" ON "teams"("organization_id", "name");

-- CreateIndex
CREATE INDEX "team_members_organization_id_profile_id_idx" ON "team_members"("organization_id", "profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_organization_id_id_key" ON "team_members"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_organization_id_team_id_profile_id_key" ON "team_members"("organization_id", "team_id", "profile_id");

-- CreateIndex
CREATE INDEX "employee_profiles_organization_id_department_id_idx" ON "employee_profiles"("organization_id", "department_id");

-- CreateIndex
CREATE INDEX "employee_profiles_organization_id_manager_profile_id_idx" ON "employee_profiles"("organization_id", "manager_profile_id");

-- CreateIndex
CREATE INDEX "employee_profiles_organization_id_employment_status_idx" ON "employee_profiles"("organization_id", "employment_status");

-- CreateIndex
CREATE INDEX "employee_profiles_organization_id_full_name_idx" ON "employee_profiles"("organization_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_organization_id_id_key" ON "employee_profiles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_organization_id_member_id_key" ON "employee_profiles"("organization_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_organization_id_employee_number_key" ON "employee_profiles"("organization_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "member_invitations_token_hash_key" ON "member_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "member_invitations_organization_id_member_id_idx" ON "member_invitations"("organization_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_invitations_organization_id_id_key" ON "member_invitations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_organization_id_owner_type_owner_id_idx" ON "attachments"("organization_id", "owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "attachments_status_upload_expires_at_idx" ON "attachments"("status", "upload_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_organization_id_id_key" ON "attachments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "notifications_organization_id_recipient_member_id_read_at_c_idx" ON "notifications"("organization_id", "recipient_member_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organization_id_id_key" ON "notifications"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organization_id_recipient_member_id_dedupe_ke_key" ON "notifications"("organization_id", "recipient_member_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_events_dispatched_at_available_at_idx" ON "outbox_events"("dispatched_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_organization_id_id_key" ON "outbox_events"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_parent_department_id_fkey" FOREIGN KEY ("organization_id", "parent_department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_manager_profile_id_fkey" FOREIGN KEY ("organization_id", "manager_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_lead_profile_id_fkey" FOREIGN KEY ("organization_id", "lead_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_organization_id_team_id_fkey" FOREIGN KEY ("organization_id", "team_id") REFERENCES "teams"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_job_title_id_fkey" FOREIGN KEY ("organization_id", "job_title_id") REFERENCES "job_titles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_manager_profile_id_fkey" FOREIGN KEY ("organization_id", "manager_profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_organization_id_avatar_attachment_id_fkey" FOREIGN KEY ("organization_id", "avatar_attachment_id") REFERENCES "attachments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "organization_counters" ADD CONSTRAINT "organization_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_uploaded_by_member_id_fkey" FOREIGN KEY ("organization_id", "uploaded_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_recipient_member_id_fkey" FOREIGN KEY ("organization_id", "recipient_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints.
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_identity_check"
  CHECK ("status" = 'INVITED' OR "user_id" IS NOT NULL);
ALTER TABLE "departments" ADD CONSTRAINT "departments_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "departments" ADD CONSTRAINT "departments_code_check" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$');
ALTER TABLE "departments" ADD CONSTRAINT "departments_not_own_parent_check" CHECK ("parent_department_id" <> "id");
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "teams" ADD CONSTRAINT "teams_name_check" CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_not_own_manager_check" CHECK ("manager_profile_id" <> "id");
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_full_name_check" CHECK (length("full_name") BETWEEN 1 AND 200);
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_employee_number_check"
  CHECK ("employee_number" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$');
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('en', 'ar'));
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_contact_length_check"
  CHECK (length("phone") <= 32 AND length("work_email") <= 320 AND length("time_zone") <= 64);
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_acceptance_check"
  CHECK (("accepted_at" IS NULL) = ("accepted_by_user_id" IS NULL));
ALTER TABLE "organization_counters" ADD CONSTRAINT "organization_counters_key_check" CHECK ("key" ~ '^[A-Z]{2,8}$');
ALTER TABLE "organization_counters" ADD CONSTRAINT "organization_counters_value_check" CHECK ("value" >= 0);
-- The storage key always lives under the owning organization's prefix (SECURITY §6).
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_key_check"
  CHECK (left("storage_key", 41) = 'org/' || "organization_id"::text || '/' AND length("storage_key") <= 200);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_size_check"
  CHECK ("declared_size_bytes" > 0 AND ("size_bytes" IS NULL OR "size_bytes" > 0));
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_checksum_check"
  CHECK ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_filename_check" CHECK (length("original_filename") BETWEEN 1 AND 255);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_available_check"
  CHECK ("status" <> 'AVAILABLE' OR ("content_type" IS NOT NULL AND "size_bytes" IS NOT NULL AND "checksum_sha256" IS NOT NULL));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("type" ~ '^[A-Z][A-Z0-9_]{1,63}$');
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dedupe_key_check" CHECK (length("dedupe_key") BETWEEN 1 AND 200);
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_event_type_check" CHECK ("event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$');
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempts_check" CHECK ("attempts" >= 0);