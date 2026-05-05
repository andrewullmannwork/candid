-- Migration 072: Rename `canonical_plans.extraction_stable` → `haiku_output_stable`
-- (additive; old column deprecated).
--
-- Critical architectural correction (CF-19 — Session 64 per user direction).
--
-- BACKGROUND
-- `canonical_plans.extraction_stable` is currently consulted as a Pattern 1 #3
-- corroboration signal in code paths that decide cross-user trust:
--   - extraction-dedup.ts smart-skip eligibility (mig 027)
--
-- BUT the actual semantics, per recordExtractionResult (extraction-dedup.ts:531-543):
--   "stable = last 3 full extractions all found 0 new services"
--
-- This is HAIKU-OUTPUT CONVERGENCE — a parser-stability signal — NOT a distinct-user
-- corroboration signal. ONE user uploading the same SBC three times satisfies it.
-- Per Pattern 1 #14 ("same-user repeat-action events don't inflate distinct-user
-- count"), conflating this with corroboration would be a Pattern 1 #14 violation.
--
-- The TRUE distinct-user corroboration signal lives on `canonical_plans.verification_count`
-- (mig 066 — COUNT(DISTINCT user_id) JOIN insurance_plans). That's what consumer-read
-- thresholds against for Pattern 1 #4 display gating.
--
-- THIS MIGRATION
-- Renames the column to clarify its true meaning. Smart-skip eligibility continues
-- to use this signal (Haiku-stability is the right thing for "should we re-Haiku?")
-- but the name no longer suggests cross-user trust.
--
-- ADDITIVE RENAME PATTERN (per CLAUDE.md Rule #7)
--   1. ADD `haiku_output_stable` BOOLEAN with DEFAULT FALSE
--   2. Backfill from `extraction_stable`
--   3. Add a BEFORE-trigger that mirrors writes between the two columns (so legacy
--      code that writes `extraction_stable` continues to work; new code writes
--      `haiku_output_stable`)
--   4. COMMENT both columns to document the deprecation status
--   5. Future migration (post-Session-65) drops `extraction_stable` after all reads
--      migrated to `haiku_output_stable`.

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS haiku_output_stable BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE canonical_plans
  SET haiku_output_stable = COALESCE(extraction_stable, FALSE)
  WHERE haiku_output_stable IS DISTINCT FROM COALESCE(extraction_stable, FALSE);

COMMENT ON COLUMN canonical_plans.extraction_stable IS
  'DEPRECATED — use canonical_plans.haiku_output_stable (mig 072). Will be dropped in a follow-up migration after Session 65 once all reads migrate. Semantics: Haiku-output convergence (last 3 full extractions added 0 new services). NOT a Pattern 1 #3 corroboration signal — those use canonical_plans.verification_count (mig 066).';

COMMENT ON COLUMN canonical_plans.haiku_output_stable IS
  'Haiku-output convergence signal. True when the last 3 full extractions on this canonical_plan added 0 new service slugs (extraction is stable / parser converged). Used by smart-skip dedup logic (extraction-dedup.ts) to decide whether to re-run Haiku on subsequent uploads of the same canonical. NOT a Pattern 1 #3 corroboration signal — use verification_count for that. Mig 072 renamed from extraction_stable to disambiguate.';

-- BEFORE-trigger to keep both columns in sync during the deprecation window.
-- Direction: write to either column, mirror to the other. After old column is
-- dropped, this trigger goes too.
CREATE OR REPLACE FUNCTION sync_extraction_stable_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- If only one was changed, mirror to the other.
  IF TG_OP = 'INSERT' THEN
    -- On INSERT, prefer haiku_output_stable if explicit; else copy extraction_stable.
    IF NEW.haiku_output_stable IS DISTINCT FROM FALSE THEN
      NEW.extraction_stable := NEW.haiku_output_stable;
    ELSIF NEW.extraction_stable IS DISTINCT FROM FALSE THEN
      NEW.haiku_output_stable := NEW.extraction_stable;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- On UPDATE, the changed column wins; sync to the other.
    IF NEW.haiku_output_stable IS DISTINCT FROM OLD.haiku_output_stable
       AND NEW.extraction_stable IS NOT DISTINCT FROM OLD.extraction_stable THEN
      NEW.extraction_stable := NEW.haiku_output_stable;
    ELSIF NEW.extraction_stable IS DISTINCT FROM OLD.extraction_stable
          AND NEW.haiku_output_stable IS NOT DISTINCT FROM OLD.haiku_output_stable THEN
      NEW.haiku_output_stable := NEW.extraction_stable;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_plans_extraction_stable_sync ON canonical_plans;
CREATE TRIGGER canonical_plans_extraction_stable_sync
  BEFORE INSERT OR UPDATE ON canonical_plans
  FOR EACH ROW
  EXECUTE FUNCTION sync_extraction_stable_columns();
