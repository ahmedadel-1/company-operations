-- Phase 10 (ADR-0026): a requirement without document history may be removed while the bid is being
-- prepared (TenderRequirementService.delete); one with links is marked NOT_APPLICABLE instead and the
-- links keep it in place through their RESTRICT foreign key. 20261010090100_commercial revoked DELETE
-- on tender_requirements from the runtime role together with the never-deleted tables, which made that
-- removal fail in production. Privilege-only and additive: no schema or row changes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    GRANT DELETE ON "tender_requirements" TO ops_app;
  END IF;
END;
$$;
