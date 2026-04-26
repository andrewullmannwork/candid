-- Migration 049: Plan-year integrity audit for claims + billing code outcomes (T3.7)
--
-- After T1.7 (plan year rollover, Session 32), users can have multiple
-- insurance_plans rows (one per year). Claims must reference the plan year
-- they were billed under — not the user's currently-active plan — so that:
--   1. Coverage comparisons use the right year's benefits.
--   2. Dispute letters cite the right year's copay / coinsurance.
--   3. billing_code_plan_outcomes aggregates are scoped per year.
--
-- Denormalizes `plan_year` onto:
--   - `claims` (new column)
--   - `claim_line_items` (new column, inherited from parent claim)
--   - `billing_code_plan_outcomes` (new column — canonical_plan_id is already
--      year-scoped via migration 024's UNIQUE constraint, but an explicit
--      column simplifies scoping queries and resists future canonical refactors)
--
-- Backfill is sourced from `insurance_plans.plan_year` via `insurance_plan_id`.
-- Rows with NULL `insurance_plan_id` (orphaned / anonymous claims) stay NULL
-- and the application layer treats them as "unknown year" (skip year scoping).
--
-- Additive only — NULLable columns, NO DROPs, NO type changes.

-- ── claims.plan_year ────────────────────────────────────────────────────────

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS plan_year INTEGER;

-- Backfill from linked plan. Uses COALESCE for robustness in case plan_year
-- is NULL on some insurance_plans rows (pre-T1.7 imports).

UPDATE claims c
SET plan_year = ip.plan_year
FROM insurance_plans ip
WHERE c.insurance_plan_id = ip.id
  AND c.plan_year IS NULL
  AND ip.plan_year IS NOT NULL;

-- Fallback for claims with no linked plan: derive from date_of_service
-- (best-effort — better than NULL for downstream year-scoping queries).

UPDATE claims
SET plan_year = EXTRACT(YEAR FROM date_of_service)::INTEGER
WHERE plan_year IS NULL
  AND date_of_service IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claims_plan_year
  ON claims(plan_year)
  WHERE plan_year IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claims_plan_id_year
  ON claims(insurance_plan_id, plan_year)
  WHERE insurance_plan_id IS NOT NULL;

COMMENT ON COLUMN claims.plan_year IS
  'Year the claim was billed under. Denormalized from insurance_plans.plan_year at claim creation time (T3.7). Claims must always reference the plan year they were billed under, not the user''s currently-active plan. Fallback to EXTRACT(YEAR FROM date_of_service) if plan link is NULL.';

-- ── claim_line_items.plan_year ──────────────────────────────────────────────
-- Inherited from parent claim at creation time. Redundant with claim_id-join
-- but denormalized for simpler downstream queries in discrepancy-engine and
-- billing-code aggregation.

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS plan_year INTEGER;

UPDATE claim_line_items cli
SET plan_year = c.plan_year
FROM claims c
WHERE cli.claim_id = c.id
  AND cli.plan_year IS NULL
  AND c.plan_year IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_line_items_plan_year
  ON claim_line_items(plan_year)
  WHERE plan_year IS NOT NULL;

COMMENT ON COLUMN claim_line_items.plan_year IS
  'Year the line item was billed under. Inherited from claims.plan_year at creation (T3.7). Lets billing-code intelligence filter outcomes per year without joining claims.';

-- ── billing_code_plan_outcomes.plan_year ────────────────────────────────────
-- canonical_plan_id is already year-scoped (UNIQUE (insurer_id, plan_name,
-- state, plan_year) in migration 024), but an explicit column simplifies
-- aggregation queries and resists future canonical schema changes. The
-- unique constraint on billing_code_plan_outcomes is widened to include
-- plan_year so accidental cross-year rollups are prevented.

ALTER TABLE billing_code_plan_outcomes
  ADD COLUMN IF NOT EXISTS plan_year INTEGER;

UPDATE billing_code_plan_outcomes bcpo
SET plan_year = cp.plan_year
FROM canonical_plans cp
WHERE bcpo.canonical_plan_id = cp.id
  AND bcpo.plan_year IS NULL
  AND cp.plan_year IS NOT NULL;

-- Widen the existing unique constraint to include plan_year. Drop + recreate
-- is safe because the canonical_plan_id is already year-scoped, so adding
-- plan_year to the key doesn't change uniqueness for existing rows.

ALTER TABLE billing_code_plan_outcomes
  DROP CONSTRAINT IF EXISTS billing_code_plan_outcomes_billing_code_billing_code_type_ca_key;

-- Also drop the implicit constraint name used by some psql versions.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'billing_code_plan_outcomes'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%billing_code%billing_code_type%canonical_plan_id%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE billing_code_plan_outcomes DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE billing_code_plan_outcomes
  ADD CONSTRAINT billing_code_plan_outcomes_unique
  UNIQUE (billing_code, billing_code_type, canonical_plan_id, plan_year);

CREATE INDEX IF NOT EXISTS idx_bcpo_plan_year
  ON billing_code_plan_outcomes(canonical_plan_id, plan_year)
  WHERE canonical_plan_id IS NOT NULL;

COMMENT ON COLUMN billing_code_plan_outcomes.plan_year IS
  'Year the outcomes were aggregated for (T3.7). Denormalized from canonical_plans.plan_year. Prevents cross-year aggregation — a code that paid in 2025 may not pay in 2026.';
