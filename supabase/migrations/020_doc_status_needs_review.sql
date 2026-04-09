-- Add 'needs_review' to doc_status enum for extraction failures
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'needs_review' AFTER 'processed';
