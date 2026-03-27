-- Migration 010: Seed service_catalog with ~60 standard health care services
-- Derived from federal SBC template + Cigna Open Access Plus plan document

INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible) VALUES

-- ── Office Visits ────────────────────────────────────────────────────────────
('pcp_visit', 'Primary Care Visit', 'office_visit', 'Office visit to treat an injury or illness with a primary care physician', false),
('specialist_visit', 'Specialist Visit', 'office_visit', 'Office visit with a specialist or consultant physician', false),
('telehealth_pcp', 'Telehealth — Primary Care', 'office_visit', 'Virtual visit with a primary care physician or dedicated virtual provider (e.g., MDLIVE)', false),
('telehealth_specialist', 'Telehealth — Specialist', 'office_visit', 'Virtual visit with a specialist physician', false),
('convenience_care_clinic', 'Convenience Care Clinic', 'office_visit', 'Visit to a retail or convenience care clinic including related lab/x-ray', false),
('second_opinion', 'Second Opinion Consultation', 'office_visit', 'Voluntary second opinion consultation with another physician', false),

-- ── Preventive Care ──────────────────────────────────────────────────────────
('preventive_care', 'Preventive Care / Screening / Immunization', 'preventive', 'Routine preventive care visits, screenings, and immunizations for all ages', true),
('annual_physical', 'Annual Physical Exam', 'preventive', 'Routine annual physical examination', true),
('immunizations', 'Immunizations', 'preventive', 'Routine vaccinations for all ages', true),
('cancer_screening', 'Cancer Screening (Mammogram, PSA, PAP)', 'preventive', 'Routine cancer screening tests including mammograms, PSA, and PAP smears', true),
('well_child_visit', 'Well-Child Visit', 'preventive', 'Routine pediatric wellness and developmental check-up', true),
('womens_sterilization', 'Women''s Surgical Sterilization', 'preventive', 'Sterilization procedures (e.g., tubal ligation), excludes reversals', true),

-- ── Emergency ────────────────────────────────────────────────────────────────
('er_visit', 'Emergency Room Visit', 'emergency', 'Hospital emergency room care including professional services, x-ray, and lab', false),
('emergency_transport_ground', 'Emergency Medical Transportation — Ground', 'emergency', 'Licensed ground ambulance service to nearest appropriate facility', false),
('emergency_transport_air', 'Emergency Medical Transportation — Air', 'emergency', 'Air ambulance service', false),
('urgent_care', 'Urgent Care Visit', 'emergency', 'Urgent care facility visit including professional services, x-ray, and lab', false),

-- ── Hospital ─────────────────────────────────────────────────────────────────
('inpatient_facility', 'Hospital Stay — Facility', 'hospital', 'Inpatient hospital room and board (semi-private), special care units (ICU/CCU)', false),
('inpatient_physician', 'Hospital Stay — Physician/Surgeon', 'hospital', 'Inpatient physician visits, consultations, surgeon, radiologist, pathologist, anesthesiologist', false),
('outpatient_surgery_facility', 'Outpatient Surgery — Facility', 'hospital', 'Outpatient facility services: operating room, recovery room, procedure room', false),
('outpatient_surgery_physician', 'Outpatient Surgery — Physician/Surgeon', 'hospital', 'Outpatient professional services for surgery', false),

-- ── Imaging ──────────────────────────────────────────────────────────────────
('diagnostic_test', 'Diagnostic Test (X-ray, Blood Work)', 'imaging', 'Basic diagnostic tests including x-rays and blood work', false),
('advanced_imaging', 'Advanced Imaging (CT/PET/MRI)', 'imaging', 'Advanced radiological imaging: MRI, MRA, CT scan, PET scan', false),
('radiology_basic', 'Basic Radiology', 'imaging', 'Standard radiology services (non-advanced)', false),

-- ── Lab ──────────────────────────────────────────────────────────────────────
('lab_pcp_office', 'Lab — PCP Office', 'lab', 'Laboratory services performed in primary care physician office', false),
('lab_specialist_office', 'Lab — Specialist Office', 'lab', 'Laboratory services performed in specialist office', false),
('lab_outpatient_facility', 'Lab — Outpatient Hospital', 'lab', 'Laboratory services performed at outpatient hospital facility', false),
('lab_independent', 'Lab — Independent Facility', 'lab', 'Laboratory services performed at independent lab facility', false),

-- ── Prescription Drugs ───────────────────────────────────────────────────────
('generic_rx_tier1', 'Generic Drugs (Tier 1)', 'rx', 'Generic drugs on the prescription drug list', false),
('preferred_brand_rx_tier2', 'Preferred Brand Drugs (Tier 2)', 'rx', 'Brand drugs designated as preferred on the prescription drug list', false),
('non_preferred_rx_tier3', 'Non-Preferred Brand Drugs (Tier 3)', 'rx', 'Brand drugs designated as non-preferred on the prescription drug list', false),
('specialty_rx_tier4', 'Specialty Drugs (Tier 4)', 'rx', 'Specialty prescription drug products', false),
('preventive_rx', 'Preventive Medications', 'rx', 'Federally required preventive drugs at no charge', true),
('chemotherapy_rx', 'Chemotherapy Medication', 'rx', 'Prescription self-injectable and oral chemotherapy medication', false),

-- ── Therapy & Rehabilitation ─────────────────────────────────────────────────
('pt_rehab', 'Physical Therapy', 'therapy', 'Outpatient physical therapy rehabilitation services', false),
('ot_rehab', 'Occupational Therapy', 'therapy', 'Outpatient occupational therapy services', false),
('speech_therapy', 'Speech Therapy', 'therapy', 'Outpatient speech therapy services', false),
('pulmonary_rehab', 'Pulmonary Rehabilitation', 'therapy', 'Outpatient pulmonary rehabilitation therapy', false),
('cognitive_therapy', 'Cognitive Therapy', 'therapy', 'Outpatient cognitive therapy services', false),
('cardiac_rehab', 'Cardiac Rehabilitation', 'therapy', 'Outpatient cardiac rehabilitation (typically 36-day calendar year max)', false),
('chiropractic', 'Chiropractic Care', 'therapy', 'Chiropractic therapy and spinal manipulation services', false),
('acupuncture', 'Acupuncture', 'therapy', 'Medically necessary acupuncture for treatment of pain or disease', false),
('habilitation', 'Habilitation Services', 'therapy', 'Services to help acquire skills for daily functioning (e.g., autism, congenital conditions)', false),

-- ── Mental Health & Substance Use ────────────────────────────────────────────
('mental_health_outpatient', 'Mental Health — Outpatient', 'mental_health', 'Outpatient mental health office visits: individual, family, group psychotherapy, medication management', false),
('mental_health_inpatient', 'Mental Health — Inpatient', 'mental_health', 'Inpatient mental health including acute inpatient and residential treatment', false),
('mental_health_telehealth', 'Mental Health — Telehealth', 'mental_health', 'Dedicated virtual behavioral health services (e.g., MDLIVE Behavioral)', false),
('mental_health_partial', 'Mental Health — Partial Hospitalization / IOP', 'mental_health', 'Outpatient partial hospitalization and intensive outpatient programs', false),
('substance_abuse_outpatient', 'Substance Use Disorder — Outpatient', 'mental_health', 'Outpatient substance use disorder treatment and counseling', false),
('substance_abuse_inpatient', 'Substance Use Disorder — Inpatient', 'mental_health', 'Inpatient detoxification, rehabilitation, and residential treatment', false),

-- ── Maternity ────────────────────────────────────────────────────────────────
('prenatal_visit', 'Maternity — Prenatal/Postnatal Office Visits', 'maternity', 'Initial visit to confirm pregnancy and subsequent prenatal/postnatal visits', false),
('delivery_facility', 'Maternity — Delivery Facility', 'maternity', 'Inpatient hospital or birthing center for childbirth delivery', false),
('delivery_professional', 'Maternity — Delivery Professional Services', 'maternity', 'Physician delivery charges (global maternity fee)', false),

-- ── DME & Prosthetics ────────────────────────────────────────────────────────
('durable_medical_equipment', 'Durable Medical Equipment', 'dme', 'DME such as wheelchairs, hospital beds, oxygen equipment, CPAP', false),
('prosthetics', 'External Prosthetic Appliances', 'dme', 'External prosthetic devices', false),
('diabetic_equipment', 'Diabetic Equipment', 'dme', 'Diabetic monitoring and management equipment', false),

-- ── Other Services ───────────────────────────────────────────────────────────
('home_health', 'Home Health Care', 'other', 'Home health care services including outpatient private nursing when medically necessary', false),
('skilled_nursing', 'Skilled Nursing Facility', 'other', 'Inpatient skilled nursing facility, rehabilitation hospital, sub-acute facility', false),
('hospice_inpatient', 'Hospice — Inpatient', 'other', 'Inpatient hospice care services', false),
('hospice_outpatient', 'Hospice — Outpatient', 'other', 'Outpatient hospice care services', false),
('bereavement_counseling', 'Bereavement Counseling', 'other', 'Counseling services provided as part of hospice care or by mental health professional', false),
('dialysis', 'Outpatient Dialysis', 'other', 'Outpatient dialysis services in facility or home setting', false),
('transplant', 'Transplant Services', 'other', 'All medically appropriate, non-experimental transplant services and related specialty care', false),
('nutritional_counseling', 'Nutritional Counseling', 'other', 'Counseling by a registered dietitian (limits may apply except for diabetes/MH)', false),
('genetic_counseling', 'Genetic Counseling', 'other', 'Pre- and post-genetic testing counseling (limits may apply)', false),
('allergy_treatment', 'Allergy Treatment / Injections', 'other', 'Allergy testing, treatment, and injection services', false),
('medical_pharmaceuticals', 'Medical Pharmaceuticals (Inpatient)', 'other', 'Inpatient administered drugs including specialty medical pharmaceuticals', false),
('gene_therapy', 'Gene Therapy', 'other', 'Prior authorized gene therapy products and related administration services', false),
('abortion', 'Abortion Services', 'other', 'Elective and non-elective abortion procedures', false),
('bariatric_surgery', 'Bariatric / Obesity Surgery', 'other', 'Surgical treatment of clinically severe (morbid) obesity, subject to medical necessity', false),
('childrens_eye_exam', 'Children''s Eye Exam', 'other', 'Pediatric vision examination', false),
('childrens_glasses', 'Children''s Glasses', 'other', 'Pediatric corrective eyeglasses or lenses', false),
('childrens_dental', 'Children''s Dental Check-Up', 'other', 'Pediatric dental examination', false),
('dental_injury', 'Dental Care — Injury to Teeth', 'other', 'Dental treatment for a continuous course of treatment following injury to teeth', false)

ON CONFLICT (slug) DO NOTHING;
