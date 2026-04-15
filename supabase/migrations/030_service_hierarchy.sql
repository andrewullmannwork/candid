-- Migration 030: Service Hierarchy + Slug Fixup (T0.5a)
--
-- 1. Merge duplicate service_catalog entries created by extractor slug mismatch
-- 2. Create service_group concepts for intermediate hierarchy nodes
-- 3. Populate concept_relationships with is_a edges (service → group → category)
-- 4. Backfill concept_ancestors transitive closure
--
-- Hierarchy model:
--   service_categories (14)  →  service_group concepts  →  service_catalog (leaf services)
--   e.g.  rx  →  preferred_brand_rx (group)  →  preferred_brand_rx_tier2 (service)

-- ============================================================================
-- PART 1: MERGE DUPLICATE SERVICE_CATALOG ENTRIES
-- ============================================================================
-- The plan extractor auto-created entries like 'preferred_brand_rx' when the
-- catalog already had 'preferred_brand_rx_tier2'. Merge old → canonical.

-- Helper: merge a duplicate slug into its canonical target
-- Updates all FK references, then soft-deletes the duplicate via merged_into_id.
DO $$
DECLARE
  _dupes TEXT[][] := ARRAY[
    ARRAY['preferred_brand_rx', 'preferred_brand_rx_tier2'],
    ARRAY['non_preferred_rx', 'non_preferred_rx_tier3'],
    ARRAY['specialty_rx', 'specialty_rx_tier4'],
    ARRAY['emergency_transport', 'emergency_transport_ground'],
    ARRAY['occupational_therapy', 'ot_rehab'],
    ARRAY['telehealth', 'telehealth_pcp']
  ];
  _old_slug TEXT;
  _new_slug TEXT;
  _old_id UUID;
  _new_id UUID;
BEGIN
  FOR i IN 1..array_length(_dupes, 1) LOOP
    _old_slug := _dupes[i][1];
    _new_slug := _dupes[i][2];

    SELECT id INTO _old_id FROM service_catalog WHERE slug = _old_slug;
    SELECT id INTO _new_id FROM service_catalog WHERE slug = _new_slug;

    -- Skip if the duplicate doesn't exist (never auto-created)
    IF _old_id IS NULL OR _new_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Update plan_covered_services references
    UPDATE plan_covered_services SET service_id = _new_id WHERE service_id = _old_id;

    -- Update canonical_plan_services references
    UPDATE canonical_plan_services SET service_slug = _new_slug WHERE service_slug = _old_slug;

    -- Update claim_line_items references
    UPDATE claim_line_items SET service_slug = _new_slug WHERE service_slug = _old_slug;

    -- Soft-delete the duplicate (preserve for audit trail)
    UPDATE service_catalog SET merged_into_id = _new_id, merged_at = NOW() WHERE id = _old_id;

    RAISE NOTICE 'Merged service_catalog: % → %', _old_slug, _new_slug;
  END LOOP;
END $$;

-- ============================================================================
-- PART 2: CREATE SERVICE GROUP CONCEPTS
-- ============================================================================
-- Groups are intermediate hierarchy nodes between categories and leaf services.
-- e.g., 'preferred_brand_rx' is a group under category 'rx'.

-- Ensure CANDID vocabulary exists (should already from migration 019)
INSERT INTO vocabularies (vocabulary_id, vocabulary_name, description)
VALUES ('CANDID', 'Candid Internal', 'Candid platform service taxonomy')
ON CONFLICT DO NOTHING;

-- Create category-level concepts (one per service_category)
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  ('CANDID', 'cat_office_visit', 'Office Visits', 'category', 'service'),
  ('CANDID', 'cat_emergency', 'Emergency', 'category', 'service'),
  ('CANDID', 'cat_hospital', 'Hospital', 'category', 'service'),
  ('CANDID', 'cat_imaging', 'Imaging', 'category', 'service'),
  ('CANDID', 'cat_lab', 'Lab & Testing', 'category', 'service'),
  ('CANDID', 'cat_rx', 'Prescriptions', 'category', 'service'),
  ('CANDID', 'cat_therapy', 'Therapy & Rehab', 'category', 'service'),
  ('CANDID', 'cat_mental_health', 'Mental Health', 'category', 'service'),
  ('CANDID', 'cat_maternity', 'Maternity', 'category', 'service'),
  ('CANDID', 'cat_dme', 'Equipment & Supplies', 'category', 'service'),
  ('CANDID', 'cat_preventive', 'Preventive Care', 'category', 'service'),
  ('CANDID', 'cat_other', 'Other Services', 'category', 'service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- Create service_group concepts for services that have sub-levels
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  -- Rx groups (tiers roll up to groups)
  ('CANDID', 'grp_generic_rx', 'Generic Drugs', 'service_group', 'service'),
  ('CANDID', 'grp_preferred_brand_rx', 'Preferred Brand Drugs', 'service_group', 'service'),
  ('CANDID', 'grp_non_preferred_rx', 'Non-Preferred Drugs', 'service_group', 'service'),
  ('CANDID', 'grp_specialty_rx', 'Specialty Drugs', 'service_group', 'service'),
  -- Emergency transport group
  ('CANDID', 'grp_emergency_transport', 'Emergency Transportation', 'service_group', 'service'),
  -- Telehealth group
  ('CANDID', 'grp_telehealth', 'Telehealth', 'service_group', 'service'),
  -- Surgery group
  ('CANDID', 'grp_outpatient_surgery', 'Outpatient Surgery', 'service_group', 'service'),
  -- Hospital stay group
  ('CANDID', 'grp_inpatient', 'Hospital Stay', 'service_group', 'service'),
  -- Hospice group
  ('CANDID', 'grp_hospice', 'Hospice', 'service_group', 'service'),
  -- Maternity delivery group
  ('CANDID', 'grp_delivery', 'Delivery', 'service_group', 'service'),
  -- Substance abuse group
  ('CANDID', 'grp_substance_abuse', 'Substance Use Disorder', 'service_group', 'service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- ============================================================================
-- PART 3: POPULATE is_a RELATIONSHIPS
-- ============================================================================
-- Pattern: child is_a parent
-- Service → service_group → category

-- Helper function to insert is_a relationships by concept_code
CREATE OR REPLACE FUNCTION _insert_is_a(child_code TEXT, parent_code TEXT) RETURNS VOID AS $$
DECLARE
  _child_id UUID;
  _parent_id UUID;
BEGIN
  SELECT id INTO _child_id FROM concepts WHERE vocabulary_id = 'CANDID' AND concept_code = child_code;
  SELECT id INTO _parent_id FROM concepts WHERE vocabulary_id = 'CANDID' AND concept_code = parent_code;
  IF _child_id IS NOT NULL AND _parent_id IS NOT NULL THEN
    INSERT INTO concept_relationships (concept_id_1, concept_id_2, relationship_type)
    VALUES (_child_id, _parent_id, 'is_a')
    ON CONFLICT DO NOTHING;
  END IF;
END $$ LANGUAGE plpgsql;

-- ── Groups → Categories ────────────────────────────────────────────────────
SELECT _insert_is_a('grp_generic_rx', 'cat_rx');
SELECT _insert_is_a('grp_preferred_brand_rx', 'cat_rx');
SELECT _insert_is_a('grp_non_preferred_rx', 'cat_rx');
SELECT _insert_is_a('grp_specialty_rx', 'cat_rx');
SELECT _insert_is_a('grp_emergency_transport', 'cat_emergency');
SELECT _insert_is_a('grp_telehealth', 'cat_office_visit');
SELECT _insert_is_a('grp_outpatient_surgery', 'cat_hospital');
SELECT _insert_is_a('grp_inpatient', 'cat_hospital');
SELECT _insert_is_a('grp_hospice', 'cat_other');
SELECT _insert_is_a('grp_delivery', 'cat_maternity');
SELECT _insert_is_a('grp_substance_abuse', 'cat_mental_health');

-- ── Services → Groups (for services that have a group) ─────────────────────
-- Rx tiers → rx groups
SELECT _insert_is_a('generic_rx_tier1', 'grp_generic_rx');
SELECT _insert_is_a('preferred_brand_rx_tier2', 'grp_preferred_brand_rx');
SELECT _insert_is_a('non_preferred_rx_tier3', 'grp_non_preferred_rx');
SELECT _insert_is_a('specialty_rx_tier4', 'grp_specialty_rx');

-- Emergency transport → group
SELECT _insert_is_a('emergency_transport_ground', 'grp_emergency_transport');
SELECT _insert_is_a('emergency_transport_air', 'grp_emergency_transport');

-- Telehealth → group
SELECT _insert_is_a('telehealth_pcp', 'grp_telehealth');
SELECT _insert_is_a('telehealth_specialist', 'grp_telehealth');

-- Surgery → group
SELECT _insert_is_a('outpatient_surgery_facility', 'grp_outpatient_surgery');
SELECT _insert_is_a('outpatient_surgery_physician', 'grp_outpatient_surgery');

-- Inpatient → group
SELECT _insert_is_a('inpatient_facility', 'grp_inpatient');
SELECT _insert_is_a('inpatient_physician', 'grp_inpatient');

-- Hospice → group
SELECT _insert_is_a('hospice_inpatient', 'grp_hospice');
SELECT _insert_is_a('hospice_outpatient', 'grp_hospice');

-- Delivery → group
SELECT _insert_is_a('delivery_facility', 'grp_delivery');
SELECT _insert_is_a('delivery_professional', 'grp_delivery');

-- Substance abuse → group
SELECT _insert_is_a('substance_abuse_outpatient', 'grp_substance_abuse');
SELECT _insert_is_a('substance_abuse_inpatient', 'grp_substance_abuse');

-- ── Services → Categories (direct, for services without a group) ───────────
SELECT _insert_is_a('pcp_visit', 'cat_office_visit');
SELECT _insert_is_a('specialist_visit', 'cat_office_visit');
SELECT _insert_is_a('convenience_care_clinic', 'cat_office_visit');
SELECT _insert_is_a('second_opinion', 'cat_office_visit');

SELECT _insert_is_a('er_visit', 'cat_emergency');
SELECT _insert_is_a('urgent_care', 'cat_emergency');

SELECT _insert_is_a('diagnostic_test', 'cat_imaging');
SELECT _insert_is_a('advanced_imaging', 'cat_imaging');
SELECT _insert_is_a('radiology_basic', 'cat_imaging');

SELECT _insert_is_a('lab_pcp_office', 'cat_lab');
SELECT _insert_is_a('lab_specialist_office', 'cat_lab');
SELECT _insert_is_a('lab_outpatient_facility', 'cat_lab');
SELECT _insert_is_a('lab_independent', 'cat_lab');

SELECT _insert_is_a('preventive_rx', 'cat_rx');
SELECT _insert_is_a('chemotherapy_rx', 'cat_rx');

SELECT _insert_is_a('pt_rehab', 'cat_therapy');
SELECT _insert_is_a('ot_rehab', 'cat_therapy');
SELECT _insert_is_a('speech_therapy', 'cat_therapy');
SELECT _insert_is_a('pulmonary_rehab', 'cat_therapy');
SELECT _insert_is_a('cognitive_therapy', 'cat_therapy');
SELECT _insert_is_a('cardiac_rehab', 'cat_therapy');
SELECT _insert_is_a('chiropractic', 'cat_therapy');
SELECT _insert_is_a('acupuncture', 'cat_therapy');
SELECT _insert_is_a('habilitation', 'cat_therapy');

SELECT _insert_is_a('mental_health_outpatient', 'cat_mental_health');
SELECT _insert_is_a('mental_health_inpatient', 'cat_mental_health');
SELECT _insert_is_a('mental_health_telehealth', 'cat_mental_health');
SELECT _insert_is_a('mental_health_partial', 'cat_mental_health');
SELECT _insert_is_a('bereavement_counseling', 'cat_mental_health');

SELECT _insert_is_a('prenatal_visit', 'cat_maternity');
SELECT _insert_is_a('abortion', 'cat_maternity');

SELECT _insert_is_a('durable_medical_equipment', 'cat_dme');
SELECT _insert_is_a('prosthetics', 'cat_dme');
SELECT _insert_is_a('diabetic_equipment', 'cat_dme');

SELECT _insert_is_a('preventive_care', 'cat_preventive');
SELECT _insert_is_a('annual_physical', 'cat_preventive');
SELECT _insert_is_a('immunizations', 'cat_preventive');
SELECT _insert_is_a('cancer_screening', 'cat_preventive');
SELECT _insert_is_a('well_child_visit', 'cat_preventive');
SELECT _insert_is_a('womens_sterilization', 'cat_preventive');

SELECT _insert_is_a('home_health', 'cat_other');
SELECT _insert_is_a('skilled_nursing', 'cat_other');
SELECT _insert_is_a('dialysis', 'cat_other');
SELECT _insert_is_a('transplant', 'cat_other');
SELECT _insert_is_a('nutritional_counseling', 'cat_other');
SELECT _insert_is_a('genetic_counseling', 'cat_other');
SELECT _insert_is_a('allergy_treatment', 'cat_other');
SELECT _insert_is_a('medical_pharmaceuticals', 'cat_other');
SELECT _insert_is_a('gene_therapy', 'cat_other');
SELECT _insert_is_a('bariatric_surgery', 'cat_other');
SELECT _insert_is_a('childrens_eye_exam', 'cat_other');
SELECT _insert_is_a('childrens_glasses', 'cat_other');
SELECT _insert_is_a('childrens_dental', 'cat_other');
SELECT _insert_is_a('dental_injury', 'cat_other');

-- ============================================================================
-- PART 4: BACKFILL CONCEPT_ANCESTORS (transitive closure)
-- ============================================================================
-- For every is_a chain (A is_a B is_a C), insert ancestor records so
-- we can query "all descendants of cat_rx" in O(1).

-- Self-references (every concept is its own ancestor at distance 0)
INSERT INTO concept_ancestors (ancestor_concept_id, descendant_concept_id, min_levels_of_separation, max_levels_of_separation)
SELECT id, id, 0, 0 FROM concepts WHERE vocabulary_id = 'CANDID'
ON CONFLICT DO NOTHING;

-- Direct parents (distance 1)
INSERT INTO concept_ancestors (ancestor_concept_id, descendant_concept_id, min_levels_of_separation, max_levels_of_separation)
SELECT cr.concept_id_2, cr.concept_id_1, 1, 1
FROM concept_relationships cr
WHERE cr.relationship_type = 'is_a'
ON CONFLICT DO NOTHING;

-- Grandparents (distance 2): service → group → category
INSERT INTO concept_ancestors (ancestor_concept_id, descendant_concept_id, min_levels_of_separation, max_levels_of_separation)
SELECT cr2.concept_id_2, cr1.concept_id_1, 2, 2
FROM concept_relationships cr1
JOIN concept_relationships cr2 ON cr1.concept_id_2 = cr2.concept_id_1
WHERE cr1.relationship_type = 'is_a' AND cr2.relationship_type = 'is_a'
ON CONFLICT DO NOTHING;

-- Clean up helper function
DROP FUNCTION IF EXISTS _insert_is_a(TEXT, TEXT);
