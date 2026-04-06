-- Migration 016: Add chunked processing columns + missing enum values
-- Enables self-chaining document processing that works within Vercel's 10s function timeout.

-- Add missing enum values (these were used in code but never migrated)
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'pending_review';
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS processing_step TEXT,
  ADD COLUMN IF NOT EXISTS processing_total_pages INTEGER,
  ADD COLUMN IF NOT EXISTS processing_completed_pages INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_ocr_text TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_error TEXT;

-- Note: Partial index on status IN ('queued', 'processing') can be added
-- in a subsequent migration after the enum values are committed.
