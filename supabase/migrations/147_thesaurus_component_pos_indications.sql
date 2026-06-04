-- Migration 147: Service Thesaurus — Pattern S schema (place_of_service + component + indications)
-- Phase 0.5 catalog-structure build. ADDITIVE ONLY (Rule #7).
-- SoT: Candid_Data_Patterns "Pattern S" + Hard Rule #17 · service_thesaurus §3.0 · runbook §C.
--
-- SHIPS BUNDLED with mig 148 (catalog data + deterministic transform + apply_promotion_event RPC
-- reconciliation) AND the 4-col onConflict update at src/lib/plan/canonical-match.ts:646 +
-- scripts/wire-plan-catalog-to-canonical.ts:411. Re-keying the unique below REQUIRES every
-- canonical_plan_services upsert to target the 4-col key, or those writes throw
-- "no unique constraint matching the ON CONFLICT specification".
--
-- PRE-LAUNCH: no PROD users. canonical_plan_services = 48,546 cold-start rows (0 NULL service_slug
-- verified). Existing rows take place_of_service='any', component='global' → the new 4-col unique is
-- exactly as unique as the old 2-col key → ZERO collisions on apply. mig 148 then sets specific
-- place_of_service/component per the §D transform; the component split keeps collapsing rows distinct.

-- ── 1. Indication lookup + many-to-many join (Decision 2; mirrors service_categories — no RLS) ──
-- Reference data, backend/seed-populated only (Rule #4/#10). Distinct from the is_preventive_eligible
-- statutory boolean: indications are an open, many-to-many set (a concept may carry several).
CREATE TABLE IF NOT EXISTS service_indications (
  id         TEXT PRIMARY KEY,          -- e.g. 'weight_loss', 'sexual_dysfunction', 'smoking_cessation'
  label      TEXT NOT NULL,
  sort_order INT  DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS concept_indications (
  concept_id    UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  indication_id TEXT NOT NULL REFERENCES service_indications(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (concept_id, indication_id)
);

-- ── 2. canonical_plan_services: add place_of_service + component, then re-key the unique ──
ALTER TABLE canonical_plan_services
  ADD COLUMN IF NOT EXISTS place_of_service TEXT NOT NULL DEFAULT 'any'
    CHECK (place_of_service IN (
      'pcp_office','specialist_office','outpatient_facility','inpatient_facility',
      'independent_facility','home','virtual','retail_pharmacy',
      'home_delivery_pharmacy','designated_pharmacy','any'        -- exact 11 from mig 009; no extension
    )),
  ADD COLUMN IF NOT EXISTS component TEXT NOT NULL DEFAULT 'global'
    CHECK (component IN ('facility','professional','global'));    -- billing-grounded; "professional" not "physician"

ALTER TABLE canonical_plan_services DROP CONSTRAINT IF EXISTS uq_canonical_plan_service;
ALTER TABLE canonical_plan_services
  ADD CONSTRAINT uq_canonical_plan_service
  UNIQUE (canonical_plan_id, service_slug, place_of_service, component);

-- ── 3. claim_line_items: typed component (nullable; bill parser populates later) ──
ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS component TEXT
    CHECK (component IS NULL OR component IN ('facility','professional','global'));

-- ── ROLLBACK (run mig 148's transform-rollback FIRST if 148 has applied; else the 2-col
--    restore below would violate once rows carry distinct place_of_service/component) ──
-- ALTER TABLE claim_line_items DROP COLUMN IF EXISTS component;
-- ALTER TABLE canonical_plan_services DROP CONSTRAINT IF EXISTS uq_canonical_plan_service;
-- ALTER TABLE canonical_plan_services DROP COLUMN IF EXISTS component, DROP COLUMN IF EXISTS place_of_service;
-- ALTER TABLE canonical_plan_services ADD CONSTRAINT uq_canonical_plan_service UNIQUE (canonical_plan_id, service_slug);
-- DROP TABLE IF EXISTS concept_indications;
-- DROP TABLE IF EXISTS service_indications;
