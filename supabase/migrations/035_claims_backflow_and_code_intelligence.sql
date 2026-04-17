-- Migration 035: Claims backflow + billing code intelligence
-- Phase 0A of Paid Candid Claim implementation

-- 1. Enable claims_persistence globally (was disabled by default)
UPDATE feature_flag_rules
SET enabled = true, updated_at = now()
WHERE flag_key = 'claims_persistence';

-- 2. Add claims_backflow feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, enabled, target_type, target_value, description)
VALUES ('claims_backflow', false, 'global', NULL, 'Bill cost backflow to plan_covered_services and canonical_plan_services')
ON CONFLICT (flag_key) DO NOTHING;

-- 3. Add bill-observed columns to plan_covered_services
ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS bill_observed_cost NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS bill_observed_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bill_observed_source TEXT,
  ADD COLUMN IF NOT EXISTS bill_observed_updated_at TIMESTAMPTZ;

-- 4. Billing code mappings — persistent, community-built code→slug mapping
-- Grows with every bill. Known high-confidence codes skip Haiku in future bills.
CREATE TABLE IF NOT EXISTS billing_code_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_code TEXT NOT NULL,
  billing_code_type TEXT NOT NULL,
  service_slug TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  observation_count INTEGER NOT NULL DEFAULT 1,
  provider_descriptions TEXT[] DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(billing_code, billing_code_type, service_slug)
);

CREATE INDEX IF NOT EXISTS idx_bcm_code
  ON billing_code_mappings(billing_code, billing_code_type);
CREATE INDEX IF NOT EXISTS idx_bcm_slug
  ON billing_code_mappings(service_slug);

-- 5. Billing code plan outcomes — per-code paid/denied tracking per canonical plan
-- Answers: "Is CPT 99214 typically paid on Blue Cross PPO?"
CREATE TABLE IF NOT EXISTS billing_code_plan_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_code TEXT NOT NULL,
  billing_code_type TEXT NOT NULL,
  canonical_plan_id UUID REFERENCES canonical_plans(id) ON DELETE CASCADE,
  total_claims INTEGER NOT NULL DEFAULT 0,
  paid_count INTEGER NOT NULL DEFAULT 0,
  denied_count INTEGER NOT NULL DEFAULT 0,
  avg_paid_amount NUMERIC(12,2),
  avg_billed_amount NUMERIC(12,2),
  common_denial_reasons TEXT[] DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(billing_code, billing_code_type, canonical_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_bcpo_plan
  ON billing_code_plan_outcomes(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_bcpo_code
  ON billing_code_plan_outcomes(billing_code, billing_code_type);
