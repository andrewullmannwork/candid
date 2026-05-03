-- Migration 067: Phase 4 consumer-read filter feature flags
--
-- Phase 4 Task 4-B (Session 56). Adds:
--   1. JSONB `config` column on feature_flag_rules (additive; existing flags unaffected)
--      to support non-boolean configuration values keyed by flag_key.
--   2. `consumer_read_filter_v1` boolean flag (default OFF / global) — gates whether
--      /api/plan/analyze returns the decorated values shape (Pattern P-8 + Pattern 1 #4
--      enforcement at consumer-read layer).
--   3. `pattern1_corroboration_threshold` configurable threshold flag (default ON /
--      global, config = {"value": 3}) — admin-tunable count of distinct users required
--      for canonical_inherited / canonical_fallback rows to render as "verified" via
--      multi-source corroboration. Per Q-P4-3 LOCK Session 55: configurable via
--      feature_flags table; default 3 until P.2 Phone OTP lands at which point
--      threshold can drop to 2 (per Pattern 1 #4 audit-item #4-interim).
--
-- WHY a JSONB config column (vs separate config table or repurposing target_percentage):
--   - Keeps the single-table read pattern users already use (one query gets flag state
--     + config; no extra round-trip).
--   - JSONB is forward-compatible for future config knobs (e.g., per-source thresholds,
--     per-domain rollout configs) without further migrations.
--   - target_percentage is INT 0-100 with a CHECK constraint; it would be schema abuse
--     to repurpose for arbitrary numeric values, and breaks for non-numeric configs.
--   - A separate config_values table would split the read pattern across two queries
--     and complicate isFeatureEnabled() — high cost for no benefit at current scale.
--
-- Reading pattern (server-side helper added in src/lib/config/product-flags.ts as part
-- of Phase 4 Task 4-B code change):
--   readFeatureFlagConfig<T>(flagKey, key, fallback): T
--     fetches feature_flag_rules.config->>key for the given flag, returns parsed value
--     or fallback. Used as: await readFeatureFlagConfig('pattern1_corroboration_threshold', 'value', 3)

BEGIN;

-- ── 1. Add config column (additive; existing flags get '{}') ──

ALTER TABLE feature_flag_rules
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN feature_flag_rules.config IS
  'Per-flag configuration values for non-boolean settings. Read via readFeatureFlagConfig() helper. Example: pattern1_corroboration_threshold has config = {"value": 3} representing the distinct-user count threshold for canonical-source corroboration. Empty {} for boolean-only flags.';

-- ── 2. Seed consumer_read_filter_v1 flag (default OFF — admin-only soak first per Q-P4-7) ──

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'consumer_read_filter_v1',
  false,
  'Phase 4 Task 4-B (Session 56). Gates whether /api/plan/analyze returns the decorated values shape (Pattern P-8 citation-grade + Pattern 1 #4 multi-source corroboration enforcement at consumer-read display layer). When OFF, response is byte-identical to pre-Phase-4. When ON, every P-8-eligible field is wrapped in DecoratedValue<T> with state/reason/excerpt for unified <DisplayState> rendering. Rollout per Q-P4-7 LOCK: admin-only soak (7 days) → global flip (no gradual ramp; pre-launch context).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- ── 3. Seed pattern1_corroboration_threshold config flag (default ON, value=3) ──

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'pattern1_corroboration_threshold',
  true,
  'Phase 4 Task 4-B (Session 56). Configurable distinct-user count threshold for Pattern 1 #4 multi-source corroboration on canonical_inherited / canonical_fallback rows. Default 3 (audit item #4-interim — raised from 2 because P.2 Phone OTP signup not yet shipped; email-only identity is gameable for ≥2 distinct users). Drops to 2 once P.2 ships. Admin tunes via UPDATE feature_flag_rules SET config = jsonb_set(config, ''{value}'', ''2''::jsonb) WHERE flag_key = ''pattern1_corroboration_threshold''. Only consulted for sources canonical_inherited and canonical_fallback; provider_submitted has hardcoded threshold = 2 (Pattern 1 clarification Session 55); all other sources (self/trusted) → threshold = 0 (no corroboration required).',
  'global',
  '{"value": 3}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
