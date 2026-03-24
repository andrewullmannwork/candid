-- 005_benefit_data_pipeline.sql
-- Adds insurer catalog, plan catalog, plan benefits, and discovery queue
-- for the automated benefit data ingestion pipeline.

-- ── Insurer Catalog ──────────────────────────────────────────────────────────
-- Tracks known insurers and their data ingestion status.

CREATE TABLE IF NOT EXISTS insurer_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  aliases TEXT[] DEFAULT '{}',
  website TEXT,
  mrf_index_url TEXT,
  sbc_search_url TEXT,
  data_status TEXT DEFAULT 'unknown'
    CHECK (data_status IN ('unknown','queued','scraping','extracted','verified','failed')),
  last_scraped_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  verified_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Plan Catalog ─────────────────────────────────────────────────────────────
-- Individual plan data extracted from SBCs / MRFs / user submissions.

CREATE TABLE IF NOT EXISTS plan_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id UUID REFERENCES insurer_catalog(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL,
  plan_type TEXT,
  state TEXT,
  year INTEGER,
  source_url TEXT,
  source_type TEXT CHECK (source_type IN ('mrf','sbc','cms_api','manual','user_submitted')),
  source_document_id UUID REFERENCES documents(id),
  raw_data JSONB,
  data_status TEXT DEFAULT 'extracted'
    CHECK (data_status IN ('extracted','verified','rejected','outdated')),
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Plan Benefits ────────────────────────────────────────────────────────────
-- Specific benefits tied to a plan (replaces static catalog for known plans).

CREATE TABLE IF NOT EXISTS plan_benefits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES plan_catalog(id) ON DELETE CASCADE,
  benefit_category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  coverage_details TEXT,
  copay_amount NUMERIC,
  coinsurance_pct NUMERIC,
  frequency_limit TEXT,
  prior_auth_required BOOLEAN DEFAULT false,
  hsa_fsa_eligible BOOLEAN DEFAULT false,
  how_to_access TEXT,
  plan_document_reference TEXT,
  data_status TEXT DEFAULT 'extracted'
    CHECK (data_status IN ('extracted','verified','rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Discovery Queue ──────────────────────────────────────────────────────────
-- Triggered when a user enters an insurer not in the catalog.

CREATE TABLE IF NOT EXISTS insurer_discovery_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_name_raw TEXT NOT NULL,
  requested_by UUID REFERENCES users(id),
  source TEXT DEFAULT 'profile'
    CHECK (source IN ('profile','insurance_card','user_submitted','manual')),
  source_document_id UUID REFERENCES documents(id),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  matched_insurer_id UUID REFERENCES insurer_catalog(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_insurer_catalog_name
  ON insurer_catalog USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_plan_catalog_insurer
  ON plan_catalog(insurer_id);
CREATE INDEX IF NOT EXISTS idx_plan_benefits_plan
  ON plan_benefits(plan_id);
CREATE INDEX IF NOT EXISTS idx_discovery_queue_status
  ON insurer_discovery_queue(status);
CREATE INDEX IF NOT EXISTS idx_discovery_queue_created
  ON insurer_discovery_queue(created_at DESC);

-- ── Add 'sbc' to doc_type check on documents table ──────────────────────────
-- Allow users to upload SBC/plan documents alongside EOBs and bills.

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_doc_type_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_doc_type_check
  CHECK (doc_type IN ('eob', 'itemized_bill', 'insurance_card', 'sbc', 'other'));

-- ── Seed top insurers ────────────────────────────────────────────────────────

INSERT INTO insurer_catalog (name, aliases, website, sbc_search_url) VALUES
  ('UnitedHealthcare', ARRAY['UHC','United Health','United Healthcare','United Health Care','UnitedHealth Group'], 'https://www.uhc.com', 'https://www.uhc.com/find-a-plan'),
  ('Anthem / Blue Cross Blue Shield', ARRAY['Anthem','BCBS','Blue Cross','Blue Shield','Anthem BCBS','Blue Cross Blue Shield','Anthem BlueCross','Elevance Health'], 'https://www.anthem.com', 'https://www.anthem.com/find-a-plan'),
  ('Aetna', ARRAY['Aetna','CVS Health','Aetna CVS'], 'https://www.aetna.com', 'https://www.aetna.com/individuals-families/find-a-plan.html'),
  ('Cigna', ARRAY['Cigna','Cigna Healthcare','The Cigna Group','Evernorth'], 'https://www.cigna.com', 'https://www.cigna.com/individuals-families/member-resources/plan-documents'),
  ('Humana', ARRAY['Humana','Humana Inc'], 'https://www.humana.com', 'https://www.humana.com/finder/medical'),
  ('Kaiser Permanente', ARRAY['Kaiser','KP','Kaiser Permanent'], 'https://www.kaiserpermanente.org', 'https://healthy.kaiserpermanente.org/get-care/explore-benefits'),
  ('Molina Healthcare', ARRAY['Molina','Molina Health'], 'https://www.molinahealthcare.com', NULL),
  ('Oscar Health', ARRAY['Oscar','Oscar Insurance'], 'https://www.hioscar.com', 'https://www.hioscar.com/individuals'),
  ('Centene', ARRAY['Centene','Centene Corp','WellCare','Ambetter','Health Net'], 'https://www.centene.com', NULL),
  ('HCSC', ARRAY['Health Care Service Corporation','BCBS Illinois','BCBS Texas','BCBS Montana','BCBS Oklahoma','BCBS New Mexico'], 'https://www.hcsc.com', NULL),
  ('Highmark', ARRAY['Highmark','Highmark BCBS','Highmark Blue Cross Blue Shield','Highmark Health'], 'https://www.highmark.com', NULL),
  ('Independence Blue Cross', ARRAY['IBX','Independence','Independence Health Group'], 'https://www.ibx.com', NULL),
  ('CareFirst', ARRAY['CareFirst','CareFirst BCBS','CareFirst BlueCross BlueShield'], 'https://www.carefirst.com', NULL),
  ('Regence', ARRAY['Regence','Regence BCBS','Regence BlueCross BlueShield'], 'https://www.regence.com', NULL),
  ('Florida Blue', ARRAY['Florida Blue','Blue Cross Blue Shield of Florida','BCBS Florida','BCBSFL'], 'https://www.floridablue.com', NULL),
  ('Horizon BCBS', ARRAY['Horizon','Horizon Blue Cross','Horizon Blue Cross Blue Shield of New Jersey','BCBS NJ'], 'https://www.horizonblue.com', NULL),
  ('Blue Cross NC', ARRAY['Blue Cross North Carolina','BCBS NC','BCBSNC','Blue Cross and Blue Shield of North Carolina'], 'https://www.bluecrossnc.com', NULL),
  ('Priority Health', ARRAY['Priority','Priority Health Plan'], 'https://www.priorityhealth.com', NULL),
  ('Medica', ARRAY['Medica','Medica Health Plans'], 'https://www.medica.com', NULL),
  ('Harvard Pilgrim', ARRAY['Harvard Pilgrim','Harvard Pilgrim Health Care','Point32Health'], 'https://www.harvardpilgrim.org', NULL)
ON CONFLICT (name) DO NOTHING;
