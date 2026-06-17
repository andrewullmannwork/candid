-- =============================================================================
-- MIGRATION 164 — eoc_reader_resolution_v1 feature flag seed (S202, thesaurus E)
-- =============================================================================
--
-- Seeds the `eoc_reader_resolution_v1` row in `feature_flag_rules`. The flag gates
-- the EOC READER-RESOLUTION block (block spec [[eoc_content_type_routing]] §9): the
-- read-time surfacing on `/api/plan/analyze` + `/plan` of the prior-auth / medical-
-- necessity facts the EOC parser already persisted (Flip-A E2E, S201). NO new data
-- is written — this is a pure READER over the user's own plan rows:
--   • per-service (Surface 1): coverage_rules.{prior_auth_*, medical_necessity_*}
--     + diagnosis_qualifiers, surfaced inline on each benefit item.
--   • plan-level (Surface 2): insurance_plans.metadata.eoc_prior_auth_facts[]
--     resolved into the "plan-wide" + "by location" aggregate cards (dedup,
--     scope routing, conservative-suppress of listed-service waivers).
--   • plan-level (Surface 3): insurance_plans.metadata.eoc_coverage_provisions[]
--     surfaced as the "Good to know / About your plan" themed list.
--
-- OFF = byte-identical: the analyze response gains NONE of the new fields, the /plan
-- page renders exactly as today. ON + a plan with no EOC metadata = no-op (empty).
-- NO schema change (mig 163 added coverage_rules + insurance_plans.metadata). The
-- reader is wholly behind this flag → rollback = flip OFF.
--
-- ROLLOUT (roadmap [[thesaurus_completion_roadmap]] §5 Session E):
--   1. This migration applies WITH the E promote, flag OFF.
--   2. Flip ON only after: resolver fixture + tsc/eslint/build green + a live
--      read-only flag-ON smoke on a parsed EOC plan (6480e12b) confirming the
--      facts route correctly and canonical is untouched + zero-regression on
--      /plan for plans WITHOUT EOC data (the overwhelming case).
--   3. Rollback of reader behavior = flip OFF (this row's `enabled` -> false).
--
-- ROLLBACK (of the seed itself):
--   DELETE FROM feature_flag_rules WHERE flag_key = 'eoc_reader_resolution_v1';
-- =============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'eoc_reader_resolution_v1',
  false,
  'S202 (thesaurus E). Read-time surfacing on /api/plan/analyze + /plan of EOC-extracted prior-auth + medical-necessity facts already persisted by the parser (Flip-A E2E). Per-service inline criteria + consolidated cite-grade quote block (Surface 1); plan-level "Prior authorization · plan-wide" + "· by location" aggregate cards from insurance_plans.metadata.eoc_prior_auth_facts[] with dedup, scope routing, and conservative-suppress of listed-service waivers (Surface 2); "Good to know" from eoc_coverage_provisions[] (Surface 3). READS ONLY (no DB writes, Pattern 1 #14). OFF = analyze response + /plan byte-identical; ON + non-EOC plan = no-op. NO schema change. Rollback = flip OFF.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
