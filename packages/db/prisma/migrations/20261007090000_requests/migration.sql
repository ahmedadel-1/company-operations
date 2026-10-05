-- CreateEnum
CREATE TYPE "RequestCategory" AS ENUM ('HR', 'IT', 'FINANCE', 'ACCESS', 'OPERATIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkflowVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "WorkflowStepKind" AS ENUM ('APPROVAL', 'FULFILLMENT');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('DIRECT_MANAGER', 'DEPARTMENT_MANAGER', 'TEAM_LEAD', 'PROJECT_MANAGER', 'TECHNICAL_MANAGER', 'ROLE', 'MEMBER');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('ANY_ONE', 'ALL');

-- CreateEnum
CREATE TYPE "AttachmentRequirement" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'IN_FULFILLMENT', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RequestApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RequestEffectKind" AS ENUM ('ATTENDANCE');

-- CreateEnum
CREATE TYPE "RequestEffectMode" AS ENUM ('LEAVE', 'REMOTE', 'BUSINESS_MISSION', 'SHORT_LEAVE');

-- CreateEnum
CREATE TYPE "RequestEffectStatus" AS ENUM ('RECORDED', 'REVOKED');

-- CreateTable
CREATE TABLE "request_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "category" "RequestCategory" NOT NULL,
    "icon" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_by_member_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "request_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_type_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "request_type_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_type_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "request_type_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "WorkflowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "form_schema" JSONB NOT NULL,
    "attachment_requirement" "AttachmentRequirement" NOT NULL DEFAULT 'NONE',
    "max_attachments" SMALLINT NOT NULL DEFAULT 5,
    "effects" JSONB NOT NULL DEFAULT '{}',
    "email_approvers" BOOLEAN NOT NULL DEFAULT true,
    "email_requester" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "published_by_member_id" UUID,
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "step_order" SMALLINT NOT NULL,
    "kind" "WorkflowStepKind" NOT NULL,
    "name" JSONB NOT NULL,
    "mode" "ApprovalMode" NOT NULL DEFAULT 'ANY_ONE',
    "approver_type" "ApproverType",
    "approver_member_id" UUID,
    "approver_role_id" UUID,
    "project_field" TEXT,
    "condition" JSONB,
    "sla_hours" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_instances" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "request_type_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "requester_member_id" UUID NOT NULL,
    "project_id" UUID,
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "form_data" JSONB NOT NULL DEFAULT '{}',
    "route" SMALLINT[] DEFAULT ARRAY[]::SMALLINT[],
    "current_step_order" SMALLINT,
    "starts_on" DATE,
    "ends_on" DATE,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "idempotency_key" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "request_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "step_order" SMALLINT NOT NULL,
    "approver_member_id" UUID NOT NULL,
    "status" "RequestApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_member_id" UUID,
    "delegation_id" UUID,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "reminded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "request_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "delegator_member_id" UUID NOT NULL,
    "delegate_member_id" UUID NOT NULL,
    "request_type_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "created_by_member_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_member_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "actor_member_id" UUID,
    "type" TEXT NOT NULL,
    "step_order" SMALLINT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_effects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" "RequestEffectKind" NOT NULL,
    "mode" "RequestEffectMode" NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "decision_event_id" UUID NOT NULL,
    "status" "RequestEffectStatus" NOT NULL DEFAULT 'RECORDED',
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_event_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "request_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_types_organization_id_active_idx" ON "request_types"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "request_types_organization_id_id_key" ON "request_types"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "request_types_organization_id_key_key" ON "request_types"("organization_id", "key");

-- CreateIndex
CREATE INDEX "request_type_roles_organization_id_role_id_idx" ON "request_type_roles"("organization_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_type_roles_organization_id_id_key" ON "request_type_roles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "request_type_roles_organization_id_request_type_id_role_id_key" ON "request_type_roles"("organization_id", "request_type_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_organization_id_id_key" ON "workflow_definitions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_organization_id_request_type_id_key" ON "workflow_definitions"("organization_id", "request_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_organization_id_id_key" ON "workflow_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_organization_id_definition_id_number_key" ON "workflow_versions"("organization_id", "definition_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_one_draft_key" ON "workflow_versions"("organization_id", "definition_id") WHERE (status = 'DRAFT'::"WorkflowVersionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_one_published_key" ON "workflow_versions"("organization_id", "definition_id") WHERE (status = 'PUBLISHED'::"WorkflowVersionStatus");

-- CreateIndex
CREATE INDEX "workflow_steps_organization_id_approver_member_id_idx" ON "workflow_steps"("organization_id", "approver_member_id");

-- CreateIndex
CREATE INDEX "workflow_steps_organization_id_approver_role_id_idx" ON "workflow_steps"("organization_id", "approver_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_organization_id_id_key" ON "workflow_steps"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_organization_id_version_id_step_order_key" ON "workflow_steps"("organization_id", "version_id", "step_order");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_requester_member_id_statu_idx" ON "request_instances"("organization_id", "requester_member_id", "status");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_requester_member_id_creat_idx" ON "request_instances"("organization_id", "requester_member_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "request_instances_organization_id_status_submitted_at_idx" ON "request_instances"("organization_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_request_type_id_starts_on_idx" ON "request_instances"("organization_id", "request_type_id", "starts_on", "ends_on");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_workflow_version_id_idx" ON "request_instances"("organization_id", "workflow_version_id");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_project_id_idx" ON "request_instances"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "request_instances_organization_id_created_at_id_idx" ON "request_instances"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "request_instances_organization_id_id_key" ON "request_instances"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "request_instances_organization_id_number_key" ON "request_instances"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "request_instances_organization_id_requester_member_id_idemp_key" ON "request_instances"("organization_id", "requester_member_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "request_approvals_organization_id_approver_member_id_status_idx" ON "request_approvals"("organization_id", "approver_member_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "request_approvals_organization_id_request_id_step_order_idx" ON "request_approvals"("organization_id", "request_id", "step_order");

-- CreateIndex
CREATE INDEX "request_approvals_organization_id_step_id_idx" ON "request_approvals"("organization_id", "step_id");

-- CreateIndex
CREATE INDEX "request_approvals_organization_id_decided_by_member_id_idx" ON "request_approvals"("organization_id", "decided_by_member_id");

-- CreateIndex
CREATE INDEX "request_approvals_organization_id_delegation_id_idx" ON "request_approvals"("organization_id", "delegation_id");

-- CreateIndex
CREATE INDEX "request_approvals_due_idx" ON "request_approvals"("organization_id", "due_at") WHERE (status = 'PENDING'::"RequestApprovalStatus" AND reminded_at IS NULL AND due_at IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "request_approvals_organization_id_id_key" ON "request_approvals"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "request_approvals_organization_id_request_id_step_order_app_key" ON "request_approvals"("organization_id", "request_id", "step_order", "approver_member_id");

-- CreateIndex
CREATE INDEX "approval_delegations_organization_id_delegator_member_id_en_idx" ON "approval_delegations"("organization_id", "delegator_member_id", "ends_at");

-- CreateIndex
CREATE INDEX "approval_delegations_organization_id_delegate_member_id_end_idx" ON "approval_delegations"("organization_id", "delegate_member_id", "ends_at");

-- CreateIndex
CREATE INDEX "approval_delegations_organization_id_request_type_id_idx" ON "approval_delegations"("organization_id", "request_type_id");

-- CreateIndex
CREATE INDEX "approval_delegations_organization_id_created_by_member_id_idx" ON "approval_delegations"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "approval_delegations_organization_id_revoked_by_member_id_idx" ON "approval_delegations"("organization_id", "revoked_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_delegations_organization_id_id_key" ON "approval_delegations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "request_events_organization_id_request_id_created_at_id_idx" ON "request_events"("organization_id", "request_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "request_events_organization_id_actor_member_id_idx" ON "request_events"("organization_id", "actor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_events_organization_id_id_key" ON "request_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "request_effects_organization_id_kind_status_starts_on_idx" ON "request_effects"("organization_id", "kind", "status", "starts_on");

-- CreateIndex
CREATE INDEX "request_effects_organization_id_workflow_version_id_idx" ON "request_effects"("organization_id", "workflow_version_id");

-- CreateIndex
CREATE INDEX "request_effects_organization_id_decision_event_id_idx" ON "request_effects"("organization_id", "decision_event_id");

-- CreateIndex
CREATE INDEX "request_effects_organization_id_revoke_event_id_idx" ON "request_effects"("organization_id", "revoke_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_effects_organization_id_id_key" ON "request_effects"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "request_effects_organization_id_request_id_kind_key" ON "request_effects"("organization_id", "request_id", "kind");

-- AddForeignKey
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_type_roles" ADD CONSTRAINT "request_type_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_type_roles" ADD CONSTRAINT "request_type_roles_organization_id_request_type_id_fkey" FOREIGN KEY ("organization_id", "request_type_id") REFERENCES "request_types"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_type_roles" ADD CONSTRAINT "request_type_roles_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_organization_id_request_type_id_fkey" FOREIGN KEY ("organization_id", "request_type_id") REFERENCES "request_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_definition_id_fkey" FOREIGN KEY ("organization_id", "definition_id") REFERENCES "workflow_definitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_published_by_member_id_fkey" FOREIGN KEY ("organization_id", "published_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_organization_id_approver_member_id_fkey" FOREIGN KEY ("organization_id", "approver_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_organization_id_approver_role_id_fkey" FOREIGN KEY ("organization_id", "approver_role_id") REFERENCES "roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_organization_id_request_type_id_fkey" FOREIGN KEY ("organization_id", "request_type_id") REFERENCES "request_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_organization_id_workflow_version_id_fkey" FOREIGN KEY ("organization_id", "workflow_version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_organization_id_requester_member_id_fkey" FOREIGN KEY ("organization_id", "requester_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_step_id_fkey" FOREIGN KEY ("organization_id", "step_id") REFERENCES "workflow_steps"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_approver_member_id_fkey" FOREIGN KEY ("organization_id", "approver_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_decided_by_member_id_fkey" FOREIGN KEY ("organization_id", "decided_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_organization_id_delegation_id_fkey" FOREIGN KEY ("organization_id", "delegation_id") REFERENCES "approval_delegations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_delegator_member_id_fkey" FOREIGN KEY ("organization_id", "delegator_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_delegate_member_id_fkey" FOREIGN KEY ("organization_id", "delegate_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_request_type_id_fkey" FOREIGN KEY ("organization_id", "request_type_id") REFERENCES "request_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_organization_id_revoked_by_member_id_fkey" FOREIGN KEY ("organization_id", "revoked_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_organization_id_workflow_version_id_fkey" FOREIGN KEY ("organization_id", "workflow_version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_organization_id_decision_event_id_fkey" FOREIGN KEY ("organization_id", "decision_event_id") REFERENCES "request_events"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_organization_id_revoke_event_id_fkey" FOREIGN KEY ("organization_id", "revoke_event_id") REFERENCES "request_events"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain CHECK constraints (ADR-0021).
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,49}$');
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_name_check"
  CHECK (jsonb_typeof("name") = 'object' AND ("description" IS NULL OR jsonb_typeof("description") = 'object'));
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_icon_check" CHECK ("icon" ~ '^[a-z][a-z0-9-]{1,39}$');
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_version_check" CHECK ("version" >= 1);

ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_version_check" CHECK ("version" >= 1);

ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_number_check" CHECK ("number" >= 1 AND "revision" >= 1);
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_form_schema_check"
  CHECK (jsonb_typeof("form_schema") = 'object' AND octet_length("form_schema"::text) <= 65536);
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_effects_check"
  CHECK (jsonb_typeof("effects") = 'object' AND octet_length("effects"::text) <= 4096);
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_attachments_check"
  CHECK ("max_attachments" BETWEEN 0 AND 20 AND ("attachment_requirement" = 'NONE' OR "max_attachments" >= 1));
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_published_check"
  CHECK (("status" = 'DRAFT') = ("published_at" IS NULL) AND ("status" = 'RETIRED') = ("retired_at" IS NOT NULL));

ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_order_check" CHECK ("step_order" BETWEEN 1 AND 20);
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_name_check" CHECK (jsonb_typeof("name") = 'object');
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_condition_check"
  CHECK ("condition" IS NULL OR (jsonb_typeof("condition") = 'object' AND octet_length("condition"::text) <= 8192));
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_sla_check" CHECK ("sla_hours" BETWEEN 1 AND 720);
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_approver_check" CHECK (
  ("kind" = 'APPROVAL') = ("approver_type" IS NOT NULL)
  AND ("approver_type" = 'MEMBER') IS NOT DISTINCT FROM ("approver_member_id" IS NOT NULL)
  AND ("approver_member_id" IS NULL OR "approver_type" = 'MEMBER')
  AND ("approver_role_id" IS NULL OR "approver_type" = 'ROLE')
  AND ("approver_type" IS DISTINCT FROM 'ROLE' OR "approver_role_id" IS NOT NULL)
  AND ("project_field" IS NULL OR "approver_type" IN ('PROJECT_MANAGER', 'TECHNICAL_MANAGER'))
  AND ("approver_type" NOT IN ('PROJECT_MANAGER', 'TECHNICAL_MANAGER') OR "approver_type" IS NULL OR "project_field" IS NOT NULL)
  AND ("kind" = 'APPROVAL' OR ("mode" = 'ANY_ONE' AND "sla_hours" IS NULL))
);

ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_number_check" CHECK ("number" > 0 AND "version" >= 1);
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_form_data_check"
  CHECK (jsonb_typeof("form_data") = 'object' AND octet_length("form_data"::text) <= 32768);
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_cancel_reason_check" CHECK (length("cancel_reason") <= 1000);
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_dates_check" CHECK ("ends_on" >= "starts_on");
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_submitted_check"
  CHECK (("status" = 'DRAFT' AND "submitted_at" IS NULL) OR "status" = 'CANCELLED' OR ("status" NOT IN ('DRAFT', 'CANCELLED') AND "submitted_at" IS NOT NULL));
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_current_step_check"
  CHECK ("status" NOT IN ('PENDING_APPROVAL', 'IN_FULFILLMENT') OR "current_step_order" IS NOT NULL);
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_decided_check"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED', 'IN_FULFILLMENT', 'COMPLETED') OR "decided_at" IS NOT NULL);
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_completed_check" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL));
ALTER TABLE "request_instances" ADD CONSTRAINT "request_instances_cancelled_check" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));

ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_step_order_check" CHECK ("step_order" BETWEEN 1 AND 20);
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_comment_check" CHECK (length("comment") <= 2000);
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_decided_check" CHECK (
  ("status" = 'PENDING') = ("decided_at" IS NULL)
  AND ("status" IN ('APPROVED', 'REJECTED')) = ("decided_by_member_id" IS NOT NULL)
  AND ("delegation_id" IS NULL OR ("decided_by_member_id" IS NOT NULL AND "decided_by_member_id" <> "approver_member_id"))
);

ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_not_self_check" CHECK ("delegator_member_id" <> "delegate_member_id");
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_period_check"
  CHECK ("ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '90 days');
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_reason_check" CHECK (length("reason") <= 500);
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_revoked_check"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_member_id" IS NULL) AND "version" >= 1);

ALTER TABLE "request_events" ADD CONSTRAINT "request_events_type_check" CHECK ("type" ~ '^[A-Z][A-Z_]{1,63}$');
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_metadata_check"
  CHECK (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 8192);

ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_dates_check" CHECK ("ends_on" >= "starts_on");
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_revoked_check"
  CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL AND "revoke_event_id" IS NOT NULL));

-- Hand-written: workflow version immutability (ADR-0021). Applies to every role, including the owner.
-- A PUBLISHED version may only become RETIRED; RETIRED versions never change; only drafts are deleted.
CREATE FUNCTION "guard_workflow_version"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'workflow version % is % and cannot be deleted', OLD."id", OLD."status"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'a draft workflow version cannot be retired' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED'
     AND (to_jsonb(NEW) - 'status' - 'retired_at' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'retired_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workflow version % is % and immutable', OLD."id", OLD."status" USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "workflow_versions_immutable" BEFORE UPDATE OR DELETE ON "workflow_versions"
  FOR EACH ROW EXECUTE FUNCTION "guard_workflow_version"();

-- Steps change only while their version is a DRAFT. A missing parent (cascade from a deleted draft) is allowed.
CREATE FUNCTION "guard_workflow_step"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_status "WorkflowVersionStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO parent_status FROM "workflow_versions"
      WHERE "organization_id" = OLD."organization_id" AND "id" = OLD."version_id";
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'steps of a % workflow version are immutable', parent_status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status" INTO parent_status FROM "workflow_versions"
      WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."version_id";
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'steps of a % workflow version are immutable', parent_status USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "workflow_steps_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "workflow_steps"
  FOR EACH ROW EXECUTE FUNCTION "guard_workflow_step"();

-- A submitted request keeps its pinned version, form data, route, type, requester and number forever,
-- never returns to DRAFT and is never deleted.
CREATE FUNCTION "guard_request_instance"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'requests are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."status" = 'DRAFT'
       OR NEW."workflow_version_id" IS DISTINCT FROM OLD."workflow_version_id"
       OR NEW."form_data" IS DISTINCT FROM OLD."form_data"
       OR NEW."route" IS DISTINCT FROM OLD."route"
       OR NEW."request_type_id" IS DISTINCT FROM OLD."request_type_id"
       OR NEW."requester_member_id" IS DISTINCT FROM OLD."requester_member_id"
       OR NEW."number" IS DISTINCT FROM OLD."number"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
       OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on"
       OR NEW."ends_on" IS DISTINCT FROM OLD."ends_on"
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at") THEN
    RAISE EXCEPTION 'request % is no longer a draft; its submission is immutable', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "request_instances_pinned" BEFORE UPDATE OR DELETE ON "request_instances"
  FOR EACH ROW EXECUTE FUNCTION "guard_request_instance"();

-- A decided or superseded approval never changes; approvals are never deleted.
CREATE FUNCTION "guard_request_approval"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request approvals are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'PENDING'
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."step_id" IS DISTINCT FROM OLD."step_id"
     OR NEW."step_order" IS DISTINCT FROM OLD."step_order"
     OR NEW."approver_member_id" IS DISTINCT FROM OLD."approver_member_id" THEN
    RAISE EXCEPTION 'request approval % is immutable', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "request_approvals_frozen" BEFORE UPDATE OR DELETE ON "request_approvals"
  FOR EACH ROW EXECUTE FUNCTION "guard_request_approval"();

-- An effect may only be revoked once; effects are never deleted.
CREATE FUNCTION "guard_request_effect"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request effects are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'RECORDED' AND NEW."status" = 'REVOKED'
     AND (to_jsonb(NEW) - 'status' - 'revoked_at' - 'revoke_event_id' - 'updated_at')
       = (to_jsonb(OLD) - 'status' - 'revoked_at' - 'revoke_event_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'request effect % is immutable', OLD."id" USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "request_effects_guarded" BEFORE UPDATE OR DELETE ON "request_effects"
  FOR EACH ROW EXECUTE FUNCTION "guard_request_effect"();

-- Hand-written: append-only request history (SECURITY section 8).
CREATE TRIGGER "request_events_append_only" BEFORE UPDATE OR DELETE ON "request_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "request_events_no_truncate" BEFORE TRUNCATE ON "request_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: least privilege for the runtime role (SECURITY section 8). Types, definitions, requests,
-- approvals, delegations and effects are deactivated, cancelled, superseded or revoked, never deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "request_events" FROM ops_app;
    REVOKE DELETE, TRUNCATE ON "request_types", "workflow_definitions", "request_instances", "request_approvals",
      "approval_delegations", "request_effects" FROM ops_app;
    REVOKE TRUNCATE ON "request_type_roles", "workflow_versions", "workflow_steps" FROM ops_app;
  END IF;
END;
$$;
