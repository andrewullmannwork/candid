-- 193_chargemaster_woodland_hpt_seed.sql
-- Item C (R3 step 5.4 Phase 3) — chargemaster reference seed.
--
-- Woodland Memorial Hospital's AB-1045 published AVERAGE charges (22 CPT-priced common services;
-- Effective 2025-06-01; HCAI Facility No 106571086; org NPI 1922116037) → public.pricing_data with
-- data_source='hospital_hpt' (the federal Hospital Price Transparency slot). We REUSE the Care
-- pricing table rather than create a new chargemaster table — pricing_data already models per-NPI
-- per-code published charges, and 'hospital_hpt' exists for exactly this.
--
-- Powers the chargemaster dispute ground: runAudit's lookupChargemasterRatesBatch matches
-- bill.provider.npi -> facility_npi (data_source='hospital_hpt'); the detector flags lines billed
-- above the published average; the letter raises it (RAISE voice). REFERENCE data only — a seed
-- migration (Rule #4/#10), service-role only (pricing_data RLS). Re-runnable: deletes this
-- facility's prior hospital_hpt rows first. Source workbook:
-- data/chargemaster-source/HCAI_106571086_woodland_memorial.xlsx ('AB 1045 Form' sheet).
--
-- NOTE: only the 22 AB-1045 rows that carry a published charge are seeded (25 listed CPTs had a
-- blank charge in the disclosure). The full 20,829-row CDM has no CPT column (internal CDM numbers
-- only) → not bill-matchable without fuzzy description-matching = the deferred Care workstream.

delete from public.pricing_data
where data_source = 'hospital_hpt' and facility_npi = '1922116037';

insert into public.pricing_data
  (procedure_code, procedure_category, facility_name, facility_npi, region, billed_amount, data_source, confidence_score)
values
  ('99282', 'Evaluation & Management', 'Woodland Memorial Hospital', '1922116037', 'CA',  1360.00, 'hospital_hpt', 0.90),
  ('99283', 'Evaluation & Management', 'Woodland Memorial Hospital', '1922116037', 'CA',  2597.00, 'hospital_hpt', 0.90),
  ('99213', 'Evaluation & Management', 'Woodland Memorial Hospital', '1922116037', 'CA',   370.00, 'hospital_hpt', 0.90),
  ('80048', 'Laboratory & Pathology',  'Woodland Memorial Hospital', '1922116037', 'CA',   356.00, 'hospital_hpt', 0.90),
  ('82805', 'Laboratory & Pathology',  'Woodland Memorial Hospital', '1922116037', 'CA',   709.00, 'hospital_hpt', 0.90),
  ('85027', 'Laboratory & Pathology',  'Woodland Memorial Hospital', '1922116037', 'CA',   223.00, 'hospital_hpt', 0.90),
  ('85025', 'Laboratory & Pathology',  'Woodland Memorial Hospital', '1922116037', 'CA',   189.00, 'hospital_hpt', 0.90),
  ('80053', 'Laboratory & Pathology',  'Woodland Memorial Hospital', '1922116037', 'CA',   710.00, 'hospital_hpt', 0.90),
  ('74160', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  7119.00, 'hospital_hpt', 0.90),
  ('70450', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  4733.00, 'hospital_hpt', 0.90),
  ('72193', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  7099.00, 'hospital_hpt', 0.90),
  ('70553', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  8679.00, 'hospital_hpt', 0.90),
  ('76700', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  1874.00, 'hospital_hpt', 0.90),
  ('76805', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  1256.00, 'hospital_hpt', 0.90),
  ('72110', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  1175.00, 'hospital_hpt', 0.90),
  ('71046', 'Radiology',               'Woodland Memorial Hospital', '1922116037', 'CA',  1054.00, 'hospital_hpt', 0.90),
  ('93452', 'Medicine',                'Woodland Memorial Hospital', '1922116037', 'CA', 38358.00, 'hospital_hpt', 0.90),
  ('93307', 'Medicine',                'Woodland Memorial Hospital', '1922116037', 'CA',  1697.00, 'hospital_hpt', 0.90),
  ('93000', 'Medicine',                'Woodland Memorial Hospital', '1922116037', 'CA',   546.00, 'hospital_hpt', 0.90),
  ('97116', 'Medicine',                'Woodland Memorial Hospital', '1922116037', 'CA',   318.00, 'hospital_hpt', 0.90),
  ('97110', 'Medicine',                'Woodland Memorial Hospital', '1922116037', 'CA',   332.00, 'hospital_hpt', 0.90),
  ('64483', 'Surgery',                 'Woodland Memorial Hospital', '1922116037', 'CA',  3239.00, 'hospital_hpt', 0.90);

-- verify (run after apply in Studio): expect 22 rows.
-- select count(*) from public.pricing_data where data_source='hospital_hpt' and facility_npi='1922116037';
