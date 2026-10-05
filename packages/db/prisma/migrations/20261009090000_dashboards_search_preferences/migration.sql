-- Phase 8 (ADR-0023): notification preferences, global-search trigram indexes and the
-- "resolved today" index. pg_trgm has been installed since the Phase 1 foundation migration.

-- CreateEnum
CREATE TYPE "NotificationPreferenceChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ACCESS', 'PROJECTS', 'DAILY_REPORTS', 'SUPPORT', 'REQUESTS', 'ATTENDANCE', 'INTEGRATIONS');

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationPreferenceChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organization_id_id_key" ON "notification_preferences"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organization_id_member_id_category_key" ON "notification_preferences"("organization_id", "member_id", "category", "channel");

-- CreateIndex
CREATE INDEX "employee_profiles_full_name_trgm_idx" ON "employee_profiles" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "jira_issues_issue_key_trgm_idx" ON "jira_issues" USING GIN ("issue_key" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "jira_issues_summary_trgm_idx" ON "jira_issues" USING GIN ("summary" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "projects_name_trgm_idx" ON "projects" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "support_tickets_resolved_at_idx" ON "support_tickets"("organization_id", "resolved_at") WHERE (resolved_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "support_tickets_title_trgm_idx" ON "support_tickets" USING GIN ("title" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: locked categories can never be stored as disabled (defense in depth for the
-- service rule in ADR-0023): ACCESS on any channel, INTEGRATIONS in-app.
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_locked_check"
  CHECK (enabled OR NOT (category = 'ACCESS' OR (category = 'INTEGRATIONS' AND channel = 'IN_APP')));

-- Hand-written: least privilege for the runtime role (SECURITY section 8). Preferences are upserted,
-- never deleted. Skipped where the role does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE DELETE, TRUNCATE ON "notification_preferences" FROM ops_app;
  END IF;
END;
$$;
