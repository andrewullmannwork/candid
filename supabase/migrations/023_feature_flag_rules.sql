-- Migration 023: Product feature flag rules with user targeting
-- Separate from system feature_flags table (processing controls)
-- This table manages user-visible product features with rollout targeting

CREATE TABLE IF NOT EXISTS feature_flag_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  -- Targeting
  target_type TEXT NOT NULL DEFAULT 'global'
    CHECK (target_type IN ('global', 'users', 'percentage')),
  target_users TEXT[] DEFAULT '{}',
  target_percentage INT DEFAULT 100
    CHECK (target_percentage >= 0 AND target_percentage <= 100),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_rules_key ON feature_flag_rules(flag_key);

-- Seed initial product feature flags
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type) VALUES
  ('candid_plan_v2', false, 'New plan page redesign', 'global'),
  ('canonical_plans', false, 'Canonical plan matching and shared data', 'global'),
  ('dispute_letters', false, 'Paid dispute letter generation', 'global'),
  ('attorney_marketplace', false, 'Candid Case lawyer directory', 'global'),
  ('candid_care', false, 'Price transparency tool', 'global')
ON CONFLICT (flag_key) DO NOTHING;
