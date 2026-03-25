-- Migration 007: CMS Marketplace fields, fuzzy matching, plan demand, SBC tickets
-- Supports the automated SBC database pipeline

-- ── Extend plan_catalog for CMS API data ────────────────────────────────────
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS hios_id TEXT;
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS metal_level TEXT;
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS marketplace_type TEXT; -- 'ffm', 'sbe', 'employer', 'off_exchange'
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS premium_individual NUMERIC;
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS sbc_document_url TEXT;
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS county TEXT;
ALTER TABLE plan_catalog ADD COLUMN IF NOT EXISTS fips_code TEXT;

-- Unique index on hios_id for dedup (partial — only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_catalog_hios_id ON plan_catalog(hios_id) WHERE hios_id IS NOT NULL;

-- ── Extend insurer_catalog for CMS matching ─────────────────────────────────
ALTER TABLE insurer_catalog ADD COLUMN IF NOT EXISTS cms_issuer_id TEXT;
ALTER TABLE insurer_catalog ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- ── Fuzzy matching support ──────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_plan_catalog_name_trgm ON plan_catalog USING gin(plan_name gin_trgm_ops);

-- ── Link users to matched plans ─────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS matched_plan_id UUID REFERENCES plan_catalog(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_source TEXT; -- 'employer', 'marketplace', 'off_exchange', 'medicare', 'medicaid'

-- ── Plan demand tracking (community gap-fill) ───────────────────────────────
CREATE TABLE IF NOT EXISTS plan_demand (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_name TEXT NOT NULL,
  plan_name_raw TEXT,
  plan_type TEXT,
  state TEXT,
  user_count INTEGER DEFAULT 1,
  first_requested_at TIMESTAMPTZ DEFAULT now(),
  last_requested_at TIMESTAMPTZ DEFAULT now(),
  matched_plan_id UUID REFERENCES plan_catalog(id),
  UNIQUE(insurer_name, plan_name_raw, state)
);

-- ── SBC acquisition ticket queue (ops backstop) ─────────────────────────────
CREATE TABLE IF NOT EXISTS sbc_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier INTEGER NOT NULL DEFAULT 2,          -- 1=user-requested, 2=known-gap, 3=stale, 4=sweep
  status TEXT NOT NULL DEFAULT 'pending',    -- pending, in_progress, awaiting_response, received, failed, escalated
  insurer_name TEXT NOT NULL,
  plan_name TEXT,
  hios_id TEXT,
  state TEXT,
  market TEXT,                              -- 'individual', 'group', 'shop'
  group_number TEXT,
  user_request_id UUID,                     -- if user-triggered
  contact_method TEXT,                      -- 'phone', 'email', 'website'
  contact_number TEXT,
  assigned_to TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  escalation_stage INTEGER DEFAULT 0,       -- 0-4 per T3 doc
  notes JSONB DEFAULT '[]'::jsonb,          -- array of {date, text, agent}
  reference_number TEXT,
  follow_up_date DATE,
  resolved_plan_id UUID REFERENCES plan_catalog(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sbc_tickets_status ON sbc_tickets(status);
CREATE INDEX IF NOT EXISTS idx_sbc_tickets_tier ON sbc_tickets(tier);
CREATE INDEX IF NOT EXISTS idx_plan_demand_user_count ON plan_demand(user_count DESC);

-- ── Processing usage tracking (cost protection) ────────────────────────────
CREATE TABLE IF NOT EXISTS processing_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  pages_processed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
