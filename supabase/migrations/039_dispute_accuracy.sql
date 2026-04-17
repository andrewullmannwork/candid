-- Migration 039: Dispute accuracy scoring + metrics
-- Phase 2B of Paid Candid Claim: tracks success rates per rule, insurer, and service

-- 1. audit_rule_accuracy table — tracks dispute outcomes by rule type
CREATE TABLE IF NOT EXISTS audit_rule_accuracy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type TEXT NOT NULL,
  insurer_name TEXT NOT NULL DEFAULT '',
  service_slug TEXT NOT NULL DEFAULT '',

  -- Counters
  total_disputes INTEGER NOT NULL DEFAULT 0,
  won_count INTEGER NOT NULL DEFAULT 0,
  settled_count INTEGER NOT NULL DEFAULT 0,
  lost_count INTEGER NOT NULL DEFAULT 0,

  -- Financials
  total_recovered NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_recovered_pct NUMERIC(5,2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(rule_type, insurer_name, service_slug)
);

CREATE INDEX IF NOT EXISTS idx_ara_rule ON audit_rule_accuracy(rule_type);
CREATE INDEX IF NOT EXISTS idx_ara_insurer ON audit_rule_accuracy(insurer_name) WHERE insurer_name != '';

-- 2. Provider audit metrics — aggregated per provider from audit findings (feeds Candid Care)
CREATE TABLE IF NOT EXISTS provider_audit_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
  total_bills_analyzed INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  finding_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
  finding_types JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider_id)
);

CREATE INDEX IF NOT EXISTS idx_pam_provider ON provider_audit_metrics(provider_id);
