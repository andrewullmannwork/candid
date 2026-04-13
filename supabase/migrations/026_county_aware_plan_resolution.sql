-- Migration 026: County-Aware Plan Resolution
-- Adds profile address/county fields, plan_catalog↔canonical_plans mapping table,
-- and hios_id on insurance_plans for county-specific premium resolution.

-- 1. Profile address fields
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS zip_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS county_fips TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS county_name TEXT;

-- 2. plan_catalog ↔ canonical_plans mapping table
-- Allows reverse lookup: canonical_plan → all county variant plan_catalog entries
CREATE TABLE IF NOT EXISTS plan_catalog_canonical_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_catalog_id UUID NOT NULL REFERENCES plan_catalog(id) ON DELETE CASCADE,
    canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (plan_catalog_id, canonical_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_pccm_canonical ON plan_catalog_canonical_map(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_pccm_catalog ON plan_catalog_canonical_map(plan_catalog_id);

-- 3. hios_id on insurance_plans (links user enrollment to a specific plan variant)
ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS hios_id TEXT;
