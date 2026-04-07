-- Add insurer_mismatch column to documents table
-- Stores comparison result between uploaded plan's insurer and profile's insurance card
ALTER TABLE documents ADD COLUMN IF NOT EXISTS insurer_mismatch JSONB DEFAULT NULL;
