-- =============================================================================
-- MIGRATION 124 — Canonical-match decisions event log (Ing-K Phase 1,
--                 pre-launch backend hardening)
-- =============================================================================
--
-- Adds a per-decision event-log telemetry table that records every exit point
-- of findOrCreateCanonicalPlan. Zero behavior change — Ing-K Phase 1 ships
-- observability only; Phase 2 (next session) ships a targeted matching fix
-- based on observed PROD distribution of failure modes.
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Ing-K (NEW at S127):
-- Andrew flagged during S127 Ing-J smoke that the same SBC uploaded twice
-- in dev produced "No match found, creating new canonical" instead of
-- corroborating an existing canonical via Pattern 1 #3 source_count
-- increment. The fuzzy-match algorithm in `src/lib/plan/canonical-match.ts`
-- `findOrCreateCanonicalPlan` has multiple plausible failure modes (per
-- S129 Ing-K critical-pass investigation):
--
--   A. plan_year filter drift between Haiku attempts (Step 3 hard equality
--      on plan_year; current-year fallback at line 75/903 can diverge from
--      a previously extracted year)
--   B. plan_name trigram below 0.7 when other dimensions absent (maxScore=40
--      so a 0.69 trigram→0.69 ratio→below threshold→create_new)
--   C. trigramSimilarity uses MAX as denominator (more pessimistic than
--      pg_trgm Jaccard; threshold was likely tuned assuming Jaccard semantics)
--   D. insurer_id drift across uploads (substring containment in
--      matchInsurerCatalog could resolve differently across attempts)
--
-- Without telemetry, we can't tell which root cause dominates in PROD.
-- Shipping a blind threshold/filter change risks false-merge (canonical
-- poisoning) which is worse than missed dedup per Pattern 1 #3 +
-- feedback_data_flywheel_reliability. Phase 1 ships the observability;
-- Phase 2 ships the targeted fix.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. canonical_match_decisions table — append-only event log; one row per
--    findOrCreateCanonicalPlan exit. Captures step_matched, best_score,
--    candidate_count, rejected_top_candidate_id (for near-miss surface),
--    input_signature (sha256 hash of normalized identity tuple for repeat-
--    upload grouping), input_payload (full CanonicalMatchInput for replay),
--    reason (which dimension caused divergence in human-readable form).
-- 2. NO feature flag — telemetry is always on; zero behavior change.
--
-- STEP_MATCHED ENUM
--
--   'group_number'             — Step 1 exact group_number match fired
--   'hios_id'                  — Step 2 exact hios_id match fired
--   'fuzzy_auto'               — Step 3 fuzzy score >= 0.9 auto-linked
--   'fuzzy_needs_confirmation' — Step 3 fuzzy 0.7-0.9 needs confirmation
--   'create_new'               — Step 4: no candidates OR top below 0.7
--
-- Field-CHECK enforces the closed set. Mutually exclusive (one row per call).
--
-- INPUT_SIGNATURE
--
-- sha256(insurer_id + '|' + cleanPlanName(plan_name) + '|' + plan_year)
-- where cleanPlanName mirrors src/lib/plan/canonical-match.ts:cleanPlanName.
-- Same SBC uploaded twice produces the same signature → admin query
-- GROUP BY input_signature surfaces "this signature produced N canonicals"
-- pattern (the Ing-K bug signature).
--
-- BACKOUT — additive only. New table can be dropped; existing tables
-- untouched. No FKs added to canonical_plans or documents to keep telemetry
-- loosely coupled (matches mig 120 pattern). Forensic telemetry survives
-- canonical / document deletion.

BEGIN;

-- ============================================================================
-- SECTION 1: canonical_match_decisions table
-- ============================================================================

CREATE TABLE IF NOT EXISTS canonical_match_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID,
  insurance_plan_id UUID,
  input_signature TEXT NOT NULL,
  step_matched TEXT NOT NULL
    CHECK (step_matched IN (
      'group_number',
      'hios_id',
      'fuzzy_auto',
      'fuzzy_needs_confirmation',
      'create_new'
    )),
  best_score NUMERIC(4,3),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  matched_canonical_id UUID,
  rejected_top_candidate_id UUID,
  input_payload JSONB NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cmd_document_id
  ON canonical_match_decisions (document_id);

CREATE INDEX IF NOT EXISTS idx_cmd_input_signature
  ON canonical_match_decisions (input_signature);

CREATE INDEX IF NOT EXISTS idx_cmd_step_matched_created_at
  ON canonical_match_decisions (step_matched, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cmd_created_at
  ON canonical_match_decisions (created_at DESC);

COMMENT ON TABLE canonical_match_decisions IS
  'Ing-K Phase 1 (S129). Append-only event log of findOrCreateCanonicalPlan exits. One row per call. Captures which step matched (or did not), best fuzzy score, candidate count, near-miss top candidate (when create_new fired with top in 0.5-0.7 range), input signature (sha256 of normalized identity tuple for repeat-upload grouping), and full input payload for replay. Powers /admin/canonical-match-decisions observability; Phase 2 ships a targeted matching fix based on observed failure-mode distribution. No FKs to canonical_plans / documents / insurance_plans — telemetry survives deletion. Server-only writes via canonical-match-telemetry helper; no RLS.';

COMMENT ON COLUMN canonical_match_decisions.document_id IS
  'Optional documents.id — the upload that triggered this match call. NULL when call originated outside upload flow (e.g., reject-canonical-match path). Soft reference; no FK.';

COMMENT ON COLUMN canonical_match_decisions.insurance_plan_id IS
  'Optional insurance_plans.id — the user-scoped plan being matched against canonicals. NULL when call originated outside upload flow. Soft reference; no FK.';

COMMENT ON COLUMN canonical_match_decisions.input_signature IS
  'sha256(insurer_id + ''|'' + cleanPlanName(plan_name) + ''|'' + plan_year). Same SBC uploaded twice produces the same signature. Admin queries GROUP BY input_signature to surface "this signature created N canonicals" (the Ing-K dedup-quality bug).';

COMMENT ON COLUMN canonical_match_decisions.step_matched IS
  'Which exit path findOrCreateCanonicalPlan took. group_number/hios_id = Steps 1/2 exact match. fuzzy_auto = Step 3 score>=0.9. fuzzy_needs_confirmation = Step 3 0.7-0.9. create_new = Step 4 (no candidates or top<0.7).';

COMMENT ON COLUMN canonical_match_decisions.best_score IS
  'Best fuzzy score (0-1) from scoreCandidate when Step 3 ran. NULL when Steps 1/2 fired (exact match; no fuzzy score). When step_matched=create_new + best_score is in 0.5-0.7 range, this is a NEAR-MISS (would have matched with slightly lower threshold).';

COMMENT ON COLUMN canonical_match_decisions.candidate_count IS
  'Number of canonicals returned by Step 3 SELECT (filtered by insurer_id + plan_year). 0 = filter excluded all candidates (likely root cause A: plan_year drift). >0 = filter found candidates but scoring rejected them (likely root cause B/C/D).';

COMMENT ON COLUMN canonical_match_decisions.matched_canonical_id IS
  'canonical_plans.id that was matched / created. ALWAYS populated (every call returns a canonical id). Use with input_signature to surface "same signature → multiple matched canonical_ids" pattern.';

COMMENT ON COLUMN canonical_match_decisions.rejected_top_candidate_id IS
  'When step_matched=create_new AND candidate_count>0, this is the canonical_plans.id of the top-scoring candidate that fell below the 0.7 threshold. The "would have matched if threshold were lower" candidate. NULL when create_new fired with 0 candidates OR when matching succeeded.';

COMMENT ON COLUMN canonical_match_decisions.input_payload IS
  'Full CanonicalMatchInput JSON (insurerId, planName, altPlanName, planType, state, planYear, groupNumber, hiosId, deductible, oopMax, metalTier). Used to replay decisions in Phase 2 fix verification ("would this input now match correctly?").';

COMMENT ON COLUMN canonical_match_decisions.reason IS
  'Human-readable reason for this step outcome (e.g., "plan_year filter zero candidates", "fuzzy top 0.65 below 0.7 threshold", "group_number exact match"). Populated by canonical-match-telemetry helper per exit path.';

COMMIT;
