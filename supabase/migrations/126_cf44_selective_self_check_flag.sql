-- =============================================================================
-- MIGRATION 126 — CF-44 selective self-check feature flag (Ing-H,
--                 pre-launch backend hardening)
-- =============================================================================
--
-- Seeds the `cf44_selective_self_check` feature flag. Default ENABLED + global
-- in PROD per S129 "test on prod" decision (no users yet; safe to ship hot).
-- Emergency revert path: flip flag OFF in DB (no code deploy needed) restores
-- current "always-fire" behavior on the env-var-gated self-check sites.
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Ing-H: today's SBC + EOC
-- self-check fires on EVERY parse (env vars SBC_SELF_CHECK_ENABLED=true and
-- EOC_SELF_CHECK_ENABLED=true in PROD per S77 codification) — adds $0.05+/parse
-- on 100% of corpus. Only ~10% of corpus actually has the column-wrap drift
-- that self-check recovers from; the other 90% pays the cost for no benefit.
--
-- CF-44 selective self-check fires self-check ONLY when a runtime heuristic
-- (`column_wrap_score > 0.6`) detects column-wrap drift in the OCR text.
-- Estimated ~90% cost reduction on self-check pass while preserving the
-- 20-25pts cite-grade recall benefit on the docs that actually need it.
--
-- WHAT THIS MIGRATION ADDS
--
-- One row in `feature_flag_rules`:
--   flag_key:      cf44_selective_self_check
--   enabled:       true (default ON in PROD per S129 "test on prod")
--   target_type:   global
--   config:        {}
--
-- Mirrors the mig 121 garbage_validators_flag pattern.
--
-- BEHAVIOR
--
--   flag OFF: self-check fires whenever SBC_SELF_CHECK_ENABLED / EOC_SELF_CHECK_ENABLED
--             env var is true (current behavior — preserved for emergency revert)
--   flag ON:  self-check fires ONLY when column_wrap_score > 0.6 AND env var true
--
-- Heuristic decision is computed once per parse + persisted to
-- documents.metadata.column_wrap_decision for per-doc admin visibility +
-- threshold calibration.
--
-- BACKOUT — flag-row only; delete the row to remove. Reading code uses
-- isFeatureEnabled which falls back to default-OFF semantics when no row
-- present — but Ing-H's caller-side logic defaults to "preserve current
-- always-fire behavior" on missing flag, so removing the row reverts to
-- pre-Ing-H behavior.

BEGIN;

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'cf44_selective_self_check',
  true,
  'Ing-H (S129). Gates the column-wrap heuristic that selectively fires SBC + EOC self-check only on detected-garbled OCR text. ON = compute column_wrap_score from OCR; fire self-check only when score > 0.6 (selective; ~10% of corpus; ~90% cost reduction). OFF = preserve current always-fire behavior (env-var-gated SBC_SELF_CHECK_ENABLED + EOC_SELF_CHECK_ENABLED). Heuristic decision persisted to documents.metadata.column_wrap_decision for admin observability + threshold calibration. Default ON in PROD per S129 test-on-prod decision (no users at ship; emergency revert via flag flip OFF).',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
