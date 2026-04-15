-- Migration 031: Add missing service_catalog entries
-- These slugs are referenced by STANDARD_SLUGS in claude-extractor.ts
-- and exist in canonical_plan_services but were never added to service_catalog.
-- Without catalog entries, canonical services can't be inherited to user plans.

INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, commonly_disputed, dispute_rate, misbill_rate, denial_rate, avg_overcharge_pct)
VALUES
  ('skilled_nursing', 'Skilled Nursing Facility', 'long_term_care', 'Inpatient skilled nursing facility care', false, false, 0, 0, 0, 0),
  ('hospice_inpatient', 'Hospice — Inpatient', 'long_term_care', 'Inpatient hospice and palliative care services', false, false, 0, 0, 0, 0),
  ('hospice_outpatient', 'Hospice — Outpatient', 'long_term_care', 'Outpatient hospice and palliative care services', false, false, 0, 0, 0, 0),
  ('childrens_eye_exam', 'Children''s Eye Exam', 'preventive', 'Routine vision exam for children under 19', true, false, 0, 0, 0, 0),
  ('routine_eye_care_adult', 'Routine Eye Care — Adult', 'preventive', 'Routine vision exam for adults', false, false, 0, 0, 0, 0),
  ('childrens_glasses', 'Children''s Glasses', 'preventive', 'Eyeglasses and lenses for children under 19', true, false, 0, 0, 0, 0),
  ('adult_dental_care', 'Adult Dental Care', 'preventive', 'Routine and major dental services for adults', false, false, 0, 0, 0, 0),
  ('hearing_aids', 'Hearing Aids', 'dme', 'Hearing aids and fitting services', false, false, 0, 0, 0, 0),
  ('infertility_treatment', 'Infertility Treatment', 'maternity', 'Infertility diagnosis and treatment services', false, true, 0.05, 0.03, 0.15, 0),
  ('long_term_care', 'Long-Term Care', 'long_term_care', 'Long-term custodial and residential care', false, false, 0, 0, 0, 0),
  ('private_duty_nursing', 'Private-Duty Nursing', 'long_term_care', 'Private-duty nursing services at home', false, false, 0, 0, 0, 0),
  ('weight_loss_programs', 'Weight Loss Programs', 'preventive', 'Medically supervised weight management programs', false, false, 0, 0, 0, 0)
ON CONFLICT (slug) DO NOTHING;

-- bariatric_surgery is an alias for the existing bariatric_obesity_surgery
-- Add it so Haiku-extracted slugs resolve correctly
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, commonly_disputed, dispute_rate, misbill_rate, denial_rate, avg_overcharge_pct)
VALUES ('bariatric_surgery', 'Bariatric Surgery', 'hospital', 'Weight-loss surgery (gastric bypass, sleeve, etc.)', false, true, 0.05, 0.02, 0.12, 0)
ON CONFLICT (slug) DO NOTHING;

-- Expand plan_covered_services source check to allow canonical_inherited
ALTER TABLE plan_covered_services DROP CONSTRAINT IF EXISTS plan_covered_services_source_check;
ALTER TABLE plan_covered_services ADD CONSTRAINT plan_covered_services_source_check
  CHECK (source IN ('sbc_parsed','plan_doc_parsed','cms_data','manual','canonical_inherited'));

-- Concept entries for OMOP vocabulary mapping
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, domain, concept_class)
SELECT v.id, sc.slug, sc.name, 'service', 'service'
FROM service_catalog sc
CROSS JOIN vocabularies v
WHERE v.vocabulary_code = 'CANDID_SVC'
  AND sc.slug IN (
    'skilled_nursing', 'hospice_inpatient', 'hospice_outpatient',
    'childrens_eye_exam', 'routine_eye_care_adult', 'childrens_glasses',
    'adult_dental_care', 'hearing_aids', 'infertility_treatment',
    'long_term_care', 'private_duty_nursing', 'weight_loss_programs'
  )
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;
