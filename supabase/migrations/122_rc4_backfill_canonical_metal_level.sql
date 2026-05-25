-- =============================================================================
-- MIGRATION 122 — Backfill canonical_plans.metal_level from prior cite-grade
--                 Haiku extractions (Ing-C RC-4+1 / RC-1, pre-launch backend
--                 hardening; S128)
-- =============================================================================
--
-- Companion to the RC-4 forward fix (src/lib/sbc/legacy-adapter.ts +
-- src/lib/plan/canonical-match.ts changes that wire metalTier through to
-- canonical_plans.metal_level on NEW canonical creation).
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` Ing-C RC-1 + RC-4:
--   - RC-4: Haiku-extracted `metalTier` was being dropped in legacy-adapter.ts
--     (113 PROD canonicals currently have NULL `metal_level`).
--   - RC-1: `metal_level` was never written on canonical INSERT path.
--
-- The forward fix lands in code; this migration backfills the existing 113
-- (or fewer) NULL canonical rows using metal_tier values previously captured
-- in canonical_haiku_extractions (mig 084) — cite-grade Pattern P-8
-- extractions stored append-only since S72 commit 4.
--
-- BACKFILL STRATEGY
--
-- canonical_haiku_extractions stores one row per (canonical_plan_id, field_name,
-- haiku_run_id) for cite-grade-verified extractions only (source_excerpt_verified
-- = 'verified' AND source_section_verified = true; enforced at write time per
-- writeCanonicalHaikuExtractions helper). Multiple uploads on the same canonical
-- produce multiple rows. Backfill picks the MOST-RECENT verified row per
-- canonical with field_name = 'metal_tier' and a non-null extracted_value.
--
-- Idempotency: `WHERE cp.metal_level IS NULL` skips canonicals already
-- populated. Re-running this migration after additional Haiku extractions
-- accumulate would backfill any additional newly-coverable rows; not running
-- it again is also safe.
--
-- Per Pattern 1 #14 + Rule #4 exception clause: canonical tables may be
-- populated by "backend parsers, admin tools, and seed migrations only".
-- This migration is a seed migration; canonical writes from user-facing code
-- remain forbidden.
--
-- BACKOUT — UPDATE-only; no schema change. If the backfill picks an
-- incorrect value (e.g., a stale prior extraction superseded by a later
-- correction), the offending rows can be re-NULLed by admin and re-populated
-- by the forward-fix path on next SBC upload from any user on that canonical.

BEGIN;

-- ============================================================================
-- SECTION 1: Backfill canonical_plans.metal_level
-- ============================================================================
-- Rolling-aggregate strategy via DISTINCT ON: per canonical_plan_id, pick the
-- most-recent verified metal_tier extraction. Filter to non-null extracted
-- values + canonicals that still have NULL metal_level today.

WITH latest_metal_extractions AS (
  SELECT DISTINCT ON (canonical_plan_id)
    canonical_plan_id,
    extracted_value,
    created_at
  FROM canonical_haiku_extractions
  WHERE field_name = 'metal_tier'
    AND extracted_value IS NOT NULL
    AND extracted_value::text <> 'null'::text  -- defensive: JSONB null sentinel
    AND source_excerpt_verified = 'verified'
    AND source_section_verified = true
  ORDER BY canonical_plan_id, created_at DESC
)
UPDATE canonical_plans cp
SET metal_level = (lme.extracted_value #>> '{}'),  -- JSONB → text via ->> root path
    updated_at = now()
FROM latest_metal_extractions lme
WHERE cp.id = lme.canonical_plan_id
  AND cp.metal_level IS NULL;

-- ============================================================================
-- SECTION 2: Diagnostic snapshot — emit row counts via RAISE NOTICE
-- ============================================================================
-- Surfaces the backfill scope at apply time so the operator can confirm the
-- expected number of rows changed (≤113 per Ing-C RC-1 estimate).

DO $$
DECLARE
  v_total_null_before INTEGER;
  v_eligible_extractions INTEGER;
  v_total_null_after INTEGER;
BEGIN
  -- After the UPDATE above ran, count remaining NULL metal_level rows
  SELECT COUNT(*) INTO v_total_null_after
  FROM canonical_plans
  WHERE metal_level IS NULL;

  -- Count distinct canonicals that had a verified metal_tier extraction
  -- (i.e., total eligible for backfill before this run)
  SELECT COUNT(DISTINCT canonical_plan_id) INTO v_eligible_extractions
  FROM canonical_haiku_extractions
  WHERE field_name = 'metal_tier'
    AND extracted_value IS NOT NULL
    AND extracted_value::text <> 'null'::text
    AND source_excerpt_verified = 'verified'
    AND source_section_verified = true;

  -- The pre-state count requires capturing before UPDATE; can't infer here.
  -- Operator can compare v_total_null_after vs the pre-merge baseline.

  RAISE NOTICE 'Ing-C RC-1 backfill complete. Remaining NULL metal_level: %; canonicals with eligible verified metal_tier extractions: %.',
    v_total_null_after, v_eligible_extractions;
END $$;

COMMIT;
