-- Migration 070: T2.2 v3 outcome feedback extensions (codebase reality reconciled)
--
-- ADDITIVE-ONLY (CLAUDE.md Rule #7) — extends existing tables with columns + flag config.
-- NO new tables (existing dispute_outcomes mig 019 + dispute_followups mig 038 + audit_rule_accuracy
-- mig 039 are reused; Pattern M moderation queue deferred to Phase 4.5a per CF-16).
--
-- FULLY IDEMPOTENT — safe to re-run after partial application. User reported
-- `flywheel_eligibility_status` already exists from prior draft application; this file
-- handles that gracefully via `ADD COLUMN IF NOT EXISTS` + DO $$ EXCEPTION blocks.
--
-- Decisions reflected in this migration:
--   Q-T2.2-1 LOCK    — use existing 10-state status enum (mig 019/043); NO outcome enum changes
--   Q-T2.2-4 LOCK    — k-anon ≥5 distinct user_id per cell (compute-on-read; NO distinct_user_count column)
--   Q-T2.2-8 LOCK    — Pattern 1 #13 outlier quarantine column (this migration)
--   Q-T2.2-10 LOCK   — plan_year denormalization on dispute_outcomes (this migration)
--   Q-T2.2-12 LOCK   — extend stored audit_rule_accuracy with insurer_canonical_id dual-write (Option C)
--   Q-T2.2-6 LOCK    — Pattern M routing DEFERRED entirely (CF-16; no insurer_response field added here)
--   Q-T2.2-11 LOCK   — Pattern M-7 right-of-response DEFERRED entirely (CF-16; no bookend cols here)

-- ── 1. Pattern 1 #13 quarantine column on dispute_outcomes ────────────────
-- Per [[Candid_Data_Principles]] §6 #13 + memory project_candid_outlier_quarantine:
-- enables flywheel_eligibility_status='quarantined_outlier' on outliers (amount_recovered
-- ≥ outlier_threshold_usd OR > outlier_multiplier × amount_disputed) — wired in
-- src/lib/disputes/persist.ts updateDisputeOutcome.

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS flywheel_eligibility_status TEXT;

ALTER TABLE dispute_outcomes
  ADD COLUMN IF NOT EXISTS plan_year INT;

-- CHECK constraint (idempotent via DROP IF EXISTS then ADD)
DO $$
BEGIN
  ALTER TABLE dispute_outcomes DROP CONSTRAINT IF EXISTS dispute_outcomes_flywheel_eligibility_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE dispute_outcomes
  ADD CONSTRAINT dispute_outcomes_flywheel_eligibility_check
  CHECK (
    flywheel_eligibility_status IS NULL OR flywheel_eligibility_status IN (
      'quarantined_outlier',
      'verified_via_dispute',
      'verified_via_corroboration',
      'verified_via_admin',
      'rejected'
    )
  );

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_flywheel_eligibility
  ON dispute_outcomes(flywheel_eligibility_status)
  WHERE flywheel_eligibility_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_plan_year
  ON dispute_outcomes(plan_year)
  WHERE plan_year IS NOT NULL;

-- ── 2. Pattern 2 alignment on audit_rule_accuracy (Option C dual-write) ────
-- Existing mig 039 has insurer_name TEXT (fragile — text comparison; insurer renames
-- cause aggregation drift). Add insurer_canonical_id UUID FK alongside; new rows from
-- accuracy.ts upserts dual-write both columns. Existing rows keep insurer_name only;
-- backfill at OPS Sprint Session 75 per CF-16b.
--
-- Reads at metrics.ts prefer insurer_canonical_id JOIN when populated; fallback to
-- insurer_name text match when canonical_id is NULL (transition compatibility).

ALTER TABLE audit_rule_accuracy
  ADD COLUMN IF NOT EXISTS insurer_canonical_id UUID REFERENCES insurer_catalog(id);

CREATE INDEX IF NOT EXISTS idx_ara_canonical_insurer
  ON audit_rule_accuracy(insurer_canonical_id)
  WHERE insurer_canonical_id IS NOT NULL;

-- ── 3. dispute_feedback_loop flag config sub-keys (admin-tunable) ──────────
-- Existing flag mig 038 (default OFF). v3 extends config JSONB with sub-keys:
--   follow_up_first_days        → cadence (Q-T2.2-2 LOCK)
--   follow_up_repeat_days       → cadence (Q-T2.2-2 LOCK)
--   k_anon_min_distinct_users   → distinct user count threshold (Q-T2.2-4 LOCK SHARPENED)
--   outlier_threshold_usd       → Pattern 1 #13 threshold (Q-T2.2-8 LOCK)
--   outlier_multiplier          → Pattern 1 #13 multiplier (Q-T2.2-8 LOCK)
--   outlier_quarantine_enabled  → master kill switch for outlier quarantine
--   aggregate_cache_ttl_seconds → cache TTL for /api/aggregates/disputes endpoint
--
-- Idempotent JSONB merge: COALESCE existing config + new defaults; existing keys preserved.

UPDATE feature_flag_rules
  SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
    'follow_up_first_days', 30,
    'follow_up_repeat_days', 14,
    'k_anon_min_distinct_users', 5,
    'outlier_threshold_usd', 100000,
    'outlier_multiplier', 10,
    'outlier_quarantine_enabled', true,
    'aggregate_cache_ttl_seconds', 3600
  )
  WHERE flag_key = 'dispute_feedback_loop';

-- ── End of migration 070 ──────────────────────────────────────────────────
