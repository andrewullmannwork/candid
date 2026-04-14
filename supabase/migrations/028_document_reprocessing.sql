-- Migration 028: Document Reprocessing Support
-- Adds retry tracking for user-triggered document reprocessing (T0.4)

-- Track how many times a user has retried this document
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
