-- Migration 015: Update doc_type CHECK constraint to include 'plan_document'
-- Bug: Migration 011 added 'plan_document' to the enum but migration 005's
-- CHECK constraint still only allows ('eob', 'itemized_bill', 'insurance_card', 'sbc', 'other').
-- This causes Plan Doc uploads to fail with "Failed to save document record."

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_doc_type_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_doc_type_check
  CHECK (doc_type IN ('eob', 'itemized_bill', 'insurance_card', 'sbc', 'plan_document', 'other'));
