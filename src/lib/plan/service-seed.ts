// TypeScript-side reference for service catalog slugs.
// S94 B1 (2026-05-15): rewritten to mirror the 68 canonical winners from
// plans/s94_unified_parser_meet_or_beat.md "Locked Canonical Winners".
// PROD service_catalog state IS the source of truth post-S94 reset
// (see scripts/s94-reset-and-reseed.ts). This file mirrors it so consumers
// that can't hit DB still have a typed reference.

import type { ServiceCategory } from "@/lib/supabase/types";

export interface ServiceDefinition {
  slug: string;
  name: string;
  category: ServiceCategory;
  isPreventiveEligible: boolean;
}

export const SERVICE_CATALOG: ServiceDefinition[] = [
  // dme (2)
  { slug: "durable_medical_equipment", name: "Durable Medical Equipment", category: "dme", isPreventiveEligible: false },
  { slug: "hearing_aids", name: "Hearing Aids", category: "dme", isPreventiveEligible: false },

  // emergency (5)
  { slug: "er_visit", name: "Emergency Room Visit", category: "emergency", isPreventiveEligible: false },
  { slug: "urgent_care", name: "Urgent Care Visit", category: "emergency", isPreventiveEligible: false },
  { slug: "emergency_transport_ground", name: "Emergency Medical Transportation — Ground", category: "emergency", isPreventiveEligible: false },
  { slug: "emergency_transport_air", name: "Emergency Medical Transportation — Air", category: "emergency", isPreventiveEligible: false },
  { slug: "non_emergency_care_outside_us", name: "Non-Emergency Care Outside the US", category: "emergency", isPreventiveEligible: false },

  // hospital (6)
  { slug: "bariatric_surgery", name: "Bariatric / Obesity Surgery", category: "hospital", isPreventiveEligible: false },
  { slug: "cosmetic_surgery", name: "Cosmetic Surgery", category: "hospital", isPreventiveEligible: false },
  { slug: "inpatient_facility", name: "Hospital Stay — Facility", category: "hospital", isPreventiveEligible: false },
  { slug: "inpatient_physician", name: "Hospital Stay — Physician / Surgeon", category: "hospital", isPreventiveEligible: false },
  { slug: "outpatient_surgery_facility", name: "Outpatient Surgery — Facility", category: "hospital", isPreventiveEligible: false },
  { slug: "outpatient_surgery_physician", name: "Outpatient Surgery — Physician / Surgeon", category: "hospital", isPreventiveEligible: false },

  // imaging (3)
  { slug: "advanced_imaging", name: "Advanced Imaging (CT/PET/MRI)", category: "imaging", isPreventiveEligible: false },
  { slug: "diagnostic_test", name: "Diagnostic Test (X-ray, Blood Work)", category: "imaging", isPreventiveEligible: false },
  { slug: "imaging_basic", name: "Basic Imaging (X-ray / Ultrasound)", category: "imaging", isPreventiveEligible: false },

  // lab (1)
  { slug: "lab_outpatient", name: "Lab — Outpatient", category: "lab", isPreventiveEligible: false },

  // long_term_care (5) — bucket under 'other' per service_catalog.category CHECK
  { slug: "hospice_inpatient", name: "Hospice — Inpatient", category: "other", isPreventiveEligible: false },
  { slug: "hospice_outpatient", name: "Hospice — Outpatient", category: "other", isPreventiveEligible: false },
  { slug: "long_term_care", name: "Long-Term Care", category: "other", isPreventiveEligible: false },
  { slug: "private_duty_nursing", name: "Private Duty Nursing", category: "other", isPreventiveEligible: false },
  { slug: "skilled_nursing", name: "Skilled Nursing Facility", category: "other", isPreventiveEligible: false },

  // maternity (5)
  { slug: "delivery_facility", name: "Maternity — Delivery Facility", category: "maternity", isPreventiveEligible: false },
  { slug: "delivery_professional", name: "Maternity — Delivery Professional Services", category: "maternity", isPreventiveEligible: false },
  { slug: "infertility_treatment", name: "Infertility Treatment", category: "maternity", isPreventiveEligible: false },
  { slug: "prenatal_visit", name: "Maternity — Prenatal/Postnatal Office Visits", category: "maternity", isPreventiveEligible: false },
  { slug: "well_baby", name: "Well-Baby Visit", category: "maternity", isPreventiveEligible: true },

  // mental_health (4)
  { slug: "mental_health_outpatient", name: "Mental Health — Outpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "mental_health_inpatient", name: "Mental Health — Inpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "substance_abuse_outpatient", name: "Substance Use Disorder — Outpatient", category: "mental_health", isPreventiveEligible: false },
  { slug: "substance_abuse_inpatient", name: "Substance Use Disorder — Inpatient", category: "mental_health", isPreventiveEligible: false },

  // office_visit (5)
  { slug: "pcp_visit", name: "Primary Care Visit", category: "office_visit", isPreventiveEligible: false },
  { slug: "specialist_visit", name: "Specialist Visit", category: "office_visit", isPreventiveEligible: false },
  { slug: "home_health", name: "Home Health Care", category: "office_visit", isPreventiveEligible: false },
  { slug: "telehealth_pcp", name: "Telehealth — Primary Care", category: "office_visit", isPreventiveEligible: false },
  { slug: "telehealth_specialist", name: "Telehealth — Specialist", category: "office_visit", isPreventiveEligible: false },

  // other (1)
  { slug: "childrens_dental", name: "Children's Dental Check-Up", category: "other", isPreventiveEligible: true },

  // preventive (13)
  { slug: "preventive_care", name: "Preventive Care / Screening / Immunization", category: "preventive", isPreventiveEligible: true },
  { slug: "immunizations", name: "Immunizations", category: "preventive", isPreventiveEligible: true },
  { slug: "annual_physical", name: "Annual Physical Exam", category: "preventive", isPreventiveEligible: true },
  { slug: "cancer_screening", name: "Cancer Screening", category: "preventive", isPreventiveEligible: true },
  { slug: "adult_dental_care", name: "Adult Dental Care", category: "preventive", isPreventiveEligible: false },
  { slug: "childrens_dental_checkup", name: "Children's Dental Checkup", category: "preventive", isPreventiveEligible: true },
  { slug: "childrens_eye_exam", name: "Children's Eye Exam", category: "preventive", isPreventiveEligible: true },
  { slug: "childrens_glasses", name: "Children's Glasses", category: "preventive", isPreventiveEligible: true },
  { slug: "routine_eye_care_adult", name: "Routine Eye Care — Adult", category: "preventive", isPreventiveEligible: false },
  { slug: "weight_loss_programs", name: "Weight Loss Programs", category: "preventive", isPreventiveEligible: false },
  { slug: "vision_exam", name: "Vision Exam (Age-Agnostic)", category: "preventive", isPreventiveEligible: true },
  { slug: "vision_hardware", name: "Vision Hardware (Glasses / Contacts)", category: "preventive", isPreventiveEligible: false },
  { slug: "dental_orthodontic", name: "Dental — Orthodontic", category: "preventive", isPreventiveEligible: false },

  // rx (9)
  { slug: "generic_rx_tier1", name: "Generic Drugs (Tier 1)", category: "rx", isPreventiveEligible: false },
  { slug: "generic_rx_tier1_90day", name: "Generic Drugs (Tier 1) — 90-Day Supply", category: "rx", isPreventiveEligible: false },
  { slug: "preferred_brand_rx_tier2", name: "Preferred Brand Drugs (Tier 2)", category: "rx", isPreventiveEligible: false },
  { slug: "preferred_brand_rx_90day", name: "Preferred Brand Drugs (Tier 2) — 90-Day Supply", category: "rx", isPreventiveEligible: false },
  { slug: "non_preferred_rx_tier3", name: "Non-Preferred Brand Drugs (Tier 3)", category: "rx", isPreventiveEligible: false },
  { slug: "non_preferred_rx_90day", name: "Non-Preferred Brand Drugs (Tier 3) — 90-Day Supply", category: "rx", isPreventiveEligible: false },
  { slug: "specialty_rx_tier4", name: "Specialty Drugs (Tier 4)", category: "rx", isPreventiveEligible: false },
  { slug: "preventive_rx", name: "Preventive Medications", category: "rx", isPreventiveEligible: true },
  { slug: "chemotherapy_rx", name: "Chemotherapy Medication", category: "rx", isPreventiveEligible: false },

  // therapy (9)
  { slug: "acupuncture", name: "Acupuncture", category: "therapy", isPreventiveEligible: false },
  { slug: "chiropractic", name: "Chiropractic Care", category: "therapy", isPreventiveEligible: false },
  { slug: "habilitation", name: "Habilitation Services", category: "therapy", isPreventiveEligible: false },
  { slug: "nutritional_counseling", name: "Nutritional Counseling", category: "therapy", isPreventiveEligible: false },
  { slug: "ot_rehab", name: "Occupational Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "pt_rehab", name: "Physical Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "routine_foot_care", name: "Routine Foot Care", category: "therapy", isPreventiveEligible: false },
  { slug: "speech_therapy", name: "Speech Therapy", category: "therapy", isPreventiveEligible: false },
  { slug: "cardiac_rehab", name: "Cardiac Rehabilitation", category: "therapy", isPreventiveEligible: false },
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
