-- =============================================================================
-- MIGRATION 081 — Per-document smart-skip stability + competing-baselines noise
-- protection (CF-40 v2 — Session 74 amendment)
-- =============================================================================
--
-- WHY (S71.5-BADGE-VERIFY user direction Session 74 — refinement):
--   CF-40 v1 (mig 080) tracked smart-skip stability at the canonical level. This
--   meant a NEW document hash on a stable canonical would smart-skip via the
--   semantic-match Path B in extraction-dedup.ts:shouldSkipExtraction — losing
--   the chance to discover additional services or value corrections from that
--   new document.
--
--   CF-40 v2 fixes this:
--     1. Smart-skip eligibility is per `(canonical_plan_id, file_hash)` tuple.
--        Each unique file_hash must prove its own stability via 3 consecutive
--        identical Haiku runs (same plan-identity values + 0 new services found).
--     2. Path B (semantic-match smart-skip) is REMOVED entirely. First-time
--        hashes always run Haiku — even when canonical is already stable via
--        other documents — so we capture potentially-new services / corrections
--        that the new document carries.
--     3. Competing-baselines noise protection: a divergent Haiku extraction
--        becomes a CANDIDATE; baseline preserved. Candidate becomes the new
--        baseline only after 3 corroborations. Single-run noise can NOT
--        invalidate a stable baseline.
--
-- WHAT THIS MIGRATION ADDS:
--   1. NEW `canonical_document_stability` table keyed by `(canonical_plan_id,
--      file_hash)`. Holds:
--        - `identical_parse_count` — consecutive matches against current baseline
--        - `haiku_output_stable` — flips TRUE when count >= 3
--        - `last_haiku_extracted_values` — current baseline (trusted snapshot)
--        - `candidate_values` + `candidate_match_count` — competing-baseline
--          slot for noise protection / drift correction
--
--   2. Deprecation comments on mig 080's per-canonical columns
--      (`canonical_plans.identical_parse_count` + `last_haiku_extracted_values`).
--      Per Pattern 1 #10 hard-delete prohibition: columns retained but no longer
--      authoritative; canonical_document_stability is the source of truth.
--      Comments document the deprecation; columns may be dropped in a future
--      additive migration after all callsites confirm.
--
-- BACKOUT:
--   Application-layer rollback: revert TS code that consults
--   canonical_document_stability in extraction-dedup.ts. Existing data
--   preserved. Mig 080's per-canonical columns still exist for legacy reads.
-- =============================================================================

BEGIN;

-- ── 1. NEW canonical_document_stability table ────────────────────────────────

CREATE TABLE IF NOT EXISTS canonical_document_stability (
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL,

  -- Counter of consecutive Haiku runs on this hash producing identical extraction
  -- (same plan-identity values AND zero new services found on canonical).
  identical_parse_count INT NOT NULL DEFAULT 0,

  -- Flips TRUE when identical_parse_count >= 3.
  -- Smart-skip Path A consults this for (canonical, hash) eligibility.
  haiku_output_stable BOOLEAN NOT NULL DEFAULT FALSE,

  -- Current trusted baseline — the plan-identity cost values that ≥1 Haiku
  -- runs converged on. Set on first parse; updated via competing-baseline
  -- promotion only.
  last_haiku_extracted_values JSONB,

  -- Competing baseline — proposed new baseline from a divergent Haiku run.
  -- candidate_match_count tracks corroborations for the candidate; promotes
  -- to baseline when reaches 3 (or threshold from feature flag config).
  -- NULL when no candidate is in flight.
  candidate_values JSONB,
  candidate_match_count INT NOT NULL DEFAULT 0,

  -- Telemetry: distinct user upload count contributing to this (canonical, hash).
  -- Increments on each upload; useful for admin dashboards.
  upload_count INT NOT NULL DEFAULT 0,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (canonical_plan_id, file_hash)
);

CREATE INDEX IF NOT EXISTS idx_canonical_document_stability_canonical
  ON canonical_document_stability (canonical_plan_id);

CREATE INDEX IF NOT EXISTS idx_canonical_document_stability_stable
  ON canonical_document_stability (canonical_plan_id, file_hash)
  WHERE haiku_output_stable = TRUE;

COMMENT ON TABLE canonical_document_stability IS
  'CF-40 v2 (Session 74). Per-(canonical_plan_id, file_hash) smart-skip eligibility tracking. Replaces mig 080''s per-canonical counter — stability is now per-document so first-time hashes always run Haiku (capturing potentially-new services/corrections) even on canonicals stable via other docs. Competing-baselines pattern: candidate_values + candidate_match_count slot protects baseline against single-run Haiku noise; candidate promotes to baseline only after 3 corroborations.';

COMMENT ON COLUMN canonical_document_stability.identical_parse_count IS
  'Consecutive Haiku runs on this (canonical, hash) producing identical extraction (same plan-identity values AND zero new services discovered on canonical). Used to gate smart-skip via haiku_output_stable when >= 3.';

COMMENT ON COLUMN canonical_document_stability.haiku_output_stable IS
  'Smart-skip eligibility for this (canonical, hash). TRUE when identical_parse_count >= 3. Smart-skip Path A in extraction-dedup.ts:shouldSkipExtraction queries this. False on first parse + remains false until baseline established + 3 confirmations land.';

COMMENT ON COLUMN canonical_document_stability.last_haiku_extracted_values IS
  'Current baseline plan-identity cost values JSONB shape: {in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family}. Comparison target for incoming Haiku runs. Updated only via competing-baseline promotion (candidate accumulates 3 corroborations) — single-run divergence does NOT update baseline.';

COMMENT ON COLUMN canonical_document_stability.candidate_values IS
  'Competing baseline. When a Haiku run produces values DIFFERENT from last_haiku_extracted_values, those values are stored here as a CANDIDATE. Subsequent matching runs increment candidate_match_count. When candidate_match_count >= 3, candidate is promoted to last_haiku_extracted_values (the persistent drift wins). Single-run noise creates a candidate but never displaces baseline. NULL when no candidate is in flight.';

COMMENT ON COLUMN canonical_document_stability.candidate_match_count IS
  'Corroboration count for candidate_values. Increments when Haiku run matches candidate. Resets to 0 when candidate is cleared (either after promotion to baseline OR when an extraction matches the existing baseline, which clears stale candidates).';

-- ── 2. Deprecate mig 080 per-canonical columns ───────────────────────────────
-- Per Pattern 1 #10 hard-delete prohibition: keep columns; deprecate via comment.
-- recordExtractionResult stops writing these in CF-40 v2 (canonical_document_stability
-- is authoritative). Future migration may drop after all callsites confirm.

COMMENT ON COLUMN canonical_plans.identical_parse_count IS
  'DEPRECATED (mig 081 — CF-40 v2). Replaced by canonical_document_stability.identical_parse_count which is per-(canonical, file_hash). Stability is now per-document so first-time hashes always Haiku-parse. Mig 080 column retained per Pattern 1 #10 additive policy; no longer updated by recordExtractionResult; reads will see frozen mig-080-invalidation values (0).';

COMMENT ON COLUMN canonical_plans.last_haiku_extracted_values IS
  'DEPRECATED (mig 081 — CF-40 v2). Replaced by canonical_document_stability.last_haiku_extracted_values which is per-(canonical, file_hash). Mig 080 column retained per Pattern 1 #10 additive policy; no longer updated.';

COMMIT;
