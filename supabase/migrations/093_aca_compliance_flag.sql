-- Mig 093 — S74.6 D1 — ACA-compliance flag on insurance_plans
--
-- Adds four ACA-compliance columns to insurance_plans so the downstream coverage
-- layer (S74.6 D2) can gate the zero_cost_share_codes registry fallback on whether
-- the plan is ACA-compliant. Haiku extracts these at plan_doc/SBC parse time.
--
-- Columns:
--   is_aca_compliant       BOOLEAN NULL — TRUE/FALSE/NULL (unknown). Default
--                          when Haiku finds no explicit text: TRUE with
--                          basis='unknown' (conservative-for-users; most plans
--                          ARE ACA-compliant since 2010). User can override at
--                          plan-upload confirmation page.
--   aca_compliance_basis   TEXT NULL — one of:
--                            'explicit_attestation'         (doc says "ACA-compliant")
--                            'inferred_marketplace'         (state exchange / healthcare.gov)
--                            'inferred_employer_post_2010'  (employer plan, effective ≥2010, no grandfathered language)
--                            'explicit_grandfathered'       (doc says "grandfathered under ACA")
--                            'unknown'                      (no explicit signal in doc)
--                            'user_override'                (user corrected via upload confirmation page)
--   aca_compliance_source  TEXT NULL — free-text source label (e.g., 'sbc_parser', 'eoc_parser',
--                                    'plan_doc_parser', 'user_override', 'admin')
--   aca_compliance_excerpt TEXT NULL — Pattern P-8 verbatim ≤500 chars from doc supporting basis
--
-- Backout: drop columns. Pre-S74.6 D2 coverage layer ignores is_aca_compliant
-- (registry fallback was reverted at S86 close); downstream code paths read
-- the columns defensively (NULL → no behavior change vs today).

BEGIN;

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS is_aca_compliant BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS aca_compliance_basis TEXT NULL,
  ADD COLUMN IF NOT EXISTS aca_compliance_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS aca_compliance_excerpt TEXT NULL;

-- Basis enum constraint — accept the five Haiku-emittable values + 'user_override' + 'admin_override'.
-- NULL is allowed (pre-S74.6 rows + rows where Haiku didn't extract).
ALTER TABLE insurance_plans
  DROP CONSTRAINT IF EXISTS insurance_plans_aca_compliance_basis_check;
ALTER TABLE insurance_plans
  ADD CONSTRAINT insurance_plans_aca_compliance_basis_check
  CHECK (
    aca_compliance_basis IS NULL OR
    aca_compliance_basis IN (
      'explicit_attestation',
      'inferred_marketplace',
      'inferred_employer_post_2010',
      'explicit_grandfathered',
      'unknown',
      'user_override',
      'admin_override'
    )
  );

-- Partial index for D2 coverage lookups: only ACA-compliant rows are interesting
-- for the registry-fallback path. Most rows will be is_aca_compliant=TRUE so the
-- index keeps the working set small.
CREATE INDEX IF NOT EXISTS idx_insurance_plans_is_aca_compliant
  ON insurance_plans (is_aca_compliant)
  WHERE is_aca_compliant IS NOT NULL;

COMMENT ON COLUMN insurance_plans.is_aca_compliant IS
  'S74.6 D1 — ACA-compliance flag. NULL = unknown (legacy pre-S74.6 rows); TRUE/FALSE = Haiku-extracted or user-override.';
COMMENT ON COLUMN insurance_plans.aca_compliance_basis IS
  'S74.6 D1 — basis enum for is_aca_compliant. See mig 093 header for values.';
COMMENT ON COLUMN insurance_plans.aca_compliance_source IS
  'S74.6 D1 — provenance source label (parser name, user, admin).';
COMMENT ON COLUMN insurance_plans.aca_compliance_excerpt IS
  'S74.6 D1 — Pattern P-8 verbatim ≤500 chars supporting basis. Empty when basis=''unknown''.';

COMMIT;
