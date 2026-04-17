-- Migration 041: Small claims court data + preparation
-- Phase 4A of Paid Candid Claim

-- 1. Small claims courts table — 50 states + DC
CREATE TABLE IF NOT EXISTS small_claims_courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  county TEXT,
  dollar_limit_individual NUMERIC(12,2),
  dollar_limit_business NUMERIC(12,2),
  filing_fee_min NUMERIC(8,2),
  filing_fee_max NUMERIC(8,2),
  statute_of_limitations_years INTEGER,
  court_name TEXT,
  court_website TEXT,
  forms_url TEXT,
  attorney_allowed BOOLEAN DEFAULT TRUE,
  notes TEXT,
  last_verified DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(state, county)
);

CREATE INDEX IF NOT EXISTS idx_scc_state ON small_claims_courts(state);

-- 2. Feature flag
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES ('small_claims_prep', false, 'Small claims court preparation UI and evidence compiler', 'global')
ON CONFLICT (flag_key) DO NOTHING;
