-- =============================================================================
-- MIGRATION 121 — Garbage-pattern validators flag (Ing-B, pre-launch backend
--                 hardening; CF-63 RC-6 standalone)
-- =============================================================================
--
-- Adds the `garbage_validators_enabled` feature flag that gates the new
-- post-parser garbage-pattern validator wired in:
--   - src/lib/plan/process-plan.ts (SBC + plan-doc + Haiku-identity convergence)
--   - src/lib/plan/process-eoc.ts (EOC parser canonical-resolution path)
--   - src/lib/plan/reparse-field.ts (user-triggered single-field reparse)
--   - src/lib/plan/reparse-fields-batch.ts (Ing-A auto-reparse batched path)
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Ing-B: post-extraction
-- validator catches Haiku non-null outputs that pass null discipline but are
-- obviously wrong (HIOS plan IDs / FAQ text / footer boilerplate leaking
-- into planName / insurerName / metalTier / groupNumber due to OCR
-- column-wrap drift).
--
-- Validator nulls the offending field and emits a structured parseWarning
-- so the field doesn't enter `insurance_plans` / `canonical_plans` and is
-- queryable from `parse_audit_runs.parse_warnings` for tuning.
--
-- This block was originally bundled as RC-6 inside the Ing-C B-CF63 batch
-- (5 PRs sequential). Decision at S128 (Andrew, 2026-05-25): extract as
-- standalone Ing-B PR ahead of the rest of B-CF63 so the belt-and-suspenders
-- defense lands before the section-discovery RC fixes. Ing-C drops to 4 PRs
-- (RC-2, RC-4+1, RC-3, RC-5).
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. garbage_validators_enabled feature flag — seeded ON, global. Empty
--    pattern fires + flag ON = no-op when no parser output matches the
--    8 curated patterns, so default-ON ships safe. Operators flip OFF only
--    if a false-positive on a legitimate plan surfaces post-deploy;
--    emergency revert path without a code deploy.
--
-- PATTERN SET (8 universal patterns; insurer-agnostic, doc-type-agnostic
-- per feedback_universal_fixes_only)
--
--    /\bHIOS Plan ID\b/i              — label "HIOS Plan ID:" leaking
--    /^\d{5}[A-Z]{2}\d{7}/            — raw CMS HIOS ID (5d + 2L + 7d)
--    /\bNo\.\s+You can\b/i            — FAQ-answer column-wrap pattern
--    /\bReferrals\)\s*$/i             — fragment of "Referrals)" trailing
--    /For more information about/i    — boilerplate prose leak
--    /see the plan or policy document/i — boilerplate prose leak
--    /limitations and exceptions/i    — boilerplate prose leak
--    /^[A-Z0-9_]+$/                   — all-caps code/token, no spaces
--
-- Pattern-to-field map is curated in src/lib/plan/garbage-validators.ts
-- (NOT all-patterns-apply-to-all-fields) — e.g., the all-caps `caps_token`
-- pattern is restricted to metal_tier + group_number because it would
-- false-positive on legitimate insurer abbreviations (BCBS, UHC, AETNA,
-- ANTHEM, etc.). HIOS-ID is excluded from group_number because real group
-- numbers can coincidentally match the 14-char shape.
--
-- BACKOUT — additive only. Flag row can be deleted if rolling back. No
-- schema changes; the validator code itself is gated by the flag at
-- runtime so a code deploy isn't required to disable.

BEGIN;

-- ============================================================================
-- SECTION 1: garbage_validators_enabled feature flag
-- ============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'garbage_validators_enabled',
  true,
  'Ing-B (S128). Gates the post-parser garbage-pattern validator that nulls and warns on plan_name / insurer_name / metal_tier / group_number values matching known-garbage regex patterns from OCR column-wrap drift (CF-63 RC-6). Wired at process-plan.ts (post identity-recovery, pre planInsert), process-eoc.ts (canonical-resolution path), reparse-field.ts, and reparse-fields-batch.ts. ON = validator active, fields nulled on match, parse_warning emitted. OFF = validator skipped (emergency revert without redeploy). Default ON; no-op when no parser output matches the 8 curated patterns, so default ships safe.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
