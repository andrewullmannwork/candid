-- Migration 036: Claims view UI + benefits utilization + bill/EOB matching
-- Phase 0B of Paid Candid Claim implementation

-- 1. claims_view feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, enabled, target_type, target_value, description)
VALUES ('claims_view', false, 'global', NULL, 'Claims list + detail UI with coverage status and benefits utilization')
ON CONFLICT (flag_key) DO NOTHING;

-- 2. claim_group_id for linking related documents (EOB + bill for same service)
ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS claim_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_claims_group ON claims(claim_group_id) WHERE claim_group_id IS NOT NULL;

-- 3. Benefits utilization tracking on plan_covered_services
ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS last_used_date DATE,
  ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0;
