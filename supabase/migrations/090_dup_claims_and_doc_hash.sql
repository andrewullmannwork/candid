-- Migration 090: S74.5 D11 — duplicate claims merge + ingestion-layer file-hash dedup
--
-- Per plans/s74.5_categorization_flywheel.md §8 D11.
--
-- WHY THIS MIGRATION EXISTS
--
-- Session 81 hotfix #4 shipped DISPLAY-LAYER dedup for re-uploaded bills
-- (collapses duplicates on /claim view via composite (date, cents, provider)
-- fingerprint). The DB still carries the duplicate rows — they're hidden, not
-- merged. D11 closes the gap with:
--   1. Schema additions for soft-delete + forensic trail (Pattern 1 #10:
--      preserve forensic record, never hard-delete).
--   2. File-hash column on documents so /api/documents/upload can skip
--      re-creating a documents row + claim when the user re-uploads the
--      identical PDF.
--   3. The one-time merge script (scripts/merge-duplicate-claims.ts) runs
--      AFTER this migration applies; it finds duplicate groups, redirects
--      dispute_outcomes + claim_discrepancies FKs to the winner, and
--      soft-deletes the losers.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. claims.deleted_at TIMESTAMPTZ — soft-delete marker. Read paths filter
--    `deleted_at IS NULL`. Preserves the row + its line items + its history.
-- 2. claims.merged_into_claim_id UUID REFERENCES claims(id) — forensic
--    pointer set when a row is soft-deleted as a merge-loser; nullable
--    because not every soft-delete is a merge.
-- 3. documents.file_hash TEXT — SHA-256 of the uploaded file bytes.
--    /api/documents/upload computes + checks before INSERT; existing
--    matching row short-circuits.
-- 4. Partial indexes optimized for the live read paths.
--
-- BACKOUT — additive only. New columns default NULL; existing rows + read
-- paths continue unchanged until the merge script runs and the new file-
-- hash check wires up.

BEGIN;

-- ============================================================================
-- SECTION 1: claims soft-delete + merge forensic trail
-- ============================================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS merged_into_claim_id UUID
    REFERENCES claims(id) ON DELETE SET NULL;

-- Live (non-deleted) claims per user — the primary read-path filter.
CREATE INDEX IF NOT EXISTS idx_claims_user_live
  ON claims (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Forward pointer index for tracing soft-deletes back to their winners
-- (admin forensics + display-layer "redirect to canonical claim" if needed).
CREATE INDEX IF NOT EXISTS idx_claims_merged_into
  ON claims (merged_into_claim_id)
  WHERE merged_into_claim_id IS NOT NULL;

COMMENT ON COLUMN claims.deleted_at IS
  'S74.5 D11 (Session 83). Soft-delete marker per Pattern 1 #10 (never hard-delete; preserve forensic record). Read paths (/api/claims, /api/claims/[id], dashboard rollups) filter on deleted_at IS NULL. Merge script (scripts/merge-duplicate-claims.ts) sets this on losers of a composite-key dup group + writes merged_into_claim_id to point to the winner. Soft-delete preserves claim_line_items (no CASCADE) and disputes_outcomes (FK is SET NULL on hard-delete; redirect happens at merge time).';

COMMENT ON COLUMN claims.merged_into_claim_id IS
  'S74.5 D11 (Session 83). Forensic pointer set on merge-loser claims. NULL when the soft-delete was NOT a merge (e.g., user requested erasure under Compliance / right-to-delete). Allows admin queries to trace "what happened to this claim" and lets the UI redirect a stale /claim/{loser_id} URL to the winner if desired.';

-- ============================================================================
-- SECTION 2: documents.file_hash for ingestion-layer dedup
-- ============================================================================
-- Application-level dedup, not a database UNIQUE constraint — the upload
-- pipeline computes the hash before INSERT and reuses an existing matching
-- documents row when found. A UNIQUE would surface as an opaque 23505 to
-- callers; the application path returns a structured "duplicate" response
-- and reuses the existing documentId.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_user_file_hash
  ON documents (user_id, file_hash)
  WHERE file_hash IS NOT NULL;

COMMENT ON COLUMN documents.file_hash IS
  'S74.5 D11 (Session 83). SHA-256 of the uploaded file bytes (hex; 64 chars). /api/documents/upload computes + checks (user_id, file_hash) before INSERT; on match returns the existing documentId so re-uploads do not create parallel claims chains. NULL for legacy rows uploaded before this column existed.';

COMMIT;
