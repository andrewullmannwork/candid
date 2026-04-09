-- Add column to store Haiku-extracted services JSON between processing stages
-- This allows splitting the parse stage (Haiku call) from the save stage (DB writes)
-- to stay within Vercel's 10-second function timeout
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_extracted_services JSONB DEFAULT NULL;
