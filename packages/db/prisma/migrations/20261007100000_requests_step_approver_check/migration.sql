-- Phase 6 (ADR-0021): FULFILLMENT steps have no approver. The original check compared
-- ("approver_type" = 'MEMBER'), which is NULL for them, with IS NOT DISTINCT FROM and so rejected
-- every fulfillment step. Same rules, NULL-safe.
ALTER TABLE "workflow_steps" DROP CONSTRAINT "workflow_steps_approver_check";
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_approver_check" CHECK (
  ("kind" = 'APPROVAL') = ("approver_type" IS NOT NULL)
  AND (("approver_type" IS NOT DISTINCT FROM 'MEMBER') = ("approver_member_id" IS NOT NULL))
  AND (("approver_type" IS NOT DISTINCT FROM 'ROLE') = ("approver_role_id" IS NOT NULL))
  AND (("approver_type" IS NOT NULL AND "approver_type" IN ('PROJECT_MANAGER', 'TECHNICAL_MANAGER')) = ("project_field" IS NOT NULL))
  AND ("kind" = 'APPROVAL' OR ("mode" = 'ANY_ONE' AND "sla_hours" IS NULL))
);
