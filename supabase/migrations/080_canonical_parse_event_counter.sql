-- =============================================================================
-- MIGRATION 080 — Parse-event counter for smart-skip gating (CF-40 — Session 74)
-- =============================================================================
--
-- Adds `canonical_plans.identical_parse_count INT` and invalidates existing
-- canonicals so smart-skip won't fire until the new mechanic is satisfied.
--
-- WHY (S71.5-BADGE-VERIFY user direction Session 74):
--   The pre-CF-40 smart-skip path fires on the FIRST same-hash upload after a
--   canonical exists. Consequences:
--     (a) Smart-skipped users render as Community despite having uploaded a
--         document — display state is wrong.
--     (b) Smart-skipped users write `source='canonical_inherited'` without
--         `source_excerpt_verified='verified'` — the SQL function
--         evaluate_pattern1_corroboration filters them out → they don't count
--         toward Pattern 1 #3 corroboration → canonical never reaches Verified
--         even when many distinct users uploaded.
--
--   The CF-40 fix:
--     - Smart-skip ONLY fires when canonical's `haiku_output_stable=TRUE` AND
--       `identical_parse_count >= 3` (3+ Haiku runs converged on same plan-
--       identity values).
--     - Uploads #1, #2, #3 always run Haiku → cite-grade Pattern P-8 entries
--       on each user's row → counts toward Pattern 1 #3.
--     - Upload #4+ smart-skips (cost optimization) AND user's row gets
--       `source='doc_extraction_smart_skip'` (NEW SourceProvenance value;
--       see field-categories.ts) → renders as User Verified + Community
--       dual-badge per v4 vocabulary.
--
--   See [[Candid_10k]] §3.1 *Display State Achievement & Graduation Rules* §6
--   for the full mechanic codification + [[plans/mvp_friday_master]] §S71.5
--   for the locked-Q1-Q5 design decisions.
--
-- WHAT THIS MIGRATION DOES:
--   1. ADD `canonical_plans.identical_parse_count INT NOT NULL DEFAULT 0`.
--   2. INVALIDATE existing canonicals — UPDATE SET `identical_parse_count=0`,
--      `haiku_output_stable=FALSE` for ALL existing rows. Q-5 user direction:
--      legacy canonicals (mostly populated via mig 064 RPC pattern pre-Phase-
--      4.0.6) must re-prove stability via 3 fresh Haiku runs under the new
--      mechanic. Existing user-side `insurance_plans` rows with
--      `source='canonical_inherited'` continue to render as Community until
--      users re-upload (which triggers fresh Haiku → eventually rebuilds
--      canonical stability).
--
-- BACKOUT:
--   Column drop forbidden per Pattern 1 #10 hard-delete prohibition.
--   Application-layer rollback: revert TS code that consults
--   identical_parse_count + haiku_output_stable in extraction-dedup.ts.
--   Existing data preserved.
-- =============================================================================

BEGIN;

-- ── 1. Add identical_parse_count column ──────────────────────────────────────

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS identical_parse_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN canonical_plans.identical_parse_count IS
  'CF-40 (Session 74). Parse-event stability counter. Incremented by parser code (process-plan.ts / process-eoc.ts / future process-plan_doc.ts) when a Haiku run on this canonical produces plan-identity cost values IDENTICAL to last_haiku_extracted_values snapshot. Resets to 1 when Haiku output diverges (re-baseline). haiku_output_stable flips TRUE when this reaches >= 3 (3 consecutive Haiku runs converged on same values). Smart-skip optimization gates on haiku_output_stable=TRUE.';

-- ── 2. Add last_haiku_extracted_values snapshot column ───────────────────────
-- Stores the most-recent Haiku extraction's plan-identity cost values as JSONB
-- snapshot. Comparison target for the counter increment / reset decision.
-- Distinct from canonical_plans.field_provenance (Phase 4.0.6) which stores
-- promotion-event-derived authoritative values; this is a parser-stability
-- side-channel, not a value-of-record column.

ALTER TABLE canonical_plans
  ADD COLUMN IF NOT EXISTS last_haiku_extracted_values JSONB;

COMMENT ON COLUMN canonical_plans.last_haiku_extracted_values IS
  'CF-40 (Session 74). JSONB snapshot of most-recent Haiku-extracted plan-identity cost values for parse-event stability comparison. Shape: {"in_deductible_individual": N, "in_deductible_family": N, "in_oop_max_individual": N, "in_oop_max_family": N}. Compared on each Haiku run: match -> identical_parse_count++; mismatch -> reset to 1 + overwrite snapshot. NOT a value-of-record column (Pattern 1 #14: canonical writes via promotion only); this is a parser-stability side-channel for smart-skip gating only.';

-- ── 3. Invalidate existing canonicals (Q-5 user direction Session 74) ───────
-- All canonicals shipped pre-CF-40 must re-prove stability via 3 fresh Haiku
-- runs. UPDATE sets identical_parse_count=0 + haiku_output_stable=FALSE so
-- smart-skip won't fire on legacy canonicals.

UPDATE canonical_plans
  SET identical_parse_count = 0,
      haiku_output_stable = FALSE,
      last_haiku_extracted_values = NULL
  WHERE identical_parse_count IS NULL
     OR haiku_output_stable IS TRUE
     OR identical_parse_count > 0
     OR last_haiku_extracted_values IS NOT NULL;

-- ── 3. Add comment to clarify haiku_output_stable's new semantics ─────────────
-- Pre-CF-40: haiku_output_stable flipped TRUE when 3 consecutive
-- document_extraction_log rows had new_services_found=0 (service-set stability).
-- Post-CF-40: haiku_output_stable flips TRUE when identical_parse_count >= 3
-- (plan-identity cost-value stability). Stricter signal — service-set stability
-- can fire even with cost-value drift across plan years.

COMMENT ON COLUMN canonical_plans.haiku_output_stable IS
  'CF-40 (Session 74) — semantic refresh. Boolean stability flag for smart-skip gating. Pre-CF-40: TRUE when last 3 document_extraction_log rows had new_services_found=0 (service-set stability). Post-CF-40: TRUE when canonical_plans.identical_parse_count >= 3 (plan-identity cost-value stability — stricter signal). Renamed from extraction_stable in mig 072. Smart-skip code path (linkDocumentToCanonical in extraction-dedup.ts) consults this; when TRUE, smart-skip fires and writes user row with source=''doc_extraction_smart_skip''. When FALSE, full Haiku parse runs.';

COMMIT;
