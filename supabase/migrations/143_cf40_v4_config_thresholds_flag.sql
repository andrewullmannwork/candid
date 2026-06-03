-- =============================================================================
-- MIGRATION 143 — CF-40 v4 threshold config flag (Ship Gate G6)
-- =============================================================================
--
-- Seeds the single feature_flag_rules row that makes EVERY CF-40 v4 threshold
-- tunable with no code deploy. This is the LAST hard blocker for the
-- `cf40_v4_algorithm` flip (Andrew written sign-off S156; see
-- [[project_ing_d_aggregation_ts_decision]] + progress_backend.md S162). Mirrors
-- the mig 134 / 136 flag-seed shape (target_type + config JSONB; flag_key UNIQUE).
--
-- WHY THIS MIGRATION EXISTS
--
-- Before G6, every v4 threshold (corroboration counts, supermajority shares,
-- coverage gates, scale-tier boundaries, trust/time-decay weights, plausibility
-- band, minority-router gates, slow-drift / rapid-change / reparse-sampling, the
-- Layer-1 validity gates, admin-min-uploads, every-Nth smart-skip) was a compile-
-- time constant. The Ing-D.1 staged rollout (admin → 5% → 25% → 50% → global) must
-- be able to TUNE these during the soak (the Phase-0 audit Risk Register flags
-- per-scale supermajority thresholds + Layer-5 sample rates as the things to tune
-- if a stage regresses) without a deploy. This flag carries that config.
--
-- SOURCE OF TRUTH = CODE, NOT THIS ROW
--
-- `config` is seeded EMPTY on purpose. `loadCF40V4Config` reads this row and
-- OVERLAYS it onto `DEFAULT_CF40V4_CONFIG` (src/lib/parser/cf40-v4/config.ts) with
-- per-field fallback — so an empty config is byte-identical to the pre-G6 hardcoded
-- behavior, and the ~80 default values live in ONE place (the code), never
-- duplicated into immutable SQL where they could silently drift. To TUNE, write the
-- (possibly partial) section object you want to override; the overlay merges it
-- leaf-wise onto the code defaults. The full default schema + every value is in
-- DEFAULT_CF40V4_CONFIG.
--
-- BEHAVIOR
--
--   `cf40_v4_config` enabled=true target_type=global config={} (overrides only).
--   The flag is independent of the `cf40_v4_algorithm` ROLLOUT gate — config is
--   read regardless of `enabled` (config flags carry tuning, not a gate), and the
--   thresholds only become live when `cf40_v4_algorithm` itself flips ON (Ing-D.1).
--   With config={} the algorithm runs on the code defaults.
--
-- TUNING EXAMPLES (no code deploy; effective on the next parse)
--
--   -- Relax the cold-start (11-100 uploads) supermajority share 0.80 → 0.70:
--   UPDATE feature_flag_rules
--     SET config = jsonb_set(config, '{supermajority}', '{"coldStart":0.70}'::jsonb)
--     WHERE flag_key = 'cf40_v4_config';
--
--   -- Halve the cold-start forced-reparse sample rate 0.25 → 0.125 (cost during canary):
--   UPDATE feature_flag_rules
--     SET config = jsonb_set(config, '{reparseSampling,cold_start}', '{"sampleRate":0.125}'::jsonb)
--     WHERE flag_key = 'cf40_v4_config';
--   (Partial section objects are fine — the overlay keeps the other leaves at their
--    code defaults; e.g. temporalStalenessDays above stays 90.)
--
--   -- Inspect the live overrides:
--   SELECT config FROM feature_flag_rules WHERE flag_key = 'cf40_v4_config';
--
-- BACKOUT — flag row only; DELETE the row to remove. With cf40_v4_config absent,
-- loadCF40V4Config falls back to DEFAULT_CF40V4_CONFIG (the code defaults) → no
-- behavior change. This migration adds NO table / column / type and is safe to roll
-- back at any time.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'cf40_v4_config',
  true,
  'CF-40 v4 threshold config (Ship Gate G6, S162). Makes every v4 threshold tunable with no code deploy — the last hard blocker for the cf40_v4_algorithm flip (Ing-D.1). loadCF40V4Config OVERLAYS this config JSONB onto the code defaults in src/lib/parser/cf40-v4/config.ts (DEFAULT_CF40V4_CONFIG) with per-field fallback, so config={} is byte-identical to the pre-G6 hardcoded behavior and the ~80 default values stay single-sourced in code. Independent of the cf40_v4_algorithm rollout gate; read regardless of enabled. To tune, jsonb_set the (possibly partial) section to override — see the migration file header for examples. See progress_backend.md S162.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
