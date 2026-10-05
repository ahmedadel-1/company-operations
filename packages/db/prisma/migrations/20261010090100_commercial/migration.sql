-- Phase 10 tenders, corporate documents and contracts (ADR-0026). Additive only: new tables, indexes
-- and foreign keys; no existing table or column is changed.

-- CreateTable
CREATE TABLE "tenders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "year" SMALLINT NOT NULL,
    "internal_reference" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "customer_id" UUID,
    "counterparty_name" TEXT,
    "related_project_id" UUID,
    "tender_type" "TenderType" NOT NULL,
    "procurement_method" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "submission_deadline_at" TIMESTAMPTZ(6),
    "submission_deadline_time_zone" TEXT,
    "clarification_deadline_at" TIMESTAMPTZ(6),
    "estimated_value" DECIMAL(19,4),
    "currency" CHAR(3),
    "status" "TenderStatus" NOT NULL DEFAULT 'DRAFT',
    "bid_decision" "TenderBidDecision" NOT NULL DEFAULT 'PENDING',
    "owner_member_id" UUID NOT NULL,
    "technical_lead_member_id" UUID,
    "commercial_lead_member_id" UUID,
    "priority" "CommercialPriority" NOT NULL DEFAULT 'MEDIUM',
    "submission_method" "TenderSubmissionMethod",
    "submission_reference" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_member_id" UUID,
    "award_date" DATE,
    "award_value" DECIMAL(19,4),
    "award_currency" CHAR(3),
    "award_reference" TEXT,
    "award_notes" TEXT,
    "loss_reason" "TenderLossReason",
    "winning_company" TEXT,
    "winning_value" DECIMAL(19,4),
    "our_submitted_value" DECIMAL(19,4),
    "debrief_notes" TEXT,
    "lessons_learned" TEXT,
    "cancel_reason" TEXT,
    "requirements_total" INTEGER NOT NULL DEFAULT 0,
    "mandatory_applicable" INTEGER NOT NULL DEFAULT 0,
    "mandatory_approved" INTEGER NOT NULL DEFAULT 0,
    "optional_applicable" INTEGER NOT NULL DEFAULT 0,
    "optional_approved" INTEGER NOT NULL DEFAULT 0,
    "blocked_requirements" INTEGER NOT NULL DEFAULT 0,
    "unassigned_requirements" INTEGER NOT NULL DEFAULT 0,
    "review_round" INTEGER NOT NULL DEFAULT 0,
    "addendum_seq" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_bid_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "decision" "TenderBidDecision" NOT NULL,
    "technical_fit" "BidCriterionValue" NOT NULL,
    "commercial_attractiveness" "BidCriterionValue" NOT NULL,
    "resources_available" "BidCriterionValue" NOT NULL,
    "required_qualifications_available" "BidCriterionValue" NOT NULL,
    "deadline_feasible" "BidCriterionValue" NOT NULL,
    "strategic_customer" "BidCriterionValue" NOT NULL,
    "previous_experience_available" "BidCriterionValue" NOT NULL,
    "commercial_risk" "BidCriterionValue" NOT NULL,
    "technical_risk" "BidCriterionValue" NOT NULL,
    "no_bid_reason" "NoBidReason",
    "comments" TEXT,
    "decided_by_member_id" UUID NOT NULL,
    "tender_version" INTEGER NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "tender_bid_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_requirements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "category" "TenderRequirementCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reference_section" TEXT,
    "owner_member_id" UUID,
    "reviewer_member_id" UUID,
    "due_date" DATE,
    "priority" "CommercialPriority" NOT NULL DEFAULT 'MEDIUM',
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "status" "TenderRequirementStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "notes" TEXT,
    "reviewed_by_member_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "tender_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_requirement_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "corporate_document_version_id" UUID,
    "commercial_document_version_id" UUID,
    "note" TEXT,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by_member_id" UUID,

CONSTRAINT "tender_requirement_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_review_gates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "gate" "TenderReviewGateType" NOT NULL,
    "mode" "TenderReviewMode" NOT NULL,
    "status" "TenderReviewGateStatus" NOT NULL,
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "tender_review_gates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_reviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "reviewer_member_id" UUID NOT NULL,
    "status" "TenderReviewStatus" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "tender_version" INTEGER,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "tender_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_member_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "tender_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_addenda" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "reference" TEXT,
    "summary" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "document_version_id" UUID,
    "previous_deadline_at" TIMESTAMPTZ(6),
    "previous_time_zone" TEXT,
    "new_deadline_at" TIMESTAMPTZ(6),
    "new_time_zone" TEXT,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "tender_addenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_clarifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "reference" TEXT,
    "status" "TenderClarificationStatus" NOT NULL DEFAULT 'OPEN',
    "submitted_at" TIMESTAMPTZ(6),
    "response" TEXT,
    "responded_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "tender_clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tender_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "kind" "TenderSubmissionKind" NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "method" "TenderSubmissionMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_member_id" UUID NOT NULL,
    "evidence_version_id" UUID,
    "corrects_submission_id" UUID,
    "tender_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "tender_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID,
    "contract_id" UUID,
    "category" "CommercialDocumentCategory" NOT NULL,
    "classification" "DocumentClassification" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "commercial_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_document_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "attachment_id" UUID NOT NULL,
    "notes" TEXT,
    "uploaded_by_member_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "commercial_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type" "CorporateDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "document_number" TEXT,
    "owner_member_id" UUID,
    "classification" "DocumentClassification" NOT NULL,
    "status" "CorporateDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "current_expiry_date" DATE,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "corporate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_document_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "attachment_id" UUID NOT NULL,
    "issue_date" DATE,
    "valid_from" DATE,
    "expiry_date" DATE,
    "notes" TEXT,
    "uploaded_by_member_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "corporate_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "year" SMALLINT NOT NULL,
    "internal_reference" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "customer_id" UUID,
    "counterparty_name" TEXT,
    "source_tender_id" UUID,
    "project_id" UUID,
    "contract_type" "ContractType" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "original_value" DECIMAL(19,4) NOT NULL,
    "current_value" DECIMAL(19,4) NOT NULL,
    "signed_date" DATE,
    "effective_date" DATE,
    "start_date" DATE,
    "original_expiry_date" DATE,
    "current_expiry_date" DATE,
    "initial_term_months" INTEGER,
    "renewal_type" "ContractRenewalType" NOT NULL DEFAULT 'NONE',
    "notice_period_days" INTEGER,
    "renewal_decision_date" DATE,
    "renewal_notice_deadline" DATE,
    "owner_member_id" UUID NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "status_reason" TEXT,
    "warranty_start_date" DATE,
    "warranty_end_date" DATE,
    "support_start_date" DATE,
    "support_end_date" DATE,
    "health" "CommercialHealth" NOT NULL DEFAULT 'HEALTHY',
    "health_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "health_evaluated_on" DATE,
    "idempotency_key" UUID,
    "amendment_seq" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_amendments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "ContractAmendmentType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "effective_date" DATE NOT NULL,
    "value_delta" DECIMAL(19,4),
    "currency" CHAR(3),
    "new_expiry_date" DATE,
    "scope_change_summary" TEXT,
    "status" "ContractAmendmentStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_member_id" UUID,
    "rejection_reason" TEXT,
    "activated_at" TIMESTAMPTZ(6),
    "activated_by_member_id" UUID,
    "document_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "contract_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_obligations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "ObligationCategory" NOT NULL,
    "owner_member_id" UUID,
    "reviewer_member_id" UUID,
    "priority" "CommercialPriority" NOT NULL DEFAULT 'MEDIUM',
    "criticality" "ObligationCriticality" NOT NULL DEFAULT 'STANDARD',
    "evidence_required" BOOLEAN NOT NULL DEFAULT false,
    "recurrence" "ObligationRecurrence" NOT NULL DEFAULT 'NONE',
    "due_date" DATE NOT NULL,
    "recurrence_until" DATE,
    "generated_through" DATE,
    "notes" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "contract_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_obligation_occurrences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "obligation_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'UPCOMING',
    "owner_member_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_member_id" UUID,
    "completion_note" TEXT,
    "evidence_version_id" UUID,
    "waived_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "contract_obligation_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_milestones" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "project_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner_member_id" UUID,
    "due_date" DATE NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "approval_required" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_member_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_member_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "contract_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guarantees" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tender_id" UUID,
    "contract_id" UUID,
    "type" "GuaranteeType" NOT NULL,
    "reference_number" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "beneficiary" TEXT,
    "amount" DECIMAL(19,4),
    "currency" CHAR(3),
    "issue_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "release_date" DATE,
    "owner_member_id" UUID,
    "status" "GuaranteeStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "guarantees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_member_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_renewal_actions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "action" "RenewalActionType" NOT NULL,
    "comment" TEXT,
    "new_expiry_date" DATE,
    "document_version_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "contract_version" INTEGER NOT NULL,
    "actor_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "contract_renewal_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_reminders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "threshold_days" INTEGER NOT NULL,
    "due_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "commercial_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_reminder_days" SMALLINT[],
    "contract_reminder_days" SMALLINT[],
    "guarantee_reminder_days" SMALLINT[],
    "obligation_reminder_days" SMALLINT[],
    "tender_reminder_days" SMALLINT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_member_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "commercial_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenders_organization_id_status_idx" ON "tenders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "tenders_organization_id_submission_deadline_at_idx" ON "tenders"("organization_id", "submission_deadline_at");

-- CreateIndex
CREATE INDEX "tenders_organization_id_owner_member_id_idx" ON "tenders"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_technical_lead_member_id_idx" ON "tenders"("organization_id", "technical_lead_member_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_commercial_lead_member_id_idx" ON "tenders"("organization_id", "commercial_lead_member_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_submitted_by_member_id_idx" ON "tenders"("organization_id", "submitted_by_member_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_created_by_member_id_idx" ON "tenders"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_customer_id_idx" ON "tenders"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_related_project_id_idx" ON "tenders"("organization_id", "related_project_id");

-- CreateIndex
CREATE INDEX "tenders_organization_id_updated_at_id_idx" ON "tenders"("organization_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tenders_title_trgm_idx" ON "tenders" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "tenders_organization_id_id_key" ON "tenders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenders_organization_id_number_key" ON "tenders"("organization_id", "number");

-- CreateIndex
CREATE INDEX "tender_bid_decisions_organization_id_tender_id_decided_at_idx" ON "tender_bid_decisions"("organization_id", "tender_id", "decided_at" DESC);

-- CreateIndex
CREATE INDEX "tender_bid_decisions_organization_id_decided_by_member_id_idx" ON "tender_bid_decisions"("organization_id", "decided_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_bid_decisions_organization_id_id_key" ON "tender_bid_decisions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tender_requirements_organization_id_tender_id_status_idx" ON "tender_requirements"("organization_id", "tender_id", "status");

-- CreateIndex
CREATE INDEX "tender_requirements_organization_id_owner_member_id_due_dat_idx" ON "tender_requirements"("organization_id", "owner_member_id", "due_date");

-- CreateIndex
CREATE INDEX "tender_requirements_organization_id_reviewer_member_id_stat_idx" ON "tender_requirements"("organization_id", "reviewer_member_id", "status");

-- CreateIndex
CREATE INDEX "tender_requirements_organization_id_reviewed_by_member_id_idx" ON "tender_requirements"("organization_id", "reviewed_by_member_id");

-- CreateIndex
CREATE INDEX "tender_requirements_organization_id_created_by_member_id_idx" ON "tender_requirements"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_requirements_organization_id_id_key" ON "tender_requirements"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tender_requirement_links_organization_id_requirement_id_idx" ON "tender_requirement_links"("organization_id", "requirement_id");

-- CreateIndex
CREATE INDEX "tender_requirement_links_organization_id_corporate_document_idx" ON "tender_requirement_links"("organization_id", "corporate_document_version_id");

-- CreateIndex
CREATE INDEX "tender_requirement_links_organization_id_commercial_documen_idx" ON "tender_requirement_links"("organization_id", "commercial_document_version_id");

-- CreateIndex
CREATE INDEX "tender_requirement_links_organization_id_created_by_member__idx" ON "tender_requirement_links"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "tender_requirement_links_organization_id_removed_by_member__idx" ON "tender_requirement_links"("organization_id", "removed_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_requirement_links_organization_id_id_key" ON "tender_requirement_links"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_review_gates_organization_id_id_key" ON "tender_review_gates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_review_gates_organization_id_tender_id_round_gate_key" ON "tender_review_gates"("organization_id", "tender_id", "round", "gate");

-- CreateIndex
CREATE INDEX "tender_reviews_organization_id_tender_id_idx" ON "tender_reviews"("organization_id", "tender_id");

-- CreateIndex
CREATE INDEX "tender_reviews_organization_id_reviewer_member_id_status_idx" ON "tender_reviews"("organization_id", "reviewer_member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tender_reviews_organization_id_id_key" ON "tender_reviews"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_reviews_organization_id_gate_id_reviewer_member_id_key" ON "tender_reviews"("organization_id", "gate_id", "reviewer_member_id");

-- CreateIndex
CREATE INDEX "tender_events_organization_id_tender_id_created_at_id_idx" ON "tender_events"("organization_id", "tender_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tender_events_organization_id_actor_member_id_idx" ON "tender_events"("organization_id", "actor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_events_organization_id_id_key" ON "tender_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tender_addenda_organization_id_document_version_id_idx" ON "tender_addenda"("organization_id", "document_version_id");

-- CreateIndex
CREATE INDEX "tender_addenda_organization_id_created_by_member_id_idx" ON "tender_addenda"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_addenda_organization_id_id_key" ON "tender_addenda"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_addenda_organization_id_tender_id_number_key" ON "tender_addenda"("organization_id", "tender_id", "number");

-- CreateIndex
CREATE INDEX "tender_clarifications_organization_id_tender_id_created_at_idx" ON "tender_clarifications"("organization_id", "tender_id", "created_at");

-- CreateIndex
CREATE INDEX "tender_clarifications_organization_id_created_by_member_id_idx" ON "tender_clarifications"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_clarifications_organization_id_id_key" ON "tender_clarifications"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tender_submissions_organization_id_tender_id_created_at_idx" ON "tender_submissions"("organization_id", "tender_id", "created_at");

-- CreateIndex
CREATE INDEX "tender_submissions_organization_id_submitted_by_member_id_idx" ON "tender_submissions"("organization_id", "submitted_by_member_id");

-- CreateIndex
CREATE INDEX "tender_submissions_organization_id_evidence_version_id_idx" ON "tender_submissions"("organization_id", "evidence_version_id");

-- CreateIndex
CREATE INDEX "tender_submissions_organization_id_corrects_submission_id_idx" ON "tender_submissions"("organization_id", "corrects_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_submissions_organization_id_id_key" ON "tender_submissions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tender_submissions_organization_id_tender_id_idempotency_ke_key" ON "tender_submissions"("organization_id", "tender_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "commercial_documents_organization_id_tender_id_category_idx" ON "commercial_documents"("organization_id", "tender_id", "category");

-- CreateIndex
CREATE INDEX "commercial_documents_organization_id_contract_id_category_idx" ON "commercial_documents"("organization_id", "contract_id", "category");

-- CreateIndex
CREATE INDEX "commercial_documents_organization_id_created_by_member_id_idx" ON "commercial_documents"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_documents_organization_id_id_key" ON "commercial_documents"("organization_id", "id");

-- CreateIndex
CREATE INDEX "commercial_document_versions_organization_id_uploaded_by_me_idx" ON "commercial_document_versions"("organization_id", "uploaded_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_document_versions_organization_id_id_key" ON "commercial_document_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_document_versions_organization_id_document_id_ve_key" ON "commercial_document_versions"("organization_id", "document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_document_versions_organization_id_attachment_id_key" ON "commercial_document_versions"("organization_id", "attachment_id");

-- CreateIndex
CREATE INDEX "corporate_documents_organization_id_status_current_expiry_d_idx" ON "corporate_documents"("organization_id", "status", "current_expiry_date");

-- CreateIndex
CREATE INDEX "corporate_documents_organization_id_document_type_idx" ON "corporate_documents"("organization_id", "document_type");

-- CreateIndex
CREATE INDEX "corporate_documents_organization_id_owner_member_id_idx" ON "corporate_documents"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "corporate_documents_organization_id_created_by_member_id_idx" ON "corporate_documents"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "corporate_documents_title_trgm_idx" ON "corporate_documents" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "corporate_documents_organization_id_id_key" ON "corporate_documents"("organization_id", "id");

-- CreateIndex
CREATE INDEX "corporate_document_versions_organization_id_uploaded_by_mem_idx" ON "corporate_document_versions"("organization_id", "uploaded_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_document_versions_organization_id_id_key" ON "corporate_document_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_document_versions_organization_id_document_id_ver_key" ON "corporate_document_versions"("organization_id", "document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_document_versions_organization_id_attachment_id_key" ON "corporate_document_versions"("organization_id", "attachment_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_status_idx" ON "contracts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "contracts_organization_id_health_idx" ON "contracts"("organization_id", "health");

-- CreateIndex
CREATE INDEX "contracts_organization_id_current_expiry_date_idx" ON "contracts"("organization_id", "current_expiry_date");

-- CreateIndex
CREATE INDEX "contracts_organization_id_renewal_notice_deadline_idx" ON "contracts"("organization_id", "renewal_notice_deadline");

-- CreateIndex
CREATE INDEX "contracts_organization_id_owner_member_id_idx" ON "contracts"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_created_by_member_id_idx" ON "contracts"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_customer_id_idx" ON "contracts"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_source_tender_id_idx" ON "contracts"("organization_id", "source_tender_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_project_id_idx" ON "contracts"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "contracts_organization_id_updated_at_id_idx" ON "contracts"("organization_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "contracts_title_trgm_idx" ON "contracts" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "contracts_organization_id_id_key" ON "contracts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_organization_id_number_key" ON "contracts"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_organization_id_idempotency_key_key" ON "contracts"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_contract_id_status_idx" ON "contract_amendments"("organization_id", "contract_id", "status");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_approved_by_member_id_idx" ON "contract_amendments"("organization_id", "approved_by_member_id");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_activated_by_member_id_idx" ON "contract_amendments"("organization_id", "activated_by_member_id");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_created_by_member_id_idx" ON "contract_amendments"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_document_version_id_idx" ON "contract_amendments"("organization_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_amendments_organization_id_id_key" ON "contract_amendments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_amendments_organization_id_contract_id_number_key" ON "contract_amendments"("organization_id", "contract_id", "number");

-- CreateIndex
CREATE INDEX "contract_obligations_organization_id_contract_id_idx" ON "contract_obligations"("organization_id", "contract_id");

-- CreateIndex
CREATE INDEX "contract_obligations_organization_id_recurrence_generated_t_idx" ON "contract_obligations"("organization_id", "recurrence", "generated_through");

-- CreateIndex
CREATE INDEX "contract_obligations_organization_id_owner_member_id_idx" ON "contract_obligations"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "contract_obligations_organization_id_reviewer_member_id_idx" ON "contract_obligations"("organization_id", "reviewer_member_id");

-- CreateIndex
CREATE INDEX "contract_obligations_organization_id_created_by_member_id_idx" ON "contract_obligations"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_obligations_organization_id_id_key" ON "contract_obligations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_obligations_organization_id_id_contract_id_key" ON "contract_obligations"("organization_id", "id", "contract_id");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_contract_id_idx" ON "contract_obligation_occurrences"("organization_id", "contract_id", "due_date");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_status_due__idx" ON "contract_obligation_occurrences"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_owner_membe_idx" ON "contract_obligation_occurrences"("organization_id", "owner_member_id", "due_date");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_obligation__idx" ON "contract_obligation_occurrences"("organization_id", "obligation_id", "contract_id");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_completed_b_idx" ON "contract_obligation_occurrences"("organization_id", "completed_by_member_id");

-- CreateIndex
CREATE INDEX "contract_obligation_occurrences_organization_id_evidence_ve_idx" ON "contract_obligation_occurrences"("organization_id", "evidence_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_obligation_occurrences_organization_id_id_key" ON "contract_obligation_occurrences"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_obligation_occurrences_organization_id_obligation__key" ON "contract_obligation_occurrences"("organization_id", "obligation_id", "due_date");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_contract_id_due_date_idx" ON "contract_milestones"("organization_id", "contract_id", "due_date");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_status_due_date_idx" ON "contract_milestones"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_project_id_idx" ON "contract_milestones"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_owner_member_id_idx" ON "contract_milestones"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_approved_by_member_id_idx" ON "contract_milestones"("organization_id", "approved_by_member_id");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_completed_by_member_id_idx" ON "contract_milestones"("organization_id", "completed_by_member_id");

-- CreateIndex
CREATE INDEX "contract_milestones_organization_id_created_by_member_id_idx" ON "contract_milestones"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_milestones_organization_id_id_key" ON "contract_milestones"("organization_id", "id");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_status_expiry_date_idx" ON "guarantees"("organization_id", "status", "expiry_date");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_tender_id_idx" ON "guarantees"("organization_id", "tender_id");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_contract_id_idx" ON "guarantees"("organization_id", "contract_id");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_owner_member_id_idx" ON "guarantees"("organization_id", "owner_member_id");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_created_by_member_id_idx" ON "guarantees"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE INDEX "guarantees_organization_id_reference_number_idx" ON "guarantees"("organization_id", "reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "guarantees_organization_id_id_key" ON "guarantees"("organization_id", "id");

-- CreateIndex
CREATE INDEX "contract_events_organization_id_contract_id_created_at_id_idx" ON "contract_events"("organization_id", "contract_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "contract_events_organization_id_actor_member_id_idx" ON "contract_events"("organization_id", "actor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_events_organization_id_id_key" ON "contract_events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "contract_renewal_actions_organization_id_contract_id_create_idx" ON "contract_renewal_actions"("organization_id", "contract_id", "created_at");

-- CreateIndex
CREATE INDEX "contract_renewal_actions_organization_id_document_version_i_idx" ON "contract_renewal_actions"("organization_id", "document_version_id");

-- CreateIndex
CREATE INDEX "contract_renewal_actions_organization_id_actor_member_id_idx" ON "contract_renewal_actions"("organization_id", "actor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_renewal_actions_organization_id_id_key" ON "contract_renewal_actions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_renewal_actions_organization_id_contract_id_idempo_key" ON "contract_renewal_actions"("organization_id", "contract_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "commercial_reminders_created_at_idx" ON "commercial_reminders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_reminders_organization_id_id_key" ON "commercial_reminders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_reminders_organization_id_entity_type_entity_id__key" ON "commercial_reminders"("organization_id", "entity_type", "entity_id", "kind", "threshold_days", "due_on");

-- CreateIndex
CREATE INDEX "commercial_settings_organization_id_updated_by_member_id_idx" ON "commercial_settings"("organization_id", "updated_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_settings_organization_id_id_key" ON "commercial_settings"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_settings_organization_id_key" ON "commercial_settings"("organization_id");

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_related_project_id_fkey" FOREIGN KEY ("organization_id", "related_project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_technical_lead_member_id_fkey" FOREIGN KEY ("organization_id", "technical_lead_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_commercial_lead_member_id_fkey" FOREIGN KEY ("organization_id", "commercial_lead_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_submitted_by_member_id_fkey" FOREIGN KEY ("organization_id", "submitted_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_bid_decisions" ADD CONSTRAINT "tender_bid_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_bid_decisions" ADD CONSTRAINT "tender_bid_decisions_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_bid_decisions" ADD CONSTRAINT "tender_bid_decisions_organization_id_decided_by_member_id_fkey" FOREIGN KEY ("organization_id", "decided_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_reviewer_member_id_fkey" FOREIGN KEY ("organization_id", "reviewer_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_reviewed_by_member_id_fkey" FOREIGN KEY ("organization_id", "reviewed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_requirement_id_fkey" FOREIGN KEY ("organization_id", "requirement_id") REFERENCES "tender_requirements"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_corporate_documen_fkey" FOREIGN KEY ("organization_id", "corporate_document_version_id") REFERENCES "corporate_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_commercial_docume_fkey" FOREIGN KEY ("organization_id", "commercial_document_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_created_by_member_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_organization_id_removed_by_member_fkey" FOREIGN KEY ("organization_id", "removed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_review_gates" ADD CONSTRAINT "tender_review_gates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_review_gates" ADD CONSTRAINT "tender_review_gates_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_organization_id_gate_id_fkey" FOREIGN KEY ("organization_id", "gate_id") REFERENCES "tender_review_gates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_organization_id_reviewer_member_id_fkey" FOREIGN KEY ("organization_id", "reviewer_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_events" ADD CONSTRAINT "tender_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_events" ADD CONSTRAINT "tender_events_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_events" ADD CONSTRAINT "tender_events_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_organization_id_document_version_id_fkey" FOREIGN KEY ("organization_id", "document_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_clarifications" ADD CONSTRAINT "tender_clarifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_clarifications" ADD CONSTRAINT "tender_clarifications_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_clarifications" ADD CONSTRAINT "tender_clarifications_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_organization_id_submitted_by_member_id_fkey" FOREIGN KEY ("organization_id", "submitted_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_organization_id_evidence_version_id_fkey" FOREIGN KEY ("organization_id", "evidence_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_organization_id_corrects_submission_id_fkey" FOREIGN KEY ("organization_id", "corrects_submission_id") REFERENCES "tender_submissions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_document_versions" ADD CONSTRAINT "commercial_document_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_document_versions" ADD CONSTRAINT "commercial_document_versions_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "commercial_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_document_versions" ADD CONSTRAINT "commercial_document_versions_organization_id_attachment_id_fkey" FOREIGN KEY ("organization_id", "attachment_id") REFERENCES "attachments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_document_versions" ADD CONSTRAINT "commercial_document_versions_organization_id_uploaded_by_m_fkey" FOREIGN KEY ("organization_id", "uploaded_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_document_versions" ADD CONSTRAINT "corporate_document_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_document_versions" ADD CONSTRAINT "corporate_document_versions_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "corporate_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_document_versions" ADD CONSTRAINT "corporate_document_versions_organization_id_attachment_id_fkey" FOREIGN KEY ("organization_id", "attachment_id") REFERENCES "attachments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "corporate_document_versions" ADD CONSTRAINT "corporate_document_versions_organization_id_uploaded_by_me_fkey" FOREIGN KEY ("organization_id", "uploaded_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_source_tender_id_fkey" FOREIGN KEY ("organization_id", "source_tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_approved_by_member_id_fkey" FOREIGN KEY ("organization_id", "approved_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_activated_by_member_id_fkey" FOREIGN KEY ("organization_id", "activated_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_document_version_id_fkey" FOREIGN KEY ("organization_id", "document_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_organization_id_reviewer_member_id_fkey" FOREIGN KEY ("organization_id", "reviewer_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_obligation_fkey" FOREIGN KEY ("organization_id", "obligation_id", "contract_id") REFERENCES "contract_obligations"("organization_id", "id", "contract_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_contract_i_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_owner_memb_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_completed__fkey" FOREIGN KEY ("organization_id", "completed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_organization_id_evidence_v_fkey" FOREIGN KEY ("organization_id", "evidence_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_approved_by_member_id_fkey" FOREIGN KEY ("organization_id", "approved_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_completed_by_member_id_fkey" FOREIGN KEY ("organization_id", "completed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_organization_id_tender_id_fkey" FOREIGN KEY ("organization_id", "tender_id") REFERENCES "tenders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_organization_id_owner_member_id_fkey" FOREIGN KEY ("organization_id", "owner_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_organization_id_created_by_member_id_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_renewal_actions" ADD CONSTRAINT "contract_renewal_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_renewal_actions" ADD CONSTRAINT "contract_renewal_actions_organization_id_contract_id_fkey" FOREIGN KEY ("organization_id", "contract_id") REFERENCES "contracts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_renewal_actions" ADD CONSTRAINT "contract_renewal_actions_organization_id_document_version__fkey" FOREIGN KEY ("organization_id", "document_version_id") REFERENCES "commercial_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contract_renewal_actions" ADD CONSTRAINT "contract_renewal_actions_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_reminders" ADD CONSTRAINT "commercial_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_settings" ADD CONSTRAINT "commercial_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "commercial_settings" ADD CONSTRAINT "commercial_settings_organization_id_updated_by_member_id_fkey" FOREIGN KEY ("organization_id", "updated_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: domain invariants (ADR-0026). Money is never negative and always carries an ISO 4217
-- currency; a tender deadline instant always carries its IANA zone; every document, link and guarantee
-- has exactly one parent.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_number_check" CHECK ("number" >= 1 AND "year" BETWEEN 2000 AND 2999);
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 300);
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_currency_check" CHECK (
  ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$') AND ("award_currency" IS NULL OR "award_currency" ~ '^[A-Z]{3}$'));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_money_check" CHECK (
  ("estimated_value" IS NULL OR "estimated_value" >= 0) AND ("award_value" IS NULL OR "award_value" >= 0)
  AND ("winning_value" IS NULL OR "winning_value" >= 0) AND ("our_submitted_value" IS NULL OR "our_submitted_value" >= 0)
  AND (("estimated_value" IS NULL AND "winning_value" IS NULL AND "our_submitted_value" IS NULL) OR "currency" IS NOT NULL)
  AND ("award_value" IS NULL OR "award_currency" IS NOT NULL));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_deadline_zone_check" CHECK (
  ("submission_deadline_at" IS NULL) = ("submission_deadline_time_zone" IS NULL)
  AND ("submission_deadline_time_zone" IS NULL
    OR ("submission_deadline_time_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' AND char_length("submission_deadline_time_zone") <= 64)));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_deadline_required_check" CHECK (
  "status" IN ('DRAFT', 'CANCELLED', 'ARCHIVED') OR "submission_deadline_at" IS NOT NULL);
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_clarification_deadline_check" CHECK (
  "clarification_deadline_at" IS NULL OR "submission_deadline_at" IS NULL OR "clarification_deadline_at" <= "submission_deadline_at");
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_outcome_check" CHECK (
  ("status" <> 'AWARDED' OR "award_date" IS NOT NULL)
  AND ("status" <> 'LOST' OR "loss_reason" IS NOT NULL)
  AND ("status" <> 'NO_BID' OR "bid_decision" = 'NO_BID')
  AND ("status" NOT IN ('SUBMITTED', 'CLARIFICATION', 'AWARDED', 'LOST') OR "submitted_at" IS NOT NULL));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_readiness_check" CHECK (
  "requirements_total" >= 0 AND "mandatory_applicable" >= 0 AND "optional_applicable" >= 0
  AND "mandatory_approved" BETWEEN 0 AND "mandatory_applicable" AND "optional_approved" BETWEEN 0 AND "optional_applicable"
  AND "mandatory_applicable" + "optional_applicable" <= "requirements_total"
  AND "blocked_requirements" BETWEEN 0 AND "requirements_total" AND "unassigned_requirements" BETWEEN 0 AND "requirements_total");
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_counters_check" CHECK (
  "review_round" >= 0 AND "addendum_seq" >= 0 AND "version" >= 1);

ALTER TABLE "tender_bid_decisions" ADD CONSTRAINT "tender_bid_decisions_decision_check" CHECK (
  "decision" IN ('BID', 'NO_BID') AND ("decision" <> 'NO_BID' OR "no_bid_reason" IS NOT NULL) AND "tender_version" >= 1);

ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 300);
ALTER TABLE "tender_requirements" ADD CONSTRAINT "tender_requirements_version_check" CHECK ("version" >= 1);

ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_target_check" CHECK (
  num_nonnulls("corporate_document_version_id", "commercial_document_version_id") = 1);
ALTER TABLE "tender_requirement_links" ADD CONSTRAINT "tender_requirement_links_removed_check" CHECK (
  ("removed_at" IS NULL) = ("removed_by_member_id" IS NULL));

ALTER TABLE "tender_review_gates" ADD CONSTRAINT "tender_review_gates_round_check" CHECK ("round" >= 1);
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_decided_check" CHECK (
  "status" IN ('PENDING', 'SUPERSEDED') OR ("decided_at" IS NOT NULL AND "tender_version" IS NOT NULL));

ALTER TABLE "tender_events" ADD CONSTRAINT "tender_events_type_check" CHECK ("type" ~ '^[a-z][a-z_]*(\.[a-z_]+)+$');
ALTER TABLE "tender_events" ADD CONSTRAINT "tender_events_metadata_check" CHECK (
  jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192);

ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_number_check" CHECK ("number" >= 1);
ALTER TABLE "tender_addenda" ADD CONSTRAINT "tender_addenda_deadline_check" CHECK (
  ("new_deadline_at" IS NULL) = ("new_time_zone" IS NULL) AND ("previous_deadline_at" IS NULL) = ("previous_time_zone" IS NULL));

ALTER TABLE "tender_clarifications" ADD CONSTRAINT "tender_clarifications_check" CHECK (
  "version" >= 1 AND ("status" <> 'ANSWERED' OR ("response" IS NOT NULL AND "responded_at" IS NOT NULL)));

ALTER TABLE "tender_submissions" ADD CONSTRAINT "tender_submissions_kind_check" CHECK (
  ("kind" = 'CORRECTION') = ("corrects_submission_id" IS NOT NULL) AND "tender_version" >= 1);

ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_parent_check" CHECK (num_nonnulls("tender_id", "contract_id") = 1);
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 300);
ALTER TABLE "commercial_documents" ADD CONSTRAINT "commercial_documents_version_check" CHECK ("current_version" >= 0 AND "version" >= 1);
ALTER TABLE "commercial_document_versions" ADD CONSTRAINT "commercial_document_versions_number_check" CHECK ("version_number" >= 1);

ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 300);
ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_archive_check" CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));
ALTER TABLE "corporate_documents" ADD CONSTRAINT "corporate_documents_version_check" CHECK ("current_version" >= 0 AND "version" >= 1);
ALTER TABLE "corporate_document_versions" ADD CONSTRAINT "corporate_document_versions_dates_check" CHECK (
  "version_number" >= 1
  AND ("expiry_date" IS NULL OR "issue_date" IS NULL OR "expiry_date" >= "issue_date")
  AND ("expiry_date" IS NULL OR "valid_from" IS NULL OR "expiry_date" >= "valid_from"));

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_number_check" CHECK ("number" >= 1 AND "year" BETWEEN 2000 AND 2999);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 300);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_money_check" CHECK (
  "currency" ~ '^[A-Z]{3}$' AND "original_value" >= 0 AND "current_value" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_dates_check" CHECK (
  ("original_expiry_date" IS NULL OR "start_date" IS NULL OR "original_expiry_date" >= "start_date")
  AND ("current_expiry_date" IS NULL OR "start_date" IS NULL OR "current_expiry_date" >= "start_date")
  AND ("warranty_end_date" IS NULL OR "warranty_start_date" IS NULL OR "warranty_end_date" >= "warranty_start_date")
  AND ("support_end_date" IS NULL OR "support_start_date" IS NULL OR "support_end_date" >= "support_start_date"));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_term_check" CHECK (
  ("initial_term_months" IS NULL OR "initial_term_months" BETWEEN 1 AND 1200)
  AND ("notice_period_days" IS NULL OR "notice_period_days" BETWEEN 0 AND 3650));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_counters_check" CHECK ("amendment_seq" >= 0 AND "version" >= 1);

ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_check" CHECK (
  "number" >= 1 AND "version" >= 1 AND char_length(btrim("title")) BETWEEN 1 AND 300
  AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
  AND ("value_delta" IS NULL OR "currency" IS NOT NULL)
  AND ("approved_by_member_id" IS NULL OR "approved_by_member_id" <> "created_by_member_id")
  AND ("status" <> 'EFFECTIVE' OR "activated_at" IS NOT NULL));

ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_check" CHECK (
  "version" >= 1 AND char_length(btrim("title")) BETWEEN 1 AND 300
  AND ("recurrence_until" IS NULL OR "recurrence_until" >= "due_date")
  AND ("recurrence" <> 'NONE' OR "recurrence_until" IS NULL));
ALTER TABLE "contract_obligation_occurrences" ADD CONSTRAINT "contract_obligation_occurrences_check" CHECK (
  "version" >= 1
  AND ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL)
  AND ("status" <> 'WAIVED' OR "waived_reason" IS NOT NULL));

ALTER TABLE "contract_milestones" ADD CONSTRAINT "contract_milestones_check" CHECK (
  "version" >= 1 AND char_length(btrim("title")) BETWEEN 1 AND 300
  AND ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL));

ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_parent_check" CHECK (num_nonnulls("tender_id", "contract_id") = 1);
ALTER TABLE "guarantees" ADD CONSTRAINT "guarantees_check" CHECK (
  "version" >= 1 AND char_length(btrim("reference_number")) BETWEEN 1 AND 120
  AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$')
  AND ("amount" IS NULL OR ("amount" >= 0 AND "currency" IS NOT NULL))
  AND "expiry_date" >= "issue_date"
  AND ("release_date" IS NULL OR "release_date" >= "issue_date")
  AND ("status" <> 'RELEASED' OR "release_date" IS NOT NULL));

ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_type_check" CHECK ("type" ~ '^[a-z][a-z_]*(\.[a-z_]+)+$');
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_metadata_check" CHECK (
  jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192);

ALTER TABLE "contract_renewal_actions" ADD CONSTRAINT "contract_renewal_actions_check" CHECK (
  "contract_version" >= 1 AND ("action" NOT IN ('RENEWED', 'EXTENDED') OR "new_expiry_date" IS NOT NULL));

ALTER TABLE "commercial_reminders" ADD CONSTRAINT "commercial_reminders_check" CHECK (
  "entity_type" ~ '^[A-Z][A-Z_]{1,39}$' AND "kind" ~ '^[A-Z][A-Z_]{1,39}$' AND "threshold_days" BETWEEN 0 AND 3650);

ALTER TABLE "commercial_settings" ADD CONSTRAINT "commercial_settings_days_check" CHECK (
  "version" >= 1
  AND coalesce(cardinality("document_reminder_days"), 0) <= 10 AND 0 <= ALL ("document_reminder_days") AND 3650 >= ALL ("document_reminder_days")
  AND coalesce(cardinality("contract_reminder_days"), 0) <= 10 AND 0 <= ALL ("contract_reminder_days") AND 3650 >= ALL ("contract_reminder_days")
  AND coalesce(cardinality("guarantee_reminder_days"), 0) <= 10 AND 0 <= ALL ("guarantee_reminder_days") AND 3650 >= ALL ("guarantee_reminder_days")
  AND coalesce(cardinality("obligation_reminder_days"), 0) <= 10 AND 0 <= ALL ("obligation_reminder_days") AND 3650 >= ALL ("obligation_reminder_days")
  AND coalesce(cardinality("tender_reminder_days"), 0) <= 10 AND 0 <= ALL ("tender_reminder_days") AND 3650 >= ALL ("tender_reminder_days"));

-- Hand-written: only a draft tender may be hard-deleted (spec section 11); its number never changes.
-- Contracts are never deleted and keep their number, currency, source tender and original value once
-- they leave DRAFT.
CREATE FUNCTION "guard_tender"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'tender % is not a draft and cannot be deleted', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."number" IS DISTINCT FROM OLD."number" OR NEW."year" IS DISTINCT FROM OLD."year" THEN
    RAISE EXCEPTION 'tender % number is immutable', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tenders_guarded" BEFORE UPDATE OR DELETE ON "tenders"
  FOR EACH ROW EXECUTE FUNCTION "guard_tender"();

CREATE FUNCTION "guard_contract"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contracts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."number" IS DISTINCT FROM OLD."number" OR NEW."year" IS DISTINCT FROM OLD."year"
     OR (OLD."status" <> 'DRAFT' AND (NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."original_value" IS DISTINCT FROM OLD."original_value"
       OR NEW."source_tender_id" IS DISTINCT FROM OLD."source_tender_id")) THEN
    RAISE EXCEPTION 'contract % identity, currency and original value are immutable', OLD."id"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "contracts_guarded" BEFORE UPDATE OR DELETE ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION "guard_contract"();

-- Hand-written: append-only commercial history (SECURITY section 8). Document versions, decisions,
-- addenda, submissions, renewal actions and events are corrected by appending, never by editing.
CREATE TRIGGER "tender_bid_decisions_append_only" BEFORE UPDATE OR DELETE ON "tender_bid_decisions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_bid_decisions_no_truncate" BEFORE TRUNCATE ON "tender_bid_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_events_append_only" BEFORE UPDATE OR DELETE ON "tender_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_events_no_truncate" BEFORE TRUNCATE ON "tender_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_addenda_append_only" BEFORE UPDATE OR DELETE ON "tender_addenda"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_addenda_no_truncate" BEFORE TRUNCATE ON "tender_addenda"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_submissions_append_only" BEFORE UPDATE OR DELETE ON "tender_submissions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "tender_submissions_no_truncate" BEFORE TRUNCATE ON "tender_submissions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "commercial_document_versions_append_only" BEFORE UPDATE OR DELETE ON "commercial_document_versions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "commercial_document_versions_no_truncate" BEFORE TRUNCATE ON "commercial_document_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "corporate_document_versions_append_only" BEFORE UPDATE OR DELETE ON "corporate_document_versions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "corporate_document_versions_no_truncate" BEFORE TRUNCATE ON "corporate_document_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "contract_events_append_only" BEFORE UPDATE OR DELETE ON "contract_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "contract_events_no_truncate" BEFORE TRUNCATE ON "contract_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "contract_renewal_actions_append_only" BEFORE UPDATE OR DELETE ON "contract_renewal_actions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "contract_renewal_actions_no_truncate" BEFORE TRUNCATE ON "contract_renewal_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: least privilege for the runtime role (SECURITY section 8). Commercial records are
-- archived, cancelled, superseded or soft-removed, never deleted; the one exception is a draft tender
-- (guarded above).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "tender_bid_decisions", "tender_events", "tender_addenda", "tender_submissions",
      "commercial_document_versions", "corporate_document_versions", "contract_events", "contract_renewal_actions",
      "commercial_reminders" FROM ops_app;
    REVOKE DELETE, TRUNCATE ON "tender_requirements", "tender_requirement_links", "tender_review_gates", "tender_reviews",
      "tender_clarifications", "commercial_documents", "corporate_documents", "contracts", "contract_amendments",
      "contract_obligations", "contract_obligation_occurrences", "contract_milestones", "guarantees",
      "commercial_settings" FROM ops_app;
    REVOKE TRUNCATE ON "tenders" FROM ops_app;
  END IF;
END;
$$;

-- Hand-written: give existing organizations' system roles the Phase 10 baseline grants (SECURITY section
-- 2.5). materializeSystemRoles only creates missing roles, so without this an upgraded organization would
-- have no commercial access at all. Only these new permission keys are inserted; existing grants are
-- untouched. Must stay equal to the Phase 10 rows of SYSTEM_ROLE_TEMPLATES (commercial-roles test).
WITH "baseline" ("role_key", "permission_key", "scope") AS (
  VALUES
    ('ORG_ADMIN', 'tender.view', 'ORG'),
    ('ORG_ADMIN', 'contract.view', 'ORG'),
    ('ORG_ADMIN', 'corporate_document.view', 'ORG'),
    ('ORG_ADMIN', 'corporate_document.manage', 'ORG'),
    ('GENERAL_MANAGER', 'tender.view', 'ORG'),
    ('GENERAL_MANAGER', 'tender.create', 'ORG'),
    ('GENERAL_MANAGER', 'tender.edit', 'ORG'),
    ('GENERAL_MANAGER', 'tender.delete_draft', 'ORG'),
    ('GENERAL_MANAGER', 'tender.manage_requirements', 'ORG'),
    ('GENERAL_MANAGER', 'tender.review', 'SELF'),
    ('GENERAL_MANAGER', 'tender.approve', 'ORG'),
    ('GENERAL_MANAGER', 'tender.submit', 'ORG'),
    ('GENERAL_MANAGER', 'tender.record_award', 'ORG'),
    ('GENERAL_MANAGER', 'tender.record_loss', 'ORG'),
    ('GENERAL_MANAGER', 'tender.financial.view', 'ORG'),
    ('GENERAL_MANAGER', 'contract.view', 'ORG'),
    ('GENERAL_MANAGER', 'contract.create', 'ORG'),
    ('GENERAL_MANAGER', 'contract.edit', 'ORG'),
    ('GENERAL_MANAGER', 'contract.approve', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_documents', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_obligations', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_milestones', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_guarantees', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_amendments', 'ORG'),
    ('GENERAL_MANAGER', 'contract.manage_renewal', 'ORG'),
    ('GENERAL_MANAGER', 'contract.financial.view', 'ORG'),
    ('GENERAL_MANAGER', 'corporate_document.view', 'ORG'),
    ('GENERAL_MANAGER', 'corporate_document.manage', 'ORG'),
    ('GENERAL_MANAGER', 'corporate_document.restricted.view', 'ORG'),
    ('GENERAL_MANAGER', 'commercial_document.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.create', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.edit', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.delete_draft', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.manage_requirements', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.review', 'SELF'),
    ('TECHNICAL_MANAGER', 'tender.approve', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.submit', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.record_award', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.record_loss', 'ORG'),
    ('TECHNICAL_MANAGER', 'tender.financial.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.create', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.edit', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_documents', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_obligations', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_milestones', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_guarantees', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_amendments', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.manage_renewal', 'ORG'),
    ('TECHNICAL_MANAGER', 'contract.financial.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'corporate_document.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'corporate_document.manage', 'ORG'),
    ('TECHNICAL_MANAGER', 'corporate_document.restricted.view', 'ORG'),
    ('TECHNICAL_MANAGER', 'commercial_document.view', 'ORG'),
    ('DEPARTMENT_MANAGER', 'tender.view', 'SELF'),
    ('DEPARTMENT_MANAGER', 'tender.edit', 'SELF'),
    ('DEPARTMENT_MANAGER', 'tender.manage_requirements', 'SELF'),
    ('DEPARTMENT_MANAGER', 'tender.review', 'SELF'),
    ('DEPARTMENT_MANAGER', 'tender.submit', 'SELF'),
    ('DEPARTMENT_MANAGER', 'corporate_document.view', 'ORG'),
    ('PROJECT_MANAGER', 'tender.view', 'PROJECT'),
    ('PROJECT_MANAGER', 'tender.create', 'PROJECT'),
    ('PROJECT_MANAGER', 'tender.edit', 'PROJECT'),
    ('PROJECT_MANAGER', 'tender.delete_draft', 'PROJECT'),
    ('PROJECT_MANAGER', 'tender.manage_requirements', 'PROJECT'),
    ('PROJECT_MANAGER', 'tender.review', 'SELF'),
    ('PROJECT_MANAGER', 'tender.submit', 'PROJECT'),
    ('PROJECT_MANAGER', 'contract.view', 'PROJECT'),
    ('PROJECT_MANAGER', 'contract.manage_documents', 'PROJECT'),
    ('PROJECT_MANAGER', 'contract.manage_obligations', 'PROJECT'),
    ('PROJECT_MANAGER', 'contract.manage_milestones', 'PROJECT'),
    ('PROJECT_MANAGER', 'corporate_document.view', 'ORG'),
    ('TEAM_LEAD', 'tender.review', 'SELF'),
    ('TEAM_LEAD', 'corporate_document.view', 'ORG'),
    ('HR_ADMIN', 'corporate_document.view', 'ORG'),
    ('HR_ADMIN', 'corporate_document.manage', 'ORG')
), "inserted" AS (
  INSERT INTO "role_permissions" ("id", "organization_id", "role_id", "permission_key", "scope")
  SELECT gen_random_uuid(), r."organization_id", r."id", b."permission_key", b."scope"::"PermissionScope"
  FROM "baseline" b
  JOIN "roles" r ON r."is_system" AND r."template_key" = b."role_key"
  ON CONFLICT DO NOTHING
  RETURNING "organization_id", "role_id"
)
UPDATE "organization_members" m SET "authz_version" = m."authz_version" + 1
WHERE EXISTS (
  SELECT 1 FROM "member_roles" mr JOIN "inserted" i ON i."organization_id" = mr."organization_id" AND i."role_id" = mr."role_id"
  WHERE mr."organization_id" = m."organization_id" AND mr."member_id" = m."id");
