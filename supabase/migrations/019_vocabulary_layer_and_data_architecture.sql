-- Migration 019: Vocabulary Mapping Layer & Data Architecture
-- Implements OMOP-inspired concept graph, canonical plans, providers, claims, outcomes
-- All CREATE TABLE and ADD COLUMN use IF NOT EXISTS for safety

-- ============================================================================
-- PART 1: VOCABULARY MAPPING LAYER
-- ============================================================================

-- 1A. Vocabularies — registry of code systems
CREATE TABLE IF NOT EXISTS vocabularies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vocabulary_id TEXT UNIQUE NOT NULL,          -- e.g., 'CANDID', 'CPT', 'HCPCS'
    vocabulary_name TEXT NOT NULL,
    vocabulary_version TEXT,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1B. Concepts — every term from every vocabulary
CREATE TABLE IF NOT EXISTS concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vocabulary_id TEXT NOT NULL REFERENCES vocabularies(vocabulary_id),
    concept_code TEXT NOT NULL,                  -- e.g., 'pcp_visit', '99213', 'J3490'
    concept_name TEXT NOT NULL,                  -- human-readable name
    concept_class TEXT NOT NULL,                 -- 'category', 'service', 'procedure', 'drug', 'diagnosis', 'scenario'
    domain TEXT NOT NULL DEFAULT 'service',      -- 'service', 'drug', 'diagnosis', 'billing'
    valid_start_date DATE DEFAULT CURRENT_DATE,
    valid_end_date DATE DEFAULT '2099-12-31',
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(vocabulary_id, concept_code)
);

-- 1C. Concept Relationships — directed edges between concepts
CREATE TABLE IF NOT EXISTS concept_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id_1 UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    concept_id_2 UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,             -- 'maps_to', 'is_a', 'has_component', 'replaces', 'sbc_includes'
    is_active BOOLEAN DEFAULT TRUE,
    valid_start_date DATE DEFAULT CURRENT_DATE,
    valid_end_date DATE DEFAULT '2099-12-31',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(concept_id_1, concept_id_2, relationship_type)
);

-- 1D. Concept Ancestors — precomputed transitive closure for fast rollup
CREATE TABLE IF NOT EXISTS concept_ancestors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ancestor_concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    descendant_concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    min_levels_of_separation INTEGER NOT NULL DEFAULT 0,
    max_levels_of_separation INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ancestor_concept_id, descendant_concept_id)
);

-- 1E. Concept Synonyms — user-facing search aliases
CREATE TABLE IF NOT EXISTS concept_synonyms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    synonym_name TEXT NOT NULL,
    language_code TEXT DEFAULT 'en',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PART 2: CANONICAL PLANS
-- ============================================================================

-- 2A. Canonical Plans — shared plan definitions across users
CREATE TABLE IF NOT EXISTS canonical_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insurer_id UUID REFERENCES insurer_catalog(id),
    plan_name TEXT NOT NULL,
    plan_type TEXT,                              -- 'PPO', 'HMO', 'EPO', 'HDHP', 'POS'
    state TEXT,                                  -- 2-letter state code
    plan_year INTEGER,
    group_number TEXT,
    hios_id TEXT,                                -- CMS marketplace ID
    metal_level TEXT,                            -- 'bronze', 'silver', 'gold', 'platinum'
    deductible_individual NUMERIC,
    deductible_family NUMERIC,
    oop_max_individual NUMERIC,
    oop_max_family NUMERIC,
    premium_monthly NUMERIC,
    confidence_score NUMERIC DEFAULT 0.5,        -- 0-1, increases with more sources
    source_count INTEGER DEFAULT 1,
    raw_coverage_data JSONB DEFAULT '{}',
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2B. Canonical Plan Services — coverage terms per canonical plan
CREATE TABLE IF NOT EXISTS canonical_plan_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
    concept_id UUID REFERENCES concepts(id),
    service_slug TEXT,                           -- FK to service_catalog for backward compat
    copay NUMERIC,
    coinsurance NUMERIC,                         -- as decimal, e.g., 0.20 for 20%
    is_covered BOOLEAN DEFAULT TRUE,
    requires_prior_auth BOOLEAN DEFAULT FALSE,
    requires_referral BOOLEAN DEFAULT FALSE,
    deductible_applies BOOLEAN DEFAULT TRUE,
    annual_limit INTEGER,
    visit_limit INTEGER,
    coverage_rules JSONB DEFAULT '{}',           -- flexible rules before promotion to columns
    confidence NUMERIC DEFAULT 0.5,
    source TEXT,                                 -- 'sbc_parser', 'user_upload', 'cms_api', 'admin'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2C. Plan Formulary — drug coverage per plan
CREATE TABLE IF NOT EXISTS plan_formulary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
    concept_id UUID REFERENCES concepts(id),     -- drug concept (NDC/HCPCS)
    drug_name TEXT NOT NULL,
    tier INTEGER,                                -- 1=preferred generic, 2=generic, 3=preferred brand, 4=brand, 5=specialty
    requires_prior_auth BOOLEAN DEFAULT FALSE,
    step_therapy_required BOOLEAN DEFAULT FALSE,
    quantity_limit TEXT,
    copay NUMERIC,
    coinsurance NUMERIC,
    is_covered BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2D. Plan Type Rules — IRS/CMS regulatory limits
CREATE TABLE IF NOT EXISTS plan_type_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_type TEXT NOT NULL,                     -- 'HDHP', 'PPO', 'HMO', etc.
    plan_year INTEGER NOT NULL,
    rule_name TEXT NOT NULL,                     -- 'hsa_contribution_individual', 'oop_max_family', etc.
    rule_value NUMERIC NOT NULL,
    rule_unit TEXT DEFAULT 'USD',                -- 'USD', 'percent', 'count'
    source TEXT NOT NULL,                        -- 'IRS', 'CMS', 'ACA'
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(plan_type, plan_year, rule_name)
);

-- ============================================================================
-- PART 3: PROVIDERS
-- ============================================================================

-- 3A. Providers — hospitals, clinics, physician groups
CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    npi TEXT UNIQUE,                             -- National Provider Identifier (10 digits)
    provider_type TEXT,                          -- 'hospital', 'clinic', 'urgent_care', 'physician_group', 'pharmacy', 'lab'
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    phone TEXT,
    health_system TEXT,                          -- parent system, e.g., "HCA Healthcare"
    latitude NUMERIC,
    longitude NUMERIC,
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3B. Provider Networks — which providers are in which plan's network
CREATE TABLE IF NOT EXISTS provider_networks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
    network_tier TEXT NOT NULL DEFAULT 'in_network',  -- 'in_network', 'out_of_network', 'tier1', 'tier2'
    effective_date DATE,
    termination_date DATE,
    source TEXT,                                 -- 'plan_document', 'cms_api', 'user_report'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PART 4: CLAIMS
-- ============================================================================

-- 4A. Claims — encounter-level billing records
CREATE TABLE IF NOT EXISTS claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    insurance_plan_id UUID REFERENCES insurance_plans(id),
    provider_id UUID REFERENCES providers(id),
    date_of_service DATE,
    place_of_service TEXT,                       -- 'office', 'outpatient', 'inpatient', 'emergency', 'telehealth'
    total_billed NUMERIC,
    total_allowed NUMERIC,
    total_insurance_paid NUMERIC,
    total_patient_responsibility NUMERIC,
    diagnosis_codes TEXT[] DEFAULT '{}',          -- ICD-10 codes
    source_document_id UUID REFERENCES documents(id),
    claim_number TEXT,                           -- insurer's claim reference number
    status TEXT DEFAULT 'processed',             -- 'pending', 'processed', 'denied', 'appealed'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4B. Claim Line Items — per-charge billing detail
CREATE TABLE IF NOT EXISTS claim_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    line_number INTEGER,
    concept_id UUID REFERENCES concepts(id),     -- the procedure/service concept
    billing_code TEXT,                           -- raw code, e.g., '99213'
    billing_code_type TEXT,                      -- 'CPT', 'HCPCS', 'NDC', 'REV', 'DRG'
    service_slug TEXT,                           -- denormalized FK to service_catalog for rollups
    description TEXT,                            -- plain-English line item description
    units NUMERIC DEFAULT 1,
    billed_amount NUMERIC,
    allowed_amount NUMERIC,
    insurance_paid NUMERIC,
    patient_owes NUMERIC,
    adjustment_reason_code TEXT,                 -- CARC/RARC code
    adjustment_reason_description TEXT,
    modifier_codes TEXT[] DEFAULT '{}',          -- billing modifiers (-25, -59, etc.)
    place_of_service_code TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PART 5: OUTCOMES
-- ============================================================================

-- 5A. Dispute Outcomes — results of billing disputes
CREATE TABLE IF NOT EXISTS dispute_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_line_item_id UUID REFERENCES claim_line_items(id) ON DELETE SET NULL,
    claim_id UUID REFERENCES claims(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dispute_type TEXT NOT NULL,                  -- 'internal_appeal', 'external_appeal', 'complaint', 'legal', 'negotiation'
    status TEXT NOT NULL DEFAULT 'filed',        -- 'filed', 'in_progress', 'won', 'lost', 'settled', 'withdrawn'
    amount_disputed NUMERIC,
    amount_recovered NUMERIC,
    filed_date DATE,
    resolution_date DATE,
    insurer_id UUID REFERENCES insurer_catalog(id),
    concept_id UUID REFERENCES concepts(id),     -- what service/procedure was disputed
    strategy_notes TEXT,
    evidence_summary TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PART 6: ALTER EXISTING TABLES
-- ============================================================================

-- 6A. Add concept_id to service_catalog
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS concept_id UUID REFERENCES concepts(id);

-- 6B. Add canonical_plan_id to insurance_plans
ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS canonical_plan_id UUID REFERENCES canonical_plans(id);

-- 6C. Add concept_id to plan_covered_services
ALTER TABLE plan_covered_services ADD COLUMN IF NOT EXISTS concept_id UUID REFERENCES concepts(id);

-- ============================================================================
-- PART 7: INDEXES
-- ============================================================================

-- Vocabulary layer indexes
CREATE INDEX IF NOT EXISTS idx_concepts_vocabulary_id ON concepts(vocabulary_id);
CREATE INDEX IF NOT EXISTS idx_concepts_concept_code ON concepts(concept_code);
CREATE INDEX IF NOT EXISTS idx_concepts_concept_class ON concepts(concept_class);
CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concepts(domain);
CREATE INDEX IF NOT EXISTS idx_concepts_is_active ON concepts(is_active);
CREATE INDEX IF NOT EXISTS idx_concept_relationships_concept_1 ON concept_relationships(concept_id_1);
CREATE INDEX IF NOT EXISTS idx_concept_relationships_concept_2 ON concept_relationships(concept_id_2);
CREATE INDEX IF NOT EXISTS idx_concept_relationships_type ON concept_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_concept_ancestors_ancestor ON concept_ancestors(ancestor_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_ancestors_descendant ON concept_ancestors(descendant_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_synonyms_concept ON concept_synonyms(concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_synonyms_name ON concept_synonyms(synonym_name);

-- Plan indexes
CREATE INDEX IF NOT EXISTS idx_canonical_plans_insurer ON canonical_plans(insurer_id);
CREATE INDEX IF NOT EXISTS idx_canonical_plans_type_year ON canonical_plans(plan_type, plan_year);
CREATE INDEX IF NOT EXISTS idx_canonical_plans_state ON canonical_plans(state);
CREATE INDEX IF NOT EXISTS idx_canonical_plans_hios ON canonical_plans(hios_id);
CREATE INDEX IF NOT EXISTS idx_canonical_plan_services_plan ON canonical_plan_services(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_canonical_plan_services_concept ON canonical_plan_services(concept_id);
CREATE INDEX IF NOT EXISTS idx_plan_formulary_plan ON plan_formulary(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_formulary_concept ON plan_formulary(concept_id);
CREATE INDEX IF NOT EXISTS idx_plan_type_rules_type_year ON plan_type_rules(plan_type, plan_year);

-- Provider indexes
CREATE INDEX IF NOT EXISTS idx_providers_npi ON providers(npi);
CREATE INDEX IF NOT EXISTS idx_providers_state ON providers(state);
CREATE INDEX IF NOT EXISTS idx_providers_type ON providers(provider_type);
CREATE INDEX IF NOT EXISTS idx_providers_zip ON providers(zip);
CREATE INDEX IF NOT EXISTS idx_provider_networks_provider ON provider_networks(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_networks_plan ON provider_networks(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_provider_networks_tier ON provider_networks(network_tier);

-- Claims indexes
CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id);
CREATE INDEX IF NOT EXISTS idx_claims_plan ON claims(insurance_plan_id);
CREATE INDEX IF NOT EXISTS idx_claims_provider ON claims(provider_id);
CREATE INDEX IF NOT EXISTS idx_claims_date ON claims(date_of_service);
CREATE INDEX IF NOT EXISTS idx_claims_document ON claims(source_document_id);
CREATE INDEX IF NOT EXISTS idx_claim_line_items_claim ON claim_line_items(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_line_items_concept ON claim_line_items(concept_id);
CREATE INDEX IF NOT EXISTS idx_claim_line_items_billing_code ON claim_line_items(billing_code, billing_code_type);
CREATE INDEX IF NOT EXISTS idx_claim_line_items_service_slug ON claim_line_items(service_slug);

-- Outcomes indexes
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_claim_line ON dispute_outcomes(claim_line_item_id);
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_claim ON dispute_outcomes(claim_id);
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_user ON dispute_outcomes(user_id);
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_status ON dispute_outcomes(status);
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_insurer ON dispute_outcomes(insurer_id);
CREATE INDEX IF NOT EXISTS idx_dispute_outcomes_concept ON dispute_outcomes(concept_id);

-- FK indexes on altered tables
CREATE INDEX IF NOT EXISTS idx_service_catalog_concept ON service_catalog(concept_id);
CREATE INDEX IF NOT EXISTS idx_insurance_plans_canonical ON insurance_plans(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_covered_services_concept ON plan_covered_services(concept_id);

-- ============================================================================
-- PART 8: SEED DATA
-- ============================================================================

-- 8A. Seed vocabularies
INSERT INTO vocabularies (vocabulary_id, vocabulary_name, description) VALUES
    ('CANDID', 'Candid Internal', 'Candid platform service slugs and categories'),
    ('CPT', 'Current Procedural Terminology', 'AMA procedure codes — descriptions require license'),
    ('HCPCS', 'Healthcare Common Procedure Coding System', 'CMS supply and drug codes'),
    ('NDC', 'National Drug Code', 'FDA drug identifier'),
    ('SBC', 'Summary of Benefits and Coverage', 'ACA-mandated plan scenario descriptions'),
    ('ICD10', 'International Classification of Diseases 10th Revision', 'WHO/CMS diagnosis codes'),
    ('DRG', 'Diagnosis Related Group', 'CMS inpatient episode groupings'),
    ('REV', 'Revenue Code', 'UB-04 revenue codes for facility billing')
ON CONFLICT (vocabulary_id) DO NOTHING;

-- 8B. Seed CANDID concepts from existing service_catalog
-- Categories first
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain)
SELECT DISTINCT
    'CANDID',
    category,
    INITCAP(REPLACE(category, '_', ' ')),
    'category',
    'service'
FROM service_catalog
WHERE category IS NOT NULL
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- Services from service_catalog
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain)
SELECT
    'CANDID',
    slug,
    name,
    'service',
    'service'
FROM service_catalog
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 8C. Build is_a relationships between CANDID services and their categories
INSERT INTO concept_relationships (concept_id_1, concept_id_2, relationship_type)
SELECT
    svc.id AS concept_id_1,    -- the service
    cat.id AS concept_id_2,    -- the category
    'is_a'
FROM service_catalog sc
JOIN concepts svc ON svc.vocabulary_id = 'CANDID' AND svc.concept_code = sc.slug AND svc.concept_class = 'service'
JOIN concepts cat ON cat.vocabulary_id = 'CANDID' AND cat.concept_code = sc.category AND cat.concept_class = 'category'
ON CONFLICT (concept_id_1, concept_id_2, relationship_type) DO NOTHING;

-- 8D. Build ancestor table entries for direct category->service relationships
INSERT INTO concept_ancestors (ancestor_concept_id, descendant_concept_id, min_levels_of_separation, max_levels_of_separation)
SELECT
    cat.id,
    svc.id,
    1,
    1
FROM service_catalog sc
JOIN concepts svc ON svc.vocabulary_id = 'CANDID' AND svc.concept_code = sc.slug AND svc.concept_class = 'service'
JOIN concepts cat ON cat.vocabulary_id = 'CANDID' AND cat.concept_code = sc.category AND cat.concept_class = 'category'
ON CONFLICT (ancestor_concept_id, descendant_concept_id) DO NOTHING;

-- Self-referencing ancestor entries (every concept is its own ancestor at distance 0)
INSERT INTO concept_ancestors (ancestor_concept_id, descendant_concept_id, min_levels_of_separation, max_levels_of_separation)
SELECT id, id, 0, 0
FROM concepts
WHERE vocabulary_id = 'CANDID'
ON CONFLICT (ancestor_concept_id, descendant_concept_id) DO NOTHING;

-- 8E. Seed SBC scenario concepts
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
    ('SBC', 'having_a_baby', 'Having a Baby (Normal Delivery)', 'scenario', 'service'),
    ('SBC', 'having_a_baby_complications', 'Having a Baby (Complications)', 'scenario', 'service'),
    ('SBC', 'managing_type_2_diabetes', 'Managing Type 2 Diabetes', 'scenario', 'service'),
    ('SBC', 'simple_fracture', 'Treatment of a Simple Fracture', 'scenario', 'service'),
    ('SBC', 'breast_cancer_treatment', 'Breast Cancer Initial Treatment', 'scenario', 'service'),
    ('SBC', 'home_health_care', 'Home Health Care', 'scenario', 'service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 8F. Seed plan_type_rules with 2025 and 2026 IRS/CMS limits
INSERT INTO plan_type_rules (plan_type, plan_year, rule_name, rule_value, rule_unit, source, description) VALUES
    -- 2025 HDHP / HSA limits (IRS Rev. Proc. 2024-25)
    ('HDHP', 2025, 'min_deductible_individual', 1650, 'USD', 'IRS', 'Minimum annual deductible for self-only HDHP'),
    ('HDHP', 2025, 'min_deductible_family', 3300, 'USD', 'IRS', 'Minimum annual deductible for family HDHP'),
    ('HDHP', 2025, 'oop_max_individual', 8300, 'USD', 'IRS', 'Maximum OOP for self-only HDHP'),
    ('HDHP', 2025, 'oop_max_family', 16600, 'USD', 'IRS', 'Maximum OOP for family HDHP'),
    ('HDHP', 2025, 'hsa_contribution_individual', 4300, 'USD', 'IRS', 'HSA contribution limit for self-only'),
    ('HDHP', 2025, 'hsa_contribution_family', 8550, 'USD', 'IRS', 'HSA contribution limit for family'),
    ('HDHP', 2025, 'hsa_catch_up_55_plus', 1000, 'USD', 'IRS', 'Additional HSA contribution for age 55+'),
    -- 2025 ACA OOP maximums (all plan types)
    ('PPO', 2025, 'aca_oop_max_individual', 9200, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('PPO', 2025, 'aca_oop_max_family', 18400, 'USD', 'CMS', 'ACA maximum OOP for family'),
    ('HMO', 2025, 'aca_oop_max_individual', 9200, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('HMO', 2025, 'aca_oop_max_family', 18400, 'USD', 'CMS', 'ACA maximum OOP for family'),
    ('EPO', 2025, 'aca_oop_max_individual', 9200, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('EPO', 2025, 'aca_oop_max_family', 18400, 'USD', 'CMS', 'ACA maximum OOP for family'),
    -- 2026 HDHP / HSA limits (IRS Rev. Proc. 2025-19)
    ('HDHP', 2026, 'min_deductible_individual', 1700, 'USD', 'IRS', 'Minimum annual deductible for self-only HDHP'),
    ('HDHP', 2026, 'min_deductible_family', 3400, 'USD', 'IRS', 'Minimum annual deductible for family HDHP'),
    ('HDHP', 2026, 'oop_max_individual', 8500, 'USD', 'IRS', 'Maximum OOP for self-only HDHP'),
    ('HDHP', 2026, 'oop_max_family', 17000, 'USD', 'IRS', 'Maximum OOP for family HDHP'),
    ('HDHP', 2026, 'hsa_contribution_individual', 4400, 'USD', 'IRS', 'HSA contribution limit for self-only'),
    ('HDHP', 2026, 'hsa_contribution_family', 8750, 'USD', 'IRS', 'HSA contribution limit for family'),
    ('HDHP', 2026, 'hsa_catch_up_55_plus', 1000, 'USD', 'IRS', 'Additional HSA contribution for age 55+'),
    -- 2026 ACA OOP maximums
    ('PPO', 2026, 'aca_oop_max_individual', 9450, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('PPO', 2026, 'aca_oop_max_family', 18900, 'USD', 'CMS', 'ACA maximum OOP for family'),
    ('HMO', 2026, 'aca_oop_max_individual', 9450, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('HMO', 2026, 'aca_oop_max_family', 18900, 'USD', 'CMS', 'ACA maximum OOP for family'),
    ('EPO', 2026, 'aca_oop_max_individual', 9450, 'USD', 'CMS', 'ACA maximum OOP for self-only'),
    ('EPO', 2026, 'aca_oop_max_family', 18900, 'USD', 'CMS', 'ACA maximum OOP for family')
ON CONFLICT (plan_type, plan_year, rule_name) DO NOTHING;

-- 8G. Backfill concept_id on service_catalog
UPDATE service_catalog
SET concept_id = c.id
FROM concepts c
WHERE c.vocabulary_id = 'CANDID'
  AND c.concept_code = service_catalog.slug
  AND c.concept_class = 'service'
  AND service_catalog.concept_id IS NULL;
