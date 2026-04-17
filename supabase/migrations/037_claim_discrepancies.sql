-- Migration 037: Claim discrepancies table + feature flag
-- Phase 1A of Paid Candid Claim: three-tier discrepancy detection

-- 1. claim_discrepancies table
CREATE TABLE IF NOT EXISTS claim_discrepancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  claim_line_item_id UUID NOT NULL REFERENCES claim_line_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_slug TEXT NOT NULL,

  -- Discrepancy classification
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  field TEXT NOT NULL CHECK (field IN (
    'copay', 'coinsurance', 'coverage', 'deductible',
    'allowed_amount', 'coverage_status', 'unknown_service',
    'code_substitution', 'other'
  )),

  -- What we expected vs what the bill shows
  expected_value TEXT NOT NULL,
  actual_value TEXT NOT NULL,
  expected_source TEXT NOT NULL CHECK (expected_source IN (
    'user_plan', 'canonical_plan', 'canonical_network',
    'bill_observed', 'audit_rule', 'code_intelligence'
  )),
  expected_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50,

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'flagged' CHECK (status IN (
    'flagged', 'ignored', 'verifying', 'disputed', 'resolved'
  )),

  -- Systemic insurer pattern detection (Phase 1C)
  is_systemic BOOLEAN NOT NULL DEFAULT FALSE,
  systemic_user_count INTEGER,

  -- Resolution
  resolved_dispute_id UUID REFERENCES dispute_outcomes(id),

  -- Flexible metadata (code substitution details, sibling codes, etc.)
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_discrepancies_user ON claim_discrepancies(user_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_claim ON claim_discrepancies(claim_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_status ON claim_discrepancies(status);
CREATE INDEX IF NOT EXISTS idx_discrepancies_tier ON claim_discrepancies(tier);
CREATE INDEX IF NOT EXISTS idx_discrepancies_systemic ON claim_discrepancies(is_systemic) WHERE is_systemic = TRUE;

-- 2. Feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES ('eob_discrepancy_detection', false, 'Three-tier discrepancy detection engine in bill pipeline', 'global')
ON CONFLICT (flag_key) DO NOTHING;
