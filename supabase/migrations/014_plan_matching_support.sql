-- Migration 014: Plan matching support
-- Enables pg_trgm for fuzzy text search, adds trigram indexes on plan and insurer names,
-- adds state_exchange_id for SBE plans, and normalized_name for insurer matching.

-- Enable pg_trgm extension for trigram similarity matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index on plan_catalog.plan_name for fuzzy plan search
CREATE INDEX IF NOT EXISTS idx_plan_catalog_plan_name_trgm
  ON plan_catalog USING gin (plan_name gin_trgm_ops);

-- Trigram index on insurer_catalog.name for fuzzy insurer matching
CREATE INDEX IF NOT EXISTS idx_insurer_catalog_name_trgm
  ON insurer_catalog USING gin (name gin_trgm_ops);

-- State + plan_type composite index for fast filtering before fuzzy match
CREATE INDEX IF NOT EXISTS idx_plan_catalog_state_type
  ON plan_catalog (state, plan_type);

-- State-Based Exchange plan identifier (e.g., Covered California plan ID)
ALTER TABLE plan_catalog
  ADD COLUMN IF NOT EXISTS state_exchange_id TEXT;

-- Normalized insurer name (lowercase, stripped of suffixes like "Inc", "Corp", "Healthcare")
-- Used for fast exact-match lookups before falling back to fuzzy
ALTER TABLE insurer_catalog
  ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- Populate normalized_name from existing names
UPDATE insurer_catalog
SET normalized_name = LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE(name, '\s*(Inc\.?|Corp\.?|LLC|Company|Group|Holdings?)\s*$', '', 'i'),
    '\s+', ' ', 'g'
  )
)
WHERE normalized_name IS NULL;

-- Index on normalized_name for fast lookups
CREATE INDEX IF NOT EXISTS idx_insurer_catalog_normalized_name
  ON insurer_catalog (normalized_name);

-- Index on insurer_catalog aliases array for contains lookups
CREATE INDEX IF NOT EXISTS idx_insurer_catalog_aliases
  ON insurer_catalog USING gin (aliases);
