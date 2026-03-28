-- Add employer_name column to insurance_plans
-- This is core identity data (who provides the plan), not just admin metadata
ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS employer_name TEXT;
