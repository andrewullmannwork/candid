-- Migration 059: Phase 3.1A — EOC parser readiness (Part 1 of 2).
-- Per plans/phase_3.1A_eoc_parser_and_data_layer_readiness.md Task 3.1A-A.
--
-- This migration adds the 'eoc' enum value AND seeds the eoc_parser_v1 flag.
-- The CHECK constraint update lives in mig 060 because PostgreSQL forbids
-- referencing a newly-added enum value in the same transaction (ERROR 55P04:
-- "unsafe use of new value ... HINT: New enum values must be committed before
-- they can be used"). Splitting matches the historical mig 011 + 015 pattern
-- when 'plan_document' was added.
--
-- Two changes (both must succeed for Phase 3.1A to proceed):
--   1. ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'eoc' (commits before mig 060)
--   2. Seed eoc_parser_v1 feature flag (default OFF, global) per Q-P3.1A-10 LOCK
--
-- NOT in this migration (handled in mig 060):
--   - documents_doc_type_check CHECK constraint update — must run AFTER mig 059
--     commits (separate transaction)
--
-- NOT in this migration (handled in Task 3.1A-C parser code):
--   - SourceProvenance TypeScript enum extension ('doc_extraction_eoc' value)
--   - NEW 'eoc_authoritative' FieldCategory + FIELD_EXCEPTIONS table
--   - 'eoc_upload' value used in insurance_plans.source TEXT column
--
-- NOT in this migration (handled in mig 061):
--   - concept_admin_review_queue table (Task 3.1A-B; requires Design Review)
--
-- Rollback: code revert + flag OFF (no rows have doc_type='eoc' until first new
-- EOC upload under flag ON; enum value addition is forward-compat).

-- ── (1) Add 'eoc' to doc_type enum ──────────────────────────────────────────
-- Pattern from mig 011 (added 'plan_document').
-- MUST be the only statement that touches the enum value in this transaction.
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'eoc';

-- ── (2) Seed eoc_parser_v1 feature flag (default OFF, global) ───────────────
-- Pattern from mig 057 (parse_strategy_v2 flag seed). EOC parser ships with flag
-- OFF; admin smoke-test → flip ON for admin user → 7-day soak → flip global →
-- 30-day soak → drop legacy plan_document fallback for EOC-classified docs in
-- follow-up PR. Per Subplan §Feature flag + rollback.
-- Safe to run alongside ALTER TYPE: this INSERT does NOT reference the new
-- enum value, so it doesn't trigger the 55P04 "unsafe use" check.
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES (
  'eoc_parser_v1',
  false,
  'Phase 3.1A EOC parser — section-by-section Haiku extraction (PA codes, medical necessity criteria, appeals procedures, COB rules, eligibility rules, definitions). Pattern P-8 source provenance + concept_admin_review_queue for unknown codes. OFF = route plan_document and EOC docs through legacy plan-doc-parser (no EOC-specific extraction).',
  'global'
)
ON CONFLICT (flag_key) DO NOTHING;
