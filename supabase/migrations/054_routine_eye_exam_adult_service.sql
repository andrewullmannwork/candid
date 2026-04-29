-- Migration 054: Add routine_eye_exam_adult to service_catalog
-- Adult routine eye care (screening + refraction for vision correction) appears
-- in many SBCs as an "Other Covered Service" (e.g., Ambetter California 2024
-- Bronze 60 HDHP). Without this slug, the SBC parser cannot emit a
-- plan_covered_services row for adult vision and the coverage is lost.

INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible) VALUES
  ('routine_eye_exam_adult', 'Routine Eye Exam — Adult', 'other', 'Adult routine eye care including vision screening and eye refraction for vision correction purposes', false)
ON CONFLICT (slug) DO NOTHING;
