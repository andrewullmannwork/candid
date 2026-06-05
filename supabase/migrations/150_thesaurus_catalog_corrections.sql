-- Migration 150: Service Thesaurus — catalog corrections (S168 spot-check)
--
-- Andrew's spot-check of the 62-News classification (news-classification-sheet.tsv) surfaced 3
-- category errors in the mig-148 catalog. ADDITIVE ONLY (Rule #7): recategorize (service_catalog
-- metadata) + split one 0-row slug via the merge pattern. NO canonical_plan_services rows are
-- repointed — the verified-lossless 48,546 transform from mig 148 stays intact.
--
-- Verified pre-write (live PROD): diabetes_education (therapy, 0 rows), covid_services
-- (preventive, 0 rows), non_emergency_care_outside_us (emergency, 55 rows — untouched by a
-- recategorize; category lives on service_catalog, the rows just reference the slug).
--
-- SoT: Candid_Data_Patterns "Pattern S" + Hard Rule #17 · runbook §H/§K · the S168 spot-check.

BEGIN;

-- ── 1. diabetes_education: therapy → preventive (DSME is a preventive benefit) ──
UPDATE service_catalog SET category = 'preventive', updated_at = now()
  WHERE slug = 'diabetes_education';

-- ── 2. non_emergency_care_outside_us: emergency → other ──
-- It is EXPLICITLY non-emergency care, so it must not sit in the 'emergency' domain.
-- Pattern S note: this is really a place_of_service/location axis ("care delivered outside the US"),
-- not a service domain — the proper modifier restructure is deferred to Phase 1. Minimal correct
-- fix now = recategorize off 'emergency'. The 55 canonical_plan_services rows are untouched.
UPDATE service_catalog SET category = 'other', updated_at = now()
  WHERE slug = 'non_emergency_care_outside_us';

-- ── 3. covid_services (preventive, 0 rows) → SPLIT into covid_test (lab) + covid_therapeutics (rx) ──
-- COVID tests are lab services; COVID therapeutics are rx. Per Hard Rule #17 the two are is_a
-- children of their domain parents (keeps COVID trackable while living under lab/rx), and
-- covid_services deprecates via merged_into_id (never deleted).

-- 3a. new concepts
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  ('CANDID','covid_test','COVID-19 Diagnostic Test','service','service'),
  ('CANDID','covid_therapeutics','COVID-19 Therapeutics','service','service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 3b. new slugs (slug<->concept 1:1; canonical_for_concept=TRUE so mig-103 enforce_canonical_per_concept
--     is satisfied). is_preventive_eligible=false — Andrew's correction moves COVID OUT of preventive.
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state)
SELECT v.slug, v.name, v.category, v.descr, v.prev, c.id, TRUE, 'canonical'
FROM (VALUES
  ('covid_test','COVID-19 Test','lab','COVID-19 diagnostic testing (PCR/antigen)',false),
  ('covid_therapeutics','COVID-19 Therapeutics','rx','COVID-19 antivirals and therapeutics (e.g., Paxlovid)',false)
) AS v(slug,name,category,descr,prev)
JOIN concepts c ON c.vocabulary_id = 'CANDID' AND c.concept_code = v.slug
ON CONFLICT (slug) DO NOTHING;

-- 3c. is_a links (Hard Rule #17): covid_test is_a lab_outpatient; covid_therapeutics is_a prescription_drugs.
--     Resolve parent concept_id by SLUG (robust to concept_code != slug); WHERE-guarded so a parent
--     without a concept_id simply skips the link (the category in 3b is the load-bearing fix).
INSERT INTO concept_relationships (concept_id_1, concept_id_2, relationship_type)
SELECT child_cid, parent_cid, 'is_a'
FROM (
  SELECT (SELECT concept_id FROM service_catalog WHERE slug = r.child_slug)  AS child_cid,
         (SELECT concept_id FROM service_catalog WHERE slug = r.parent_slug) AS parent_cid
  FROM (VALUES ('covid_test','lab_outpatient'),('covid_therapeutics','prescription_drugs')) AS r(child_slug, parent_slug)
) x
WHERE child_cid IS NOT NULL AND parent_cid IS NOT NULL
ON CONFLICT (concept_id_1, concept_id_2, relationship_type) DO NOTHING;

-- 3d. deprecate covid_services → merged_into covid_test (0 rows; SPLIT documented:
--     covid_services -> covid_test [lab] + covid_therapeutics [rx]).
UPDATE service_catalog
  SET merged_into_id = (SELECT id FROM service_catalog WHERE slug = 'covid_test'),
      merged_at = now(), deprecated_at = now(), updated_at = now()
  WHERE slug = 'covid_services';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (no users; correcting an unshipped same-session catalog artifact)
-- ════════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   UPDATE service_catalog SET category='therapy'   WHERE slug='diabetes_education';
--   UPDATE service_catalog SET category='emergency' WHERE slug='non_emergency_care_outside_us';
--   UPDATE service_catalog SET merged_into_id=NULL, merged_at=NULL, deprecated_at=NULL WHERE slug='covid_services';
--   DELETE FROM concept_relationships WHERE relationship_type='is_a'
--     AND concept_id_1 IN (SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code IN ('covid_test','covid_therapeutics'));
--   DELETE FROM service_catalog WHERE slug IN ('covid_test','covid_therapeutics');
--   DELETE FROM concepts WHERE vocabulary_id='CANDID' AND concept_code IN ('covid_test','covid_therapeutics');
-- COMMIT;
