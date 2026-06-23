-- =============================================================================
-- MIGRATION 171 — Dispute plan pinning (Mid-Year Plan Change × Disputes, P0)
-- =============================================================================
--
-- Adds the schema substrate for pinning each dispute to the specific insurance
-- plan it was written against, plus the approximate change-date signal the
-- plan-change banner needs, plus the feature flag that gates the whole feature.
-- ALL ADDITIVE (Pattern 1 / Rule 7): two new nullable columns + one index + one
-- flag-seed row. Nothing reads any of this until later phases; the flag is OFF,
-- so flag-OFF behavior is byte-identical to today.
--
-- WHAT IT ADDS:
--   1. dispute_outcomes.insurance_plan_id  — the "pin": the insurance_plans row
--      this dispute was written against (the plan in effect at the service
--      date). Set at draft from claims.insurance_plan_id (already DOS-correct)
--      or from the user's confirm/override chooser. Honored FIRST during plan
--      resolution (before DOS-window / plan_year / active fallbacks) so changing
--      the user's active plan never silently rewrites an existing dispute.
--      FK ON DELETE SET NULL so CHD erasure (OPS.9) can't orphan a dispute — a
--      null pin simply falls back to resolution.
--   2. idx_dispute_outcomes_insurance_plan_id — powers the plan-change cascade
--      query ("which draft disputes are pinned to plan X?") on set-active.
--   3. insurance_plans.activated_at — APPROXIMATE change-date signal. Stamped
--      now() by the plan-activation path (set-active) when a plan becomes the
--      user's active plan. Most-recent-activation only (overwritten on
--      re-activation); NULL = unknown. Used ONLY as the FALLBACK anchor for the
--      banner's old-vs-new recommendation (with a ~30-day buffer) when real
--      coverage_period_* windows are absent. It is NOT a coverage-window
--      boundary and must never be used for plan-year/DOS resolution (that stays
--      coverage_period_start/end — document truth). Kept separate precisely so
--      this approximate value never pollutes plan-year-resolver inputs.
--   4. feature_flag_rules row 'dispute_plan_pinning_v1' (default OFF, global).
--
-- WHAT IT GATES (flag dispute_plan_pinning_v1):
--   The pin write on /api/disputes/generate, the pin-honoring resolver
--   precedence in plan-context, the "which plan were you on?" confirm/override
--   chooser, the plan-change cascade + banner on set-active, and the per-dispute
--   re-bind control. When OFF, all of the above are inert and resolution behaves
--   exactly as today.
--
-- ROLLOUT:
--   1. Apply this migration (additive; safe with flag OFF).
--   2. Deploy code (all new paths gated OFF; no behavior change).
--   3. Flip ON only after the real flag-ON E2E:
--      UPDATE feature_flag_rules SET enabled=true
--      WHERE flag_key='dispute_plan_pinning_v1'.
--
-- ROLLBACK:
--   Flip the flag OFF — every new path goes inert. Columns/index are additive
--   and harmless if left in place; row removal is forbidden per Pattern 1 #10.
-- =============================================================================

-- 1 + 2. The dispute pin + its cascade index ----------------------------------
ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS insurance_plan_id UUID
    REFERENCES insurance_plans(id) ON DELETE SET NULL;

COMMENT ON COLUMN dispute_outcomes.insurance_plan_id IS
  'The specific insurance_plans row this dispute was written against (the plan in effect at the service date — "the pin"). Set at draft from claims.insurance_plan_id (DOS-correct) or the user confirm/override chooser. Authoritative for plan resolution: honored before DOS-window / plan_year / active fallbacks so changing the active plan never silently rewrites an existing dispute. ON DELETE SET NULL so CHD erasure (OPS.9) cannot orphan a dispute; a null pin falls back to resolution. Gated by dispute_plan_pinning_v1.';

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_insurance_plan_id
  ON dispute_outcomes(insurance_plan_id);

-- 3. Approximate change-date signal (NOT a coverage-window boundary) -----------
ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

COMMENT ON COLUMN insurance_plans.activated_at IS
  'Timestamp this plan most recently became the user''s active plan (stamped now() by the plan-activation path, e.g. set-active). Most-recent-activation only (overwritten on re-activation); NULL = unknown (legacy / never changed via the app). APPROXIMATE change-date signal — used ONLY as the fallback anchor for the dispute plan-change banner''s old-vs-new recommendation (with a ~30-day buffer) when real coverage_period_* windows are absent. NOT a coverage-window boundary; never use for plan-year/DOS resolution (that stays coverage_period_start/end, document truth). Gated by dispute_plan_pinning_v1.';

-- 4. Feature flag seed (default OFF) — mirrors mig 167 shape -------------------
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'dispute_plan_pinning_v1',
  false,
  'Mid-Year Plan Change × Disputes — plan pinning. Pins each dispute to the specific insurance_plans row it was written against (dispute_outcomes.insurance_plan_id) so changing the active plan never silently rewrites an old dispute. Gates: the pin write on /api/disputes/generate, the pin-honoring resolver precedence (pin -> canonical-bind -> DOS-window -> year -> active), the "which plan were you on?" confirm/override chooser at draft, the plan-change cascade + Keep/Update banner on set-active, and the per-dispute re-bind control. When OFF, all paths are inert and plan resolution behaves exactly as today. Flip global ON only after the real flag-ON E2E.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
