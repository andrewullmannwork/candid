-- Migration 063: Per-field source provenance + Pattern P-8 citation storage on insurance_plans.
-- Per plans/phase_3.2.1_field_provenance_persistence.md Q-P3.2.1-2 LOCK.
--
-- Closes the gap left at Phase 3.1A + Phase 3.2: SBC + EOC parsers emit per-field
-- patternP8 sub-keys (source_excerpt + source_excerpt_verified + extraction_method +
-- section_hint + section_verified) for plan-identity scalars (deductible, OOP max,
-- plan_name, plan_year, etc.) but the column to land them was never created.
-- Mig 056 added field_provenance to canonical_plan_services + plan_covered_services +
-- claim_line_items only; insurance_plans was excluded then because plan-identity
-- writes happened via legacy regex paths that didn't emit Pattern P-8 sub-keys.
--
-- Now that both parsers (Phase 3.1A.1 + Phase 3.2) produce Pattern P-8 in-memory,
-- this column lets Phase 4 dispute letter cite plan-identity fields verbatim.
--
-- Additive schema; no rollback needed. Default empty object so existing reads/writes
-- are unaffected. NO trigger — preserves existing insurance_plans.confidence semantics
-- (driven by source + source_provenance columns from prior phases, not by per-field
-- MIN aggregation like canonical_plan_services + plan_covered_services).

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN insurance_plans.field_provenance IS
  'DR-3B per-field confidence + Pattern P-8 source provenance for plan-identity fields (deductible, OOP max, plan_name, plan_year, plan_type, network markers). Shape mirrors canonical_plan_services.field_provenance per buildProvenanceEntry. NO trigger — insurance_plans.confidence retains its existing source-rank semantics independent of field_provenance MIN. Phase 4 consumer-read filters on source_excerpt_verified for citation-grade dispute letter renders. Phase 5 may promote frequently-cited keys to typed columns.';
