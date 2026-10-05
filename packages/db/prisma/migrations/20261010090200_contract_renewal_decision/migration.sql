-- Phase 10 (ADR-0026): renewal decision of the contract's current term, maintained with the renewal
-- actions (the append-only history stays in contract_renewal_actions). Additive and nullable: no
-- existing row changes.
ALTER TABLE "contracts" ADD COLUMN "renewal_decision" "RenewalActionType";
ALTER TABLE "contracts" ADD COLUMN "renewal_decided_at" TIMESTAMPTZ(6);

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewal_decision_check"
  CHECK ("renewal_decision" IS NULL OR "renewal_decision" IN ('RENEW', 'DO_NOT_RENEW'));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewal_decided_check"
  CHECK (("renewal_decision" IS NULL) = ("renewal_decided_at" IS NULL));
