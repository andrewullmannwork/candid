// TypeScript-side reference for service catalog slugs
// Mirrors the SQL seed in 010_service_catalog_seed.sql
// Used by SBC parser and profile API to map services without querying DB

import type { ServiceCategory } from "@/lib/supabase/types";

export interface ServiceDefinition {
  slug: string;
  name: string;
  category: ServiceCategory;
  isPreventiveEligible: boolean;
}

export const SERVICE_CATALOG: ServiceDefinition[] = [
  // Office Visits
  { slug: "pcp_visit", name: "Primary Care Visit", category: "office_visit", isPreventiveEligible: false },
  { slug: "specialist_visit", name: "Specialist Visit", category: "office_visit", isPreventiveEligible: false },
  { slug: "telehealth_pcp", name: "Telehealth — Primary Care", category: "office_visit", isPreventiveEligible: false },
  { slug: "telehealth_specialist", name: "Telehealth — Specialist", category: "office_visit", isPreventiveEligible: false },
  { slug: "convenience_care_clinic", name: "Convenience Care Clinic", category: "office_visit", isPreventiveEligible: false },
  { slug: "second_opinion", name: "Second Opinion Consultation", category: "office_visit", isPreventiveEligible: false },
  // Preventive
  { slug: "preventive_care", name: "Preventive Care / Screening / Immunization", category: "preventive", isPreventiveEligible: true },
  { slug: "annual_physical", name: "Annual Physical Exam", category: "preventive", isPreventiveEligible: true },
  { slug: "immunizations", name: "Immunizations", category: "preventive", isPreventiveEligible: true },
  { slug: "cancer_screening", name: "Cancer Screening", category: "preventive", isPreventiveEligible: true },
  { slug: "well_child_visit", name: "Well-Child Visit", category: "preventive", isPreventiveEligible: true },
  { slug: "womens_sterilization", name: "Women's Surgical Sterilization", category: "preventive", isPreventiveEligible: true },
  // Emergency
  { slug: "er_visit", name: "Emergency Room Visit", category: "emergency", isPreventiveEligible: false },
  { slug: "emergency_transport_ground", name: "Emergency Medical Transportation — Ground", category: "emergency", isPreventiveEligible: false },
  { slug: "emergency_transport_air", name: "Emergency Medical Transportation — Air", category: "emergency", isPreventiveEligible: false },
  { slug: "urgent_care", name: "Urgent Care Visit", category: "emergency", isPreventiveEligible: false },
  // Hospital
  { slug: "inpatient_facility", name: "Hospital Stay — Facility", category: "hospital", isPreventiveEligible: false },
  { slug: "inpatient_physician", name: "Hospital Stay — Physician/Surgeon", category: "hospital", isPreventiveEligible: false },
  { slug: "outpatient_surgery_facility", name: "Outpatient Surgery — Facility", category: "hospital", isPreventiveEligible: false },
  { slug: "outpatient_surgery_physician", name: "Outpatient Surgery — Physician/Surgeon", category: "hospital", isPreventiveEligible: false },
  // Imaging
  { slug: "diagnostic_test", name: "Diagnostic Test (X-ray, Blood Work)", category: "imaging", isPreventiveEligible: false },
  { slug: "advanced_imaging", name: "Advanced Imaging (CT/PET/MRI)", category: "imaging", isPreventiveEligible: false },
  { slug: "radiology_basic", name: "Basic Radiology", category: "imaging", isPreventiveEligible: false },
  // Lab
  { slug: "lab_pcp_office", name: "Lab — PCP Office", category: "lab", isPreventiveEligible: false },
  { slug: "lab_specialist_office", name: "Lab — Specialist Office", category: "lab", isPreventiveEligible: false },
  { slug: "lab_outpatient_facility", name: "Lab — Outpatient Hospital", category: "lab", isPreventiveEligible: false },
  { slug: "lab_independent", name: "Lab — Independent Facility", category: "lab", isPreventiveEligible: false },
  // Rx
  { slug: "generic_rx_tier1", name: "Generic Drugs (Tier 1)", category: "rx", isPreventiveEligible: false },
  { slug: "preferred_brand_rx_tier2", name: "Preferred Brand Drugs (Tier 2)", category: "rx", isPreventiveEligible: false },
  { slug: "non_preferred_rx_tier3", name: "Non-Preferred Brand Drugs (Tier 3)", category: "rx", isPreventiveEligible: false },
  { slug: "specialty_rx_tier4", name: "Specialty Drugs (Tier 4)", category: "rx", isPreventiveEligible: false },
  { slug: "preventive_rx", name: "Preventive Medications", category: "rx", isPreventiveEligible: true },
  { slug: "chemotherapy_rx", name: "Chemotherapy Medication", category: "rx", isPreventiveEligible: false },
  // Therapy
  { slug: "pt_rehab", name: "Physical Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "ot_rehab", name: "Occupational Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "speech_therapy", name: "Speech Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "pulmonary_rehab", name: "Pulmonary Rehabilitation", category: "therapy", isPreventiveEligible: false },
  { slug: "cognitive_therapy", name: "Cognitive Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "cardiac_rehab", name: "Cardiac Rehabilitation", category: "therapy", isPreventiveEligible: false },
  { slug: "chiropractic", name: "Chiropractic Care", category: "therapy", isPreventiveEligible: false },
  { slug: "acupuncture", name: "Acupuncture", category: "therapy", isPreventiveEligible: false },
  { slug: "habilitation", name: "Habilitation Services", category: "therapy", isPreventiveEligible: false },
  // Mental Health
  { slug: "mental_health_outpatient", name: "Mental Health — Outpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "mental_health_inpatient", name: "Mental Health — Inpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "mental_health_telehealth", name: "Mental Health — Telehealth", category: "mental_health", isPreventiveEligible: false },
  { slug: "mental_health_partial", name: "Mental Health — Partial Hospitalization / IOP", category: "mental_health", isPreventiveEligible: false },
  { slug: "substance_abuse_outpatient", name: "Substance Use Disorder — Outpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "substance_abuse_inpatient", name: "Substance Use Disorder — Inpatient", category: "mental_health", isPreventiveEligible: false },
  // Maternity
  { slug: "prenatal_visit", name: "Maternity — Prenatal/Postnatal Office Visits", category: "maternity", isPreventiveEligible: false },
  { slug: "delivery_facility", name: "Maternity — Delivery Facility", category: "maternity", isPreventiveEligible: false },
  { slug: "delivery_professional", name: "Maternity — Delivery Professional Services", category: "maternity", isPreventiveEligible: false },
  // DME
  { slug: "durable_medical_equipment", name: "Durable Medical Equipment", category: "dme", isPreventiveEligible: false },
  { slug: "prosthetics", name: "External Prosthetic Appliances", category: "dme", isPreventiveEligible: false },
  { slug: "diabetic_equipment", name: "Diabetic Equipment", category: "dme", isPreventiveEligible: false },
  // Other
  { slug: "home_health", name: "Home Health Care", category: "other", isPreventiveEligible: false },
  { slug: "skilled_nursing", name: "Skilled Nursing Facility", category: "other", isPreventiveEligible: false },
  { slug: "hospice_inpatient", name: "Hospice — Inpatient", category: "other", isPreventiveEligible: false },
  { slug: "hospice_outpatient", name: "Hospice — Outpatient", category: "other", isPreventiveEligible: false },
  { slug: "bereavement_counseling", name: "Bereavement Counseling", category: "other", isPreventiveEligible: false },
  { slug: "dialysis", name: "Outpatient Dialysis", category: "other", isPreventiveEligible: false },
  { slug: "transplant", name: "Transplant Services", category: "other", isPreventiveEligible: false },
  { slug: "nutritional_counseling", name: "Nutritional Counseling", category: "other", isPreventiveEligible: false },
  { slug: "genetic_counseling", name: "Genetic Counseling", category: "other", isPreventiveEligible: false },
  { slug: "allergy_treatment", name: "Allergy Treatment / Injections", category: "other", isPreventiveEligible: false },
  { slug: "medical_pharmaceuticals", name: "Medical Pharmaceuticals (Inpatient)", category: "other", isPreventiveEligible: false },
  { slug: "gene_therapy", name: "Gene Therapy", category: "other", isPreventiveEligible: false },
  { slug: "abortion", name: "Abortion Services", category: "other", isPreventiveEligible: false },
  { slug: "bariatric_surgery", name: "Bariatric / Obesity Surgery", category: "other", isPreventiveEligible: false },
  { slug: "childrens_eye_exam", name: "Children's Eye Exam", category: "other", isPreventiveEligible: false },
  { slug: "childrens_glasses", name: "Children's Glasses", category: "other", isPreventiveEligible: false },
  { slug: "childrens_dental", name: "Children's Dental Check-Up", category: "other", isPreventiveEligible: false },
  { slug: "dental_injury", name: "Dental Care — Injury to Teeth", category: "other", isPreventiveEligible: false },
];

// Slug lookup map (built once)
const slugMap = new Map(SERVICE_CATALOG.map((s) => [s.slug, s]));

/** Get a service definition by slug. Returns undefined if not found. */
export function getServiceBySlug(slug: string): ServiceDefinition | undefined {
  return slugMap.get(slug);
}

/** Get all service slugs. */
export function getAllSlugs(): string[] {
  return SERVICE_CATALOG.map((s) => s.slug);
}
