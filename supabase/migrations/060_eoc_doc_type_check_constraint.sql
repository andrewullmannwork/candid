-- Migration 060: Phase 3.1A — EOC parser readiness (Part 2 of 2).
-- Per plans/phase_3.1A_eoc_parser_and_data_layer_readiness.md Task 3.1A-A.
--
-- This migration updates the documents_doc_type_check CHECK constraint to
-- include 'eoc'. MUST run AFTER mig 059 has committed (separate transaction)
-- because PostgreSQL forbids referencing a newly-added enum value in the same
-- transaction (ERROR 55P04).
--
-- Pattern from mig 015 (which added 'plan_document' to the CHECK list four
-- migrations after mig 011 added the enum value).
--
-- One change:
--   - Update documents_doc_type_check to include 'eoc' alongside existing types
--
-- Defense-in-depth: the doc_type ENUM (added in mig 001, extended by mig 059)
-- already restricts values at the type level. The CHECK constraint provides a
-- second guard at the table level — useful for application-layer validation
-- error messages and for catching schema-vs-application drift.

-- ── Update documents_doc_type_check constraint ──────────────────────────────
ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_doc_type_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_doc_type_check
  CHECK (doc_type IN ('eob', 'itemized_bill', 'insurance_card', 'sbc', 'plan_document', 'eoc', 'other'));
