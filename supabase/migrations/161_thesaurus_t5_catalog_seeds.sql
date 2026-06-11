-- Migration 161: Service Thesaurus — T5 remediation catalog seeds (S193, D3 verdicts)
--
-- Andrew's Tier-2 oracle pass (findings/eoc-t5full-2026-06-11) surfaced two missing concepts the
-- parser force-fit onto wrong-but-valid slugs, plus one abbreviation alias:
--   1. childrens_eye_hardware  — pediatric vision hardware (BS PA lists: "Non-elective (Medically
--      Necessary) contact lenses" under "pediatric vision"; parser force-fit childrens_glasses /
--      childrens_eye_exam / routine_eye_care_adult). Andrew-preferred name. ADDITIVE sibling —
--      childrens_glasses is untouched. is_a child of the existing vision_hardware.
--   2. non_emergency_transport_ground — NEMT (BS PA lists "Non-emergency ambulance services";
--      Kaiser K20 corroborates cross-carrier; parser force-fit emergency_transport_ground).
--      Category 'other' per the mig-150 precedent (explicitly non-emergency services must not
--      sit in the 'emergency' domain).
--   3. dme — born-merged abbreviation ALIAS of durable_medical_equipment (rename-map layer only:
--      merged rows are excluded from the prompt vocabulary block AND from validSlugs — verified
--      S192/S193 against loadServiceVocabularyBlock + loadServiceRenameMap).
--
-- Mirrors mig 150 shape (concepts -> catalog JOIN -> guarded is_a). ADDITIVE ONLY (Rule #7).
-- Paste-safe: no semicolons inside string literals or comments

BEGIN;

-- 1. concepts (Rule #6 — every slug maps to a concept)
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  ('CANDID','childrens_eye_hardware','Children''s Eye Hardware','service','service'),
  ('CANDID','non_emergency_transport_ground','Non-Emergency Ground Medical Transport','service','service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 2. live slugs (enter the prompt vocabulary block + validSlugs)
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state)
SELECT v.slug, v.name, v.category, v.descr, v.prev, c.id, TRUE, 'canonical'
FROM (VALUES
  ('childrens_eye_hardware','Children''s Eye Hardware','vision','Pediatric vision hardware including medically necessary contact lenses and corrective devices (additive sibling of childrens_glasses)',false),
  ('non_emergency_transport_ground','Non-Emergency Ground Medical Transport','other','Non-emergency ground ambulance and medical transport (NEMT) — distinct from emergency_transport_ground',false)
) AS v(slug,name,category,descr,prev)
JOIN concepts c ON c.vocabulary_id = 'CANDID' AND c.concept_code = v.slug
ON CONFLICT (slug) DO NOTHING;

-- 3. is_a link (Hard Rule #17): childrens_eye_hardware is_a vision_hardware.
--    WHERE-guarded — a parent without a concept_id simply skips the link.
--    (non_emergency_transport_ground has no proper is_a parent — emergency transport is NOT one.)
INSERT INTO concept_relationships (concept_id_1, concept_id_2, relationship_type)
SELECT child_cid, parent_cid, 'is_a'
FROM (
  SELECT (SELECT concept_id FROM service_catalog WHERE slug = 'childrens_eye_hardware') AS child_cid,
         (SELECT concept_id FROM service_catalog WHERE slug = 'vision_hardware')        AS parent_cid
) x
WHERE child_cid IS NOT NULL AND parent_cid IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. dme born-merged alias (rename-map layer — NEVER enters the vocabulary block).
--    INSERT-SELECT keyed on the target: if durable_medical_equipment were somehow absent this
--    inserts 0 rows (post-apply verification expects 3 catalog rows total).
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state, merged_into_id)
SELECT 'dme', 'DME (abbreviation alias)', t.category,
       'Abbreviation alias of durable_medical_equipment — canonicalization layer only, excluded from the prompt vocabulary',
       false, NULL, FALSE, 'canonical', t.id
FROM service_catalog t
WHERE t.slug = 'durable_medical_equipment'
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- ROLLBACK (manual, documented — run in order):
--   DELETE FROM concept_relationships WHERE relationship_type = 'is_a' AND concept_id_1 =
--     (SELECT concept_id FROM service_catalog WHERE slug = 'childrens_eye_hardware')
--   DELETE FROM service_catalog WHERE slug IN ('childrens_eye_hardware','non_emergency_transport_ground','dme')
--   DELETE FROM concepts WHERE vocabulary_id = 'CANDID' AND concept_code IN ('childrens_eye_hardware','non_emergency_transport_ground')
