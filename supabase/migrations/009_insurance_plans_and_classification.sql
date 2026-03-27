-- Migration 009: Future-proof plan data architecture
-- Creates: service_catalog, insurance_plans, plan_covered_services, claim_insights
-- Modifies: documents (classification columns), profiles (active plan FK)

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. SERVICE CATALOG — Canonical reference of health care services
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS service_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN (
      'office_visit','emergency','hospital','imaging','lab','rx',
      'therapy','mental_health','maternity','dme','preventive','other'
    )),
  description TEXT,
  is_preventive_eligible BOOLEAN NOT NULL DEFAULT false,

  -- Intelligence columns — updated by audit pipeline over time
  commonly_disputed BOOLEAN NOT NULL DEFAULT false,
  dispute_rate NUMERIC DEFAULT 0,
  misbill_rate NUMERIC DEFAULT 0,
  denial_rate NUMERIC DEFAULT 0,
  avg_overcharge_pct NUMERIC DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_service_catalog_category ON service_catalog(category);
CREATE INDEX idx_service_catalog_slug ON service_catalog(slug);

ALTER TABLE service_catalog ENABLE ROW LEVEL SECURITY;

-- Service catalog is public reference data
CREATE POLICY "service_catalog_public_select" ON service_catalog
  FOR SELECT USING (true);

-- Admin can manage
CREATE POLICY "service_catalog_admin_all" ON service_catalog
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE TRIGGER service_catalog_updated_at
  BEFORE UPDATE ON service_catalog
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. INSURANCE PLANS — User-specific plan enrollment
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS insurance_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- ── Plan Identity ──────────────────────────────────────────────────────────
  plan_name TEXT,
  insurer_name TEXT,
  plan_type TEXT,                          -- HMO, PPO, EPO, POS, HDHP, OAP, etc.
  plan_year INTEGER,
  state TEXT,
  group_number TEXT,
  member_id TEXT,
  coverage_period_start DATE,
  coverage_period_end DATE,
  coverage_tier TEXT                       -- individual, individual_family, family, ee_spouse, ee_children
    CHECK (coverage_tier IS NULL OR coverage_tier IN (
      'individual','individual_family','family','ee_spouse','ee_children'
    )),

  -- ── In-Network Cost Structure ──────────────────────────────────────────────
  in_deductible_individual NUMERIC,
  in_deductible_family NUMERIC,
  in_oop_max_individual NUMERIC,
  in_oop_max_family NUMERIC,
  in_coinsurance_default NUMERIC,          -- e.g. 0.10 means plan pays 90%

  -- ── Out-of-Network Cost Structure ──────────────────────────────────────────
  out_deductible_individual NUMERIC,
  out_deductible_family NUMERIC,
  out_oop_max_individual NUMERIC,
  out_oop_max_family NUMERIC,
  out_coinsurance_default NUMERIC,

  -- ── Premium Breakdown ──────────────────────────────────────────────────────
  premium_total NUMERIC,
  premium_employee NUMERIC,
  premium_employer NUMERIC,
  premium_subsidy NUMERIC,                 -- ACA/government subsidy
  premium_frequency TEXT                   -- monthly, biweekly, per_paycheck, annual
    CHECK (premium_frequency IS NULL OR premium_frequency IN (
      'monthly','biweekly','per_paycheck','annual'
    )),

  -- ── Plan Rules ─────────────────────────────────────────────────────────────
  deductible_calc_method TEXT              -- embedded (each member meets own) vs aggregate (family pool)
    CHECK (deductible_calc_method IS NULL OR deductible_calc_method IN ('embedded','aggregate')),
  combined_medical_rx_oop BOOLEAN,         -- whether medical + Rx share OOP max
  oop_exclusions JSONB,                    -- what doesn't count toward OOP
    -- e.g. ["precert_penalties","premiums","balance_billing","non_covered_services"]
  other_deductibles JSONB,                 -- service-specific deductibles
    -- e.g. {"outpatient_hospital": 200}
  referral_required BOOLEAN,
  network_name TEXT,                       -- e.g. "Open Access Plus"
  mail_order_pharmacy BOOLEAN,
  coordination_type TEXT                   -- primary, secondary, unknown
    CHECK (coordination_type IS NULL OR coordination_type IN ('primary','secondary','unknown')),

  -- ── Claims & Appeals ───────────────────────────────────────────────────────
  timely_filing_days_in INTEGER,
  timely_filing_days_out INTEGER,
  appeals_deadline_days INTEGER,
  external_review_available BOOLEAN,
  claims_timelines JSONB,
    -- e.g. {"preservice_days":15,"preservice_urgent_hours":72,"postservice_days":30,"concurrent_hours":24}
  contact_info JSONB,
    -- e.g. {"phone":"...","website":"...","portal_url":"...","claims_address":"...",
    --        "appeals_address":"...","grievance_email":"...","state_regulator_name":"...",
    --        "state_regulator_phone":"...","nondiscrimination_address":"...","formulary_url":"..."}

  -- ── Administrative / ERISA ─────────────────────────────────────────────────
  admin_info JSONB,
    -- e.g. {"policy_number":"2501764","employer_name":"...","ein":"464716239",
    --        "erisa_plan_number":"501","plan_administrator":"...","plan_administrator_address":"...",
    --        "fiscal_year_end":"06/30","agent_for_legal_process":"..."}

  -- ── Continuation / COBRA ───────────────────────────────────────────────────
  cobra_months INTEGER,
  medical_benefits_extension BOOLEAN,

  -- ── Compliance ─────────────────────────────────────────────────────────────
  minimum_essential_coverage BOOLEAN,
  minimum_value_standard BOOLEAN,

  -- ── Provenance ─────────────────────────────────────────────────────────────
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('sbc_upload','plan_doc_upload','catalog_match','manual','insurance_card')),
  source_document_id UUID REFERENCES documents(id),
  matched_catalog_plan_id UUID REFERENCES plan_catalog(id),
  confidence NUMERIC DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1),

  -- ── Verification ───────────────────────────────────────────────────────────
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','user_confirmed','cms_matched','multi_user_verified')),
  verification_count INTEGER NOT NULL DEFAULT 0,
  cms_match_confidence NUMERIC
    CHECK (cms_match_confidence IS NULL OR (cms_match_confidence >= 0 AND cms_match_confidence <= 1)),

  -- ── Status ─────────────────────────────────────────────────────────────────
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_by_user BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_insurance_plans_user ON insurance_plans(user_id);
CREATE INDEX idx_insurance_plans_active ON insurance_plans(user_id, is_active) WHERE is_active = true;

ALTER TABLE insurance_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insurance_plans_select_own" ON insurance_plans
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "insurance_plans_insert_own" ON insurance_plans
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "insurance_plans_update_own" ON insurance_plans
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "insurance_plans_admin_select" ON insurance_plans
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE TRIGGER insurance_plans_updated_at
  BEFORE UPDATE ON insurance_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. PLAN COVERED SERVICES — Per-service cost sharing (normalized)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS plan_covered_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_plan_id UUID NOT NULL REFERENCES insurance_plans(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,

  -- ── Place of Service ───────────────────────────────────────────────────────
  place_of_service TEXT NOT NULL DEFAULT 'any'
    CHECK (place_of_service IN (
      'pcp_office','specialist_office','outpatient_facility','inpatient_facility',
      'independent_facility','home','virtual','retail_pharmacy',
      'home_delivery_pharmacy','designated_pharmacy','any'
    )),

  -- ── In-Network Cost Sharing ────────────────────────────────────────────────
  in_copay NUMERIC,
  in_coinsurance NUMERIC,                  -- e.g. 0.10 means 10% patient pays
  in_deductible_applies BOOLEAN,
  in_copay_waiver_condition TEXT,          -- e.g. "waived if admitted"
  in_cost_description TEXT,                -- raw text: "$20 copay/visit" or "Plan deductible, then 90%"

  -- ── Out-of-Network Cost Sharing ────────────────────────────────────────────
  out_copay NUMERIC,
  out_coinsurance NUMERIC,
  out_deductible_applies BOOLEAN,
  out_cost_description TEXT,

  -- ── Rules ──────────────────────────────────────────────────────────────────
  oon_paid_at_in_network BOOLEAN DEFAULT false,  -- emergency/air ambulance always at in-network rate
  annual_limit TEXT,                       -- "100 days", "20 visits", "12 visits"
  annual_limit_value INTEGER,              -- numeric value for computation
  prior_auth_required BOOLEAN,
  penalty_no_precert NUMERIC,              -- e.g. 750.00
  covered BOOLEAN NOT NULL DEFAULT true,   -- false = explicitly excluded
  coverage_conditions TEXT,                -- "only for injury to teeth", partial coverage logic
  exclusion_reason TEXT,                   -- why excluded (for dispute logic)

  -- ── Rx-Specific ────────────────────────────────────────────────────────────
  supply_limit_days INTEGER,               -- 30, 90
  home_delivery_copay NUMERIC,
  specialty_pharmacy_required BOOLEAN,
  step_therapy_required BOOLEAN,
  quantity_limit TEXT,                      -- "2 per fill", "1 per month"
  designated_pharmacy_required BOOLEAN,
  ancillary_charge_applies BOOLEAN,        -- extra charge when insisting on brand over generic

  -- ── Other ──────────────────────────────────────────────────────────────────
  multiple_surgery_reduction BOOLEAN,      -- 50% reduction for lesser procedure
  notes TEXT,

  -- ── Provenance ─────────────────────────────────────────────────────────────
  confidence NUMERIC DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('sbc_parsed','plan_doc_parsed','cms_data','manual')),

  created_at TIMESTAMPTZ DEFAULT now(),

  -- Prevent duplicate entries for same service+place on same plan
  UNIQUE(insurance_plan_id, service_id, place_of_service)
);

CREATE INDEX idx_plan_covered_services_plan ON plan_covered_services(insurance_plan_id);
CREATE INDEX idx_plan_covered_services_service ON plan_covered_services(service_id);

ALTER TABLE plan_covered_services ENABLE ROW LEVEL SECURITY;

-- User can access services for their own plans (join through insurance_plans)
CREATE POLICY "plan_covered_services_select_own" ON plan_covered_services
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM insurance_plans ip WHERE ip.id = insurance_plan_id AND ip.user_id = auth.uid())
  );

CREATE POLICY "plan_covered_services_insert_own" ON plan_covered_services
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM insurance_plans ip WHERE ip.id = insurance_plan_id AND ip.user_id = auth.uid())
  );

CREATE POLICY "plan_covered_services_update_own" ON plan_covered_services
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM insurance_plans ip WHERE ip.id = insurance_plan_id AND ip.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM insurance_plans ip WHERE ip.id = insurance_plan_id AND ip.user_id = auth.uid())
  );

CREATE POLICY "plan_covered_services_admin_select" ON plan_covered_services
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. CLAIM INSIGHTS — Aggregate intelligence from audits
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS claim_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES service_catalog(id) ON DELETE CASCADE,
  insurer_name TEXT NOT NULL,

  total_claims_seen INTEGER NOT NULL DEFAULT 0,
  denial_count INTEGER NOT NULL DEFAULT 0,
  overcharge_count INTEGER NOT NULL DEFAULT 0,
  avg_overcharge_amount NUMERIC DEFAULT 0,
  avg_overcharge_pct NUMERIC DEFAULT 0,
  dispute_filed_count INTEGER NOT NULL DEFAULT 0,
  dispute_success_count INTEGER NOT NULL DEFAULT 0,
  most_common_error_type TEXT,

  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(service_id, insurer_name)
);

CREATE INDEX idx_claim_insights_service ON claim_insights(service_id);
CREATE INDEX idx_claim_insights_insurer ON claim_insights(insurer_name);

ALTER TABLE claim_insights ENABLE ROW LEVEL SECURITY;

-- Claim insights are public aggregate data
CREATE POLICY "claim_insights_public_select" ON claim_insights
  FOR SELECT USING (true);

CREATE POLICY "claim_insights_admin_all" ON claim_insights
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE TRIGGER claim_insights_updated_at
  BEFORE UPDATE ON claim_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. DOCUMENT CLASSIFICATION COLUMNS
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE documents ADD COLUMN IF NOT EXISTS classified_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classification_confidence NUMERIC;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classification_signals JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS type_mismatch BOOLEAN DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS linked_insurance_plan_id UUID REFERENCES insurance_plans(id);

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. PROFILE → ACTIVE INSURANCE PLAN LINKAGE
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active_insurance_plan_id UUID REFERENCES insurance_plans(id);
