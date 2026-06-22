-- F.0 Phase 1 — one-time backfill for canonical_plan_services (mig 165 aligned columns).
-- Run AFTER mig 165 applies (the aligned columns must exist). IDEMPOTENT: re-running
-- overwrites the aligned columns + in_ provenance twins with identical values.
--
-- Two INDEPENDENT operations (typed and provenance are NOT 1:1 — verified S207:
-- requires_prior_auth has 42,194 rows typed-but-no-provenance from its DEFAULT false):
--   (1) typed copy   — every row (NULL-preserving)
--   (2) provenance   — add the in_ twin ONLY where the legacy key exists
--
-- This is the same mirror the align_dualwrite trigger applies to new writes; running it
-- explicitly here is auditable and works whether or not the trigger is present.
--
-- Source of truth for the fixture (ephemeral-PG) AND the PROD Studio run.

UPDATE canonical_plan_services SET
  in_copay = copay,
  in_coinsurance = coinsurance,
  in_deductible_applies = deductible_applies,
  covered = is_covered,
  prior_auth_required = requires_prior_auth,
  field_provenance = field_provenance
    || (CASE WHEN field_provenance ? 'copay'               THEN jsonb_build_object('in_copay',              field_provenance->'copay')               ELSE '{}'::jsonb END)
    || (CASE WHEN field_provenance ? 'coinsurance'         THEN jsonb_build_object('in_coinsurance',        field_provenance->'coinsurance')         ELSE '{}'::jsonb END)
    || (CASE WHEN field_provenance ? 'deductible_applies'  THEN jsonb_build_object('in_deductible_applies', field_provenance->'deductible_applies')  ELSE '{}'::jsonb END)
    || (CASE WHEN field_provenance ? 'is_covered'          THEN jsonb_build_object('covered',               field_provenance->'is_covered')          ELSE '{}'::jsonb END)
    || (CASE WHEN field_provenance ? 'requires_prior_auth' THEN jsonb_build_object('prior_auth_required',   field_provenance->'requires_prior_auth') ELSE '{}'::jsonb END);
