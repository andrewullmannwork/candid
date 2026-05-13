/**
 * Seed script for zero_cost_share_codes (S74.5 D13).
 *
 * Idempotent UPSERT on (billing_code, billing_code_type, coverage_basis).
 * Re-run on guideline changes (annual refresh) — UPSERT updates retired_at /
 * source_label / display_name without requiring a new migration.
 *
 * v1 starter set: ~70 highest-volume codes from HRSA Women's Preventive
 * Services + USPSTF Grade A/B + Bright Futures pediatric + CDC ACIP vaccine
 * schedule. Each row carries a source_url citation. Expansion to full ~200
 * codes is tracked as a follow-up; admins can add rows via the admin queue
 * (Pattern P-9) without code changes.
 *
 * IMPORTANT — review before re-running for guideline changes:
 *   - Verify each source_url still resolves
 *   - Check USPSTF grades (Grade B services can change classification annually)
 *   - Check ACIP schedule changes (new vaccine approvals, retired products)
 *   - When a code retires, set retired_at via admin UI rather than DELETE
 *     (Pattern 1 #10 — preserve forensic trail)
 *
 * Run: npx tsx scripts/seed-zero-cost-share-codes.ts
 *
 * Loads credentials from .env.local at the candid repo root (same pattern as
 * scripts/dedupe-existing-disputes.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface SeedRow {
  billing_code: string;
  billing_code_type: "CPT" | "HCPCS_L2" | "G_CODE" | "CAT_II";
  coverage_basis: "ACA_preventive" | "ACIP_vaccine";
  category: string;
  uspstf_grade?: "A" | "B";
  age_min?: number;
  age_max?: number;
  sex?: "M" | "F";
  frequency_limit?: string;
  source_url: string;
  source_label: string;
  display_name: string;
  notes?: string;
}

// ============================================================================
// ACA preventive — wellness/periodic E&M (CPT 99381-99397)
// ============================================================================
// Per Bright Futures (pediatric) + USPSTF + HRSA — annual physical-like visits
// covered at $0 cost-share for ACA-compliant plans across age ranges.
const PERIODIC_PREVENTIVE: SeedRow[] = [
  {
    billing_code: "99381",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_max: 0,
    source_label: "Bright Futures / ACA periodic preventive — infant",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Infant (under 1)",
  },
  {
    billing_code: "99382",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 1,
    age_max: 4,
    source_label: "Bright Futures / ACA periodic preventive — early childhood",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Early Childhood (1-4)",
  },
  {
    billing_code: "99383",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 5,
    age_max: 11,
    source_label: "Bright Futures / ACA periodic preventive — late childhood",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Late Childhood (5-11)",
  },
  {
    billing_code: "99384",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 12,
    age_max: 17,
    source_label: "Bright Futures / ACA periodic preventive — adolescent",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Adolescent (12-17)",
  },
  {
    billing_code: "99385",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 18,
    age_max: 39,
    source_label: "ACA periodic preventive — adult new patient 18-39",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Adult (18-39) New Patient",
  },
  {
    billing_code: "99386",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 40,
    age_max: 64,
    source_label: "ACA periodic preventive — adult new patient 40-64",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Adult (40-64) New Patient",
  },
  {
    billing_code: "99387",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 65,
    source_label: "ACA periodic preventive — senior new patient 65+",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Senior (65+) New Patient",
  },
  {
    billing_code: "99391",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_max: 0,
    source_label: "Bright Futures / ACA established patient — infant",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Infant Established",
  },
  {
    billing_code: "99392",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 1,
    age_max: 4,
    source_label: "Bright Futures / ACA established patient — early childhood",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Early Childhood Established",
  },
  {
    billing_code: "99393",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 5,
    age_max: 11,
    source_label: "Bright Futures / ACA established patient — late childhood",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Late Childhood Established",
  },
  {
    billing_code: "99394",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 12,
    age_max: 17,
    source_label: "Bright Futures / ACA established patient — adolescent",
    source_url: "https://www.hrsa.gov/sites/default/files/hrsa/bright-futures/periodicity-schedule.pdf",
    display_name: "Preventive Visit — Adolescent Established",
  },
  {
    billing_code: "99395",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 18,
    age_max: 39,
    source_label: "ACA periodic preventive — adult established patient 18-39",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Adult (18-39) Established",
    notes: "Andrew's Swedish bill — D13 unlocks his $146 finding via this row + ACIP vaccine rows.",
  },
  {
    billing_code: "99396",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 40,
    age_max: 64,
    source_label: "ACA periodic preventive — adult established patient 40-64",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Adult (40-64) Established",
  },
  {
    billing_code: "99397",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    age_min: 65,
    source_label: "ACA periodic preventive — senior established patient 65+",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Visit — Senior (65+) Established",
  },
  {
    billing_code: "G0438",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    source_label: "CMS Medicare Annual Wellness Visit — initial",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Medicare Annual Wellness Visit — Initial",
  },
  {
    billing_code: "G0439",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "wellness_visit",
    source_label: "CMS Medicare Annual Wellness Visit — subsequent",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Medicare Annual Wellness Visit — Subsequent",
  },
];

// ============================================================================
// ACA preventive — screenings (USPSTF Grade A/B)
// ============================================================================
const SCREENINGS: SeedRow[] = [
  {
    billing_code: "77067",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "B",
    age_min: 40,
    sex: "F",
    frequency_limit: "1/year",
    source_label: "USPSTF Grade B — Breast cancer screening (mammography)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/breast-cancer-screening",
    display_name: "Screening Mammography",
  },
  {
    billing_code: "G0202",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "B",
    age_min: 40,
    sex: "F",
    source_label: "CMS Medicare screening mammography",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Screening Mammography (Medicare)",
  },
  {
    billing_code: "45378",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    age_min: 45,
    age_max: 75,
    source_label: "USPSTF Grade A — Colorectal cancer screening",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening",
    display_name: "Screening Colonoscopy",
  },
  {
    billing_code: "G0121",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    source_label: "CMS Medicare colorectal screening — avg risk",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Colonoscopy Screening (Average Risk)",
  },
  {
    billing_code: "G0105",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    source_label: "CMS Medicare colorectal screening — high risk",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Colonoscopy Screening (High Risk)",
  },
  {
    billing_code: "G0104",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    source_label: "CMS Medicare sigmoidoscopy screening",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Screening Sigmoidoscopy",
  },
  {
    billing_code: "81528",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    source_label: "USPSTF Grade A — Stool DNA test (Cologuard)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening",
    display_name: "Stool DNA Screening (Cologuard)",
  },
  {
    billing_code: "G0103",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "screening",
    age_min: 55,
    sex: "M",
    source_label: "CMS Medicare PSA screening",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "PSA Screening",
  },
  {
    billing_code: "88141",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    sex: "F",
    age_min: 21,
    age_max: 65,
    source_label: "USPSTF Grade A — Cervical cancer screening (Pap)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/cervical-cancer-screening",
    display_name: "Pap Smear (Cervical Screening)",
  },
  {
    billing_code: "88150",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    sex: "F",
    age_min: 21,
    age_max: 65,
    source_label: "USPSTF Grade A — Cervical cancer screening (Pap)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/cervical-cancer-screening",
    display_name: "Pap Smear (Cervical Screening)",
  },
  {
    billing_code: "87490",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    sex: "F",
    age_min: 30,
    age_max: 65,
    source_label: "USPSTF Grade A — High-risk HPV testing",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/cervical-cancer-screening",
    display_name: "HPV Testing",
  },
  {
    billing_code: "87491",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    sex: "F",
    source_label: "USPSTF Grade A — High-risk HPV testing",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/cervical-cancer-screening",
    display_name: "HPV Testing",
  },
  {
    billing_code: "80061",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "B",
    source_label: "USPSTF Grade B — Lipid screening (statin prevention)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/statin-use-in-adults-preventive-medication",
    display_name: "Lipid Panel Screening",
  },
  {
    billing_code: "83036",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "B",
    age_min: 35,
    source_label: "USPSTF Grade B — Prediabetes / type 2 diabetes screening",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/screening-for-prediabetes-and-type-2-diabetes",
    display_name: "Hemoglobin A1C Screening",
  },
  {
    billing_code: "82947",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "B",
    source_label: "USPSTF Grade B — Diabetes screening (glucose)",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/screening-for-prediabetes-and-type-2-diabetes",
    display_name: "Fasting Glucose Screening",
  },
  {
    billing_code: "86703",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "screening",
    uspstf_grade: "A",
    age_min: 15,
    age_max: 65,
    source_label: "USPSTF Grade A — HIV screening",
    source_url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/human-immunodeficiency-virus-hiv-infection-screening",
    display_name: "HIV Screening",
  },
  {
    billing_code: "G0445",
    billing_code_type: "G_CODE",
    coverage_basis: "ACA_preventive",
    category: "counseling",
    uspstf_grade: "B",
    source_label: "CMS Medicare HIV counseling",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "HIV Counseling — Behavioral",
  },
];

// ============================================================================
// ACA preventive — counseling
// ============================================================================
const COUNSELING: SeedRow[] = [
  {
    billing_code: "99401",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "counseling",
    source_label: "ACA preventive counseling 15-min",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Counseling (15 min)",
  },
  {
    billing_code: "99402",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "counseling",
    source_label: "ACA preventive counseling 30-min",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Counseling (30 min)",
  },
  {
    billing_code: "99403",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "counseling",
    source_label: "ACA preventive counseling 45-min",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Counseling (45 min)",
  },
  {
    billing_code: "99404",
    billing_code_type: "CPT",
    coverage_basis: "ACA_preventive",
    category: "counseling",
    source_label: "ACA preventive counseling 60-min",
    source_url: "https://www.healthcare.gov/coverage/preventive-care-benefits/",
    display_name: "Preventive Counseling (60 min)",
  },
];

// ============================================================================
// ACIP vaccines — vaccine PRODUCT codes (CPT 90xxx + COVID-19 91300-91322)
// ============================================================================
const VACCINE_PRODUCTS: SeedRow[] = [
  // Influenza
  {
    billing_code: "90630",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Influenza vaccine (intradermal)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Influenza Vaccine (Intradermal)",
  },
  {
    billing_code: "90653",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    age_min: 65,
    source_label: "ACIP — Influenza vaccine high-dose 65+",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Influenza Vaccine (Quadrivalent High-Dose)",
  },
  {
    billing_code: "90658",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Influenza vaccine trivalent",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Influenza Vaccine (Trivalent)",
  },
  {
    billing_code: "90686",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Influenza vaccine quadrivalent",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Influenza Vaccine (Quadrivalent)",
  },
  {
    billing_code: "90756",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Influenza vaccine cell-cultured",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Influenza Vaccine (Cell-Cultured Quadrivalent)",
  },
  // Pneumococcal
  {
    billing_code: "90670",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Pneumococcal conjugate (PCV13)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Pneumococcal Conjugate Vaccine (PCV13)",
  },
  {
    billing_code: "90732",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    age_min: 65,
    source_label: "ACIP — Pneumococcal polysaccharide (PPSV23)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Pneumococcal Polysaccharide Vaccine (PPSV23)",
  },
  // MMR / Varicella
  {
    billing_code: "90707",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Measles/Mumps/Rubella (MMR)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "MMR Vaccine",
  },
  {
    billing_code: "90716",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Varicella vaccine",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "Varicella Vaccine",
  },
  // HepB / HepA
  {
    billing_code: "90746",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Hepatitis B (adult)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Hepatitis B Vaccine (Adult)",
  },
  {
    billing_code: "90744",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Hepatitis B (pediatric/adolescent)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "Hepatitis B Vaccine (Pediatric)",
  },
  {
    billing_code: "90633",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Hepatitis A pediatric/adolescent",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "Hepatitis A Vaccine (Pediatric)",
  },
  // DTaP / Tdap
  {
    billing_code: "90700",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — DTaP",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "DTaP Vaccine",
  },
  {
    billing_code: "90715",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Tdap (booster)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Tdap Vaccine",
  },
  // Meningococcal
  {
    billing_code: "90734",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — Meningococcal conjugate (MenACWY)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Meningococcal Vaccine (MenACWY)",
  },
  // HPV
  {
    billing_code: "90651",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    age_min: 9,
    age_max: 45,
    source_label: "ACIP — HPV 9-valent (Gardasil 9)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "HPV Vaccine (9-valent)",
  },
  // Zoster (Shingrix)
  {
    billing_code: "90750",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    age_min: 50,
    source_label: "ACIP — Recombinant zoster vaccine (Shingrix)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Shingles Vaccine (Shingrix)",
  },
  // COVID-19 (91300-91322 range; 91320 is one of Andrew's bill codes)
  {
    billing_code: "91300",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — COVID-19 mRNA (Pfizer 30mcg)",
    source_url: "https://www.cdc.gov/vaccines/covid-19/clinical-considerations/covid-19-vaccines-us.html",
    display_name: "COVID-19 Vaccine (Pfizer 30mcg)",
  },
  {
    billing_code: "91313",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — COVID-19 mRNA bivalent booster",
    source_url: "https://www.cdc.gov/vaccines/covid-19/clinical-considerations/covid-19-vaccines-us.html",
    display_name: "COVID-19 Vaccine (Bivalent Booster)",
  },
  {
    billing_code: "91320",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — COVID-19 mRNA (current formulation)",
    source_url: "https://www.cdc.gov/vaccines/covid-19/clinical-considerations/covid-19-vaccines-us.html",
    display_name: "COVID-19 Vaccine (Current Formulation)",
    notes: "Andrew's Swedish bill — D13 unlocks his $146 finding via this row + ACA preventive visit row.",
  },
  {
    billing_code: "91322",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "immunization",
    source_label: "ACIP — COVID-19 updated formulation",
    source_url: "https://www.cdc.gov/vaccines/covid-19/clinical-considerations/covid-19-vaccines-us.html",
    display_name: "COVID-19 Vaccine (Updated Formulation)",
  },
];

// ============================================================================
// Vaccine ADMINISTRATION codes (CPT 90460-90474 + Medicare G-codes)
// ============================================================================
const VACCINE_ADMIN: SeedRow[] = [
  {
    billing_code: "90460",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    age_max: 18,
    source_label: "ACIP — Immunization admin under 19 first/single component",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "Immunization Admin — Under 19 (First Component)",
  },
  {
    billing_code: "90461",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    age_max: 18,
    source_label: "ACIP — Immunization admin under 19 each additional component",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/child-adolescent.html",
    display_name: "Immunization Admin — Under 19 (Additional Components)",
  },
  {
    billing_code: "90471",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "ACIP — Immunization admin (general, first dose)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Immunization Administration (First/Single Vaccine)",
  },
  {
    billing_code: "90472",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "ACIP — Immunization admin (each additional)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Immunization Administration (Each Additional Vaccine)",
  },
  {
    billing_code: "90473",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "ACIP — Immunization admin (intranasal/oral, first dose)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Immunization Administration (Intranasal/Oral, First)",
  },
  {
    billing_code: "90474",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "ACIP — Immunization admin (intranasal/oral, each additional)",
    source_url: "https://www.cdc.gov/vaccines/schedules/hcp/imz/adult.html",
    display_name: "Immunization Administration (Intranasal/Oral, Additional)",
  },
  {
    billing_code: "90480",
    billing_code_type: "CPT",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "ACIP — COVID-19 vaccine admin (current)",
    source_url: "https://www.cdc.gov/vaccines/covid-19/clinical-considerations/covid-19-vaccines-us.html",
    display_name: "COVID-19 Vaccine Administration",
    notes: "Andrew's Swedish bill — vaccine admin pair with 91320.",
  },
  {
    billing_code: "G0008",
    billing_code_type: "G_CODE",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "CMS Medicare flu vaccine admin",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Flu Vaccine Admin (Medicare)",
  },
  {
    billing_code: "G0009",
    billing_code_type: "G_CODE",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "CMS Medicare pneumococcal vaccine admin",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Pneumococcal Vaccine Admin (Medicare)",
  },
  {
    billing_code: "G0010",
    billing_code_type: "G_CODE",
    coverage_basis: "ACIP_vaccine",
    category: "admin",
    source_label: "CMS Medicare hepatitis B vaccine admin",
    source_url: "https://www.cms.gov/Medicare/Prevention/PrevntionGenInfo/medicare-preventive-services",
    display_name: "Hep B Vaccine Admin (Medicare)",
  },
];

const ALL_ROWS: SeedRow[] = [
  ...PERIODIC_PREVENTIVE,
  ...SCREENINGS,
  ...COUNSELING,
  ...VACCINE_PRODUCTS,
  ...VACCINE_ADMIN,
];

async function main() {
  console.log(`[seed-zero-cost-share] starting; ${ALL_ROWS.length} rows queued`);

  let inserted = 0;
  const updated = 0;
  let failed = 0;

  for (const row of ALL_ROWS) {
    const { error } = await supabase
      .from("zero_cost_share_codes")
      .upsert(row, {
        onConflict: "billing_code,billing_code_type,coverage_basis",
        ignoreDuplicates: false,
      });

    if (error) {
      console.error(
        `  FAIL ${row.billing_code}/${row.coverage_basis}: ${error.message}`,
      );
      failed++;
    } else {
      // upsert doesn't tell us insert-vs-update; track best-effort
      inserted++;
    }
  }

  console.log(
    `[seed-zero-cost-share] done: ${inserted} upserted, ${updated} updated, ${failed} failed`,
  );
  console.log(`\nBreakdown:`);
  console.log(`  Periodic preventive (E/M): ${PERIODIC_PREVENTIVE.length}`);
  console.log(`  Screenings (USPSTF Grade A/B): ${SCREENINGS.length}`);
  console.log(`  Counseling: ${COUNSELING.length}`);
  console.log(`  Vaccine products: ${VACCINE_PRODUCTS.length}`);
  console.log(`  Vaccine administration: ${VACCINE_ADMIN.length}`);
  console.log(`  TOTAL: ${ALL_ROWS.length}`);

  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
