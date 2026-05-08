-- =============================================================================
-- MIGRATION 082 — Multi-slot candidate tracking with outlier-elimination eviction
-- (CF-40 v3 — Session 74, third amendment)
-- =============================================================================
--
-- WHY:
--   CF-40 v2 (mig 081) used single `candidate_values` + `candidate_match_count`
--   columns. Limitation: when 3 distinct divergent values appear in alternation
--   (V_A → V_B → V_A → V_B → ...), neither value accumulates because the single
--   candidate slot keeps overwriting. Real drift / legitimate alternative values
--   can never be detected when interleaved with other divergence.
--
--   CF-40 v3 fixes this by storing UP TO 2 candidate slots per `(canonical_plan_id,
--   file_hash)` (3 total slots: baseline + 2 candidates). When a 3rd distinct value
--   arrives, eviction uses OUTLIER-ELIMINATION: drop the candidate with HIGHEST
--   isolation (sum of distances to other candidates). Cluster of consensus
--   survives; isolated outlier dropped.
--
--   Skewing toward accuracy/precision: clusters represent corroborating evidence
--   (multiple independent Haiku runs producing similar values). Outliers are more
--   likely Haiku stochasticity / OCR noise / single-event errors. Drop the noise,
--   keep the signal.
--
-- WHAT THIS MIGRATION ADDS:
--   1. NEW column `candidate_slots JSONB NOT NULL DEFAULT '[]'::jsonb`. Each slot
--      is an object: { values: {in_deductible_individual, in_deductible_family,
--      in_oop_max_individual, in_oop_max_family}, services_count, match_count,
--      first_seen_at, last_seen_at }.
--
--   2. Backfill — migrate existing v2 single-candidate state (where present) into
--      a single-element `candidate_slots` array. services_count NULL because v2
--      didn't track it per candidate (newer slots will have services_count from
--      extractedSlugs.length at write time).
--
--   3. Deprecate v2 columns (`candidate_values` JSONB + `candidate_match_count`
--      INT). Keep per Pattern 1 #10 additive policy; comments mark them deprecated.
--
-- BACKOUT:
--   Application-layer rollback: revert TS code that consults `candidate_slots`.
--   Existing data preserved. v2 columns still in place; v2 logic operates on
--   them if reverted.
-- =============================================================================

BEGIN;

-- ── 1. Add candidate_slots JSONB column ──────────────────────────────────────

ALTER TABLE canonical_document_stability
  ADD COLUMN IF NOT EXISTS candidate_slots JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN canonical_document_stability.candidate_slots IS
  'CF-40 v3 (Session 74). Multi-slot candidate array, max 2 entries per (canonical_plan_id, file_hash). Each entry: { values: {in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family}, services_count: int, match_count: int, first_seen_at: timestamptz string, last_seen_at: timestamptz string }. Eviction when 3rd candidate arrives uses outlier-elimination: drop the candidate with highest isolation (sum of distances to other candidates). Distance metric: mismatches × 1000 + |services_count_delta|. Tiebreakers (when isolations tie): drop lower match_count; then drop oldest last_seen_at. Promotion when any slot reaches match_count >= 3 → that slot''s values become new baseline + all candidate_slots cleared.';

-- ── 2. Backfill existing v2 single-candidate state into v3 array ─────────────
-- Where v2 candidate state is non-empty, convert it to a one-element slot array.
-- Future updates write through the v3 candidate_slots column; v2 columns stop
-- updating after deploy.

UPDATE canonical_document_stability
  SET candidate_slots = jsonb_build_array(
    jsonb_build_object(
      'values', candidate_values,
      'services_count', NULL,
      'match_count', candidate_match_count,
      'first_seen_at', last_seen_at,
      'last_seen_at', last_seen_at
    )
  )
  WHERE candidate_values IS NOT NULL
    AND candidate_match_count > 0
    AND candidate_slots = '[]'::jsonb;

-- ── 3. Deprecate v2 columns ──────────────────────────────────────────────────

COMMENT ON COLUMN canonical_document_stability.candidate_values IS
  'DEPRECATED (mig 082 — CF-40 v3). Replaced by candidate_slots[].values. v2 single-slot model couldn''t handle alternating-divergent-value sequences (V_A/V_B/V_A overwrote progress). Column retained per Pattern 1 #10 additive policy; no longer updated by recordExtractionResult.';

COMMENT ON COLUMN canonical_document_stability.candidate_match_count IS
  'DEPRECATED (mig 082 — CF-40 v3). Replaced by candidate_slots[].match_count. Column retained; no longer updated.';

COMMIT;
