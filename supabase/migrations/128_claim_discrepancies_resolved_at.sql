-- 128: claim_discrepancies — explicit resolved_at lifecycle timestamp.
--
-- Why: prior iter-12 fix in /correct-category endpoint marked discrepancies
-- as status='resolved' but had to use updated_at as a proxy timestamp because
-- the table (mig 037) had no resolved_at column. updated_at conflates "row
-- last touched" with "resolution event" — every subsequent update overwrites
-- the resolution signal.
--
-- This migration follows the codebase convention of dedicated *_at columns
-- for lifecycle events (see claim_line_items.user_corrected_at,
-- claims.metadata.audit_refreshed_at, dispute_outcomes.resolution_date).
--
-- ROLLOUT: additive nullable column + backfill from updated_at for existing
-- resolved rows + partial index for analytics queries. Zero-downtime; existing
-- code that reads claim_discrepancies continues to work unchanged.
--
-- BACKOUT: ALTER TABLE claim_discrepancies DROP COLUMN resolved_at;
--          DROP INDEX IF EXISTS idx_discrepancies_resolved_at;

BEGIN;

ALTER TABLE claim_discrepancies
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL;

-- Backfill 1: existing 'resolved' rows get updated_at as their resolution
-- timestamp (best available approximation — updated_at was the latest write,
-- typically the resolution event for rows resolved exactly once).
UPDATE claim_discrepancies
SET resolved_at = updated_at
WHERE status = 'resolved'
  AND resolved_at IS NULL;

-- Backfill 2 — S132 iter-13 historical cleanup: any active discrepancy on a
-- line the user has manually re-categorized (claim_line_items.user_corrected_at
-- NOT NULL) is stale. The eob_discrepancy_detection pipeline wrote it against
-- the OLD auto-classified slug; the user's pick implicitly resolves it but
-- the row never got marked. /correct-category endpoint now writes this state
-- on every new correction (iter-13 endpoint patch), but pre-iter-13 corrections
-- left orphaned 'flagged' rows that cause /claim BillCard to stay needs_review.
-- This backfill cleans them up in one shot so users with pre-iter-13 corrections
-- don't have to re-pick categories to clear the false needs_review flag.
UPDATE claim_discrepancies cd
SET status = 'resolved',
    resolved_at = now(),
    updated_at = now()
FROM claim_line_items cli
WHERE cd.claim_line_item_id = cli.id
  AND cli.user_corrected_at IS NOT NULL
  AND cd.status IN ('flagged', 'verifying', 'disputed');

-- Partial index for analytics: "how many discrepancies were resolved in the
-- last N days." Partial keeps the index small (only resolved rows have a
-- non-null timestamp).
CREATE INDEX IF NOT EXISTS idx_discrepancies_resolved_at
  ON claim_discrepancies(resolved_at)
  WHERE resolved_at IS NOT NULL;

COMMIT;
