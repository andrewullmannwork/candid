-- Migration 040: Candid Care provider enrichment + pricing infrastructure
-- Phase 3A of Paid Candid Claim

-- 1. Extend providers table with NPPES and display data
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS address_city TEXT,
  ADD COLUMN IF NOT EXISTS address_state TEXT,
  ADD COLUMN IF NOT EXISTS address_zip TEXT,
  ADD COLUMN IF NOT EXISTS specialty TEXT,
  ADD COLUMN IF NOT EXISTS organization_name TEXT,
  ADD COLUMN IF NOT EXISTS nppes_updated_at TIMESTAMPTZ;

-- 2. candid_care_live feature flag
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES ('candid_care_live', false, 'Live Candid Care pricing UI (replaces placeholder)', 'global')
ON CONFLICT (flag_key) DO NOTHING;
