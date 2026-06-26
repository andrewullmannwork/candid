-- Migration 182: Service Thesaurus A2b Phase 2 (item 7) — radiation_therapy catalog slug.
-- ADDITIVE ONLY (Rule #7). Mirrors mig 178 (concepts -> service_catalog, canonical_for_concept).
--
-- radiation_therapy (cat 'therapy') — radiation oncology treatment. A PROCEDURE, not a drug (so no
-- '_rx' suffix, unlike chemotherapy_rx). Surfaced by the S230 GT re-adjudication: it was the missing
-- third member of the federal-SBC compound oncology-OPD row ("...treatment of illness or injury,
-- radiation therapy, chemotherapy, and necessary supplies" — emit MULTI=[specialist_visit,
-- chemotherapy_rx, radiation_therapy]) AND the slug for standalone "Radiation therapy" rows (null today).
--
-- NO is_a: flat sibling (no oncology parent concept exists; chemotherapy_rx lives in cat 'rx' as its
-- drug counterpart). Category 'therapy' already passes the mig-148 service_catalog_category_check.
--
-- PRE-LAUNCH, no users. Ship LIVE to PROD (D5); the resolver's compound multi-label rule rides
-- thesaurus_phase1a_v1 (OFF → exposure-held). Andrew Studio-applies the WHOLE file; the trailing SELECT
-- must return 1 row (has_concept=t, canonical=t). (Studio can report "Success" on a comment-only
-- selection — run the entire file and confirm the verify output.)
-- SoT: Candid_Data_Patterns "Pattern S" + Hard Rule #17. Next-free mig after this = 183.

BEGIN;

-- 1. New concept (vocabulary CANDID; class/domain 'service' per the mig-148/178 seed shape).
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  ('CANDID','radiation_therapy','Radiation Therapy','service','service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 2. New service_catalog slug (link concept_id by concept_code=slug; canonical_for_concept=TRUE so the
--    mig-103 enforce_canonical_per_concept trigger is satisfied — one canonical slug per new concept).
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state)
SELECT v.slug, v.name, v.category, v.descr, v.prev, c.id, TRUE, 'canonical'
FROM (VALUES
  ('radiation_therapy','Radiation Therapy','therapy','Radiation oncology treatment (external-beam, brachytherapy); procedure counterpart to chemotherapy_rx',false)
) AS v(slug,name,category,descr,prev)
JOIN concepts c ON c.vocabulary_id='CANDID' AND c.concept_code=v.slug
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- ── VERIFY (run with the file; expect exactly 1 row, has_concept=t, canonical_for_concept=t) ──
SELECT slug, category, (concept_id IS NOT NULL) AS has_concept, canonical_for_concept
FROM service_catalog
WHERE slug = 'radiation_therapy';

-- ── ROLLBACK (no users; run only if apply errs — delete service_catalog FIRST, then concepts: FK) ──
-- BEGIN;
--   DELETE FROM service_catalog WHERE slug = 'radiation_therapy';
--   DELETE FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='radiation_therapy';
-- COMMIT;
