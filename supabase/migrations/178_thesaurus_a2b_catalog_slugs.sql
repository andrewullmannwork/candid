-- Migration 178: Service Thesaurus A2b — catalog new slugs (Phase 1, slug-level)
-- ADDITIVE ONLY (Rule #7). Mirrors mig 148 §2c/2d (concepts -> service_catalog, canonical_for_concept).
--
-- 3 new role/identity slugs surfaced by the S221/S222 GT re-adjudication
-- (worksheet: findings/thesaurus-flipb-validation-2026-06-24/readjudication-worksheet.md):
--   emergency_transport_water     (cat emergency) — water/marine ambulance ("Ambulance Services (Water)"; 8x recall pattern)
--   medical_travel                (cat other)     — travel/lodging/related expenses for a covered procedure
--                                                   (bariatric/transplant/transgender). The TRANSPORT line stays
--                                                   non_emergency_transport_ground; medical_travel = the lodging/other component.
--   childrens_dental_orthodontic  (cat dental)    — pediatric medically-necessary orthodontia (ACA pediatric dental EHB;
--                                                   coverage distinct from adult dental_orthodontic).
--
-- NO is_a: siblings are flat (no emergency-transport parent concept exists; the dental category is flat peers).
-- NO telehealth deprecation here — DEFERRED to Phase 2 (bundled with place=virtual emission, to avoid a
--   pcp_visit cost-share ambiguity). Phase-1 telehealth -> base slug is a flag-gated resolver rule, not a catalog change.
-- NO place-of-service vocab mig: the 11 places incl. 'virtual' are already in mig 147; the
--   'emergency'/'other'/'dental' categories are already in the mig 148 service_catalog CHECK.
--
-- PRE-LAUNCH, no users. Ship LIVE to PROD (D5). Andrew Studio-applies the WHOLE file; the trailing
-- SELECT must return 3 rows (has_concept=t, canonical=t). (Studio can report "Success" on a partial/
-- comment-only selection — run the entire file and confirm the verify output.)
-- SoT: Candid_Data_Patterns "Pattern S" + Hard Rule #17. Next-free mig after this = 179 (A2b seed).

BEGIN;

-- 1. New concepts (vocabulary CANDID; class/domain 'service' per the mig-148 seed shape).
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  ('CANDID','emergency_transport_water','Emergency Medical Transportation — Water','service','service'),
  ('CANDID','medical_travel','Medical Travel & Lodging','service','service'),
  ('CANDID','childrens_dental_orthodontic','Children''s Dental — Orthodontic','service','service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 2. New service_catalog slugs (link concept_id by concept_code=slug; canonical_for_concept=TRUE so the
--    mig-103 enforce_canonical_per_concept trigger is satisfied — one canonical slug per new concept).
--    Categories 'emergency'/'other'/'dental' already pass the mig-148 service_catalog_category_check.
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state)
SELECT v.slug, v.name, v.category, v.descr, v.prev, c.id, TRUE, 'canonical'
FROM (VALUES
  ('emergency_transport_water','Emergency Medical Transportation — Water','emergency','Water/marine ambulance (e.g., boat ambulance)',false),
  ('medical_travel','Medical Travel & Lodging','other','Travel, lodging & related expenses for a covered procedure (transport line stays non_emergency_transport_ground)',false),
  ('childrens_dental_orthodontic','Children''s Dental — Orthodontic','dental','Pediatric medically-necessary orthodontia (ACA pediatric dental EHB)',false)
) AS v(slug,name,category,descr,prev)
JOIN concepts c ON c.vocabulary_id='CANDID' AND c.concept_code=v.slug
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- ── VERIFY (run with the file; expect exactly 3 rows, has_concept=t, canonical_for_concept=t) ──
SELECT slug, category, (concept_id IS NOT NULL) AS has_concept, canonical_for_concept
FROM service_catalog
WHERE slug IN ('emergency_transport_water','medical_travel','childrens_dental_orthodontic')
ORDER BY slug;

-- ── ROLLBACK (no users; run only if apply errs — delete service_catalog FIRST, then concepts: FK) ──
-- BEGIN;
--   DELETE FROM service_catalog WHERE slug IN ('emergency_transport_water','medical_travel','childrens_dental_orthodontic');
--   DELETE FROM concepts WHERE vocabulary_id='CANDID'
--     AND concept_code IN ('emergency_transport_water','medical_travel','childrens_dental_orthodontic');
-- COMMIT;
