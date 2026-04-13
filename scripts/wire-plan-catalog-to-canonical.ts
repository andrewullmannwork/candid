#!/usr/bin/env npx tsx
/**
 * Wire Plan Catalog → Canonical Plans + Canonical Plan Services
 *
 * Reads plan_catalog entries (populated by CMS ingest scripts) and:
 * 1. Creates canonical_plans for each unique plan (matched by hios_id)
 * 2. Maps CMS benefit types → Candid service_slugs
 * 3. Creates canonical_plan_services with copay, coinsurance, coverage data
 *
 * This makes CMS plan data immediately visible on the plan page
 * when a user matches to a known plan — no SBC upload required.
 *
 * Usage:
 *   npx tsx scripts/wire-plan-catalog-to-canonical.ts              # all plans
 *   npx tsx scripts/wire-plan-catalog-to-canonical.ts --test        # first 10 plans
 *   npx tsx scripts/wire-plan-catalog-to-canonical.ts --state=TX    # one state
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars. Ensure .env.local is configured.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CMS Benefit Type → Candid Service Slug Mapping ─────────────────────────
// Maps the CMS Marketplace API benefit type enum to Candid's service_slug.
// Unmapped types are skipped (logged for future mapping).

const CMS_TO_CANDID: Record<string, string> = {
  // Office Visits
  PRIMARY_CARE_VISIT_TO_TREAT_AN_INJURY_OR_ILLNESS: "pcp_visit",
  SPECIALIST_VISIT: "specialist_visit",

  // Emergency
  EMERGENCY_ROOM_SERVICES: "er_visit",
  URGENT_CARE_CENTERS_OR_FACILITIES: "urgent_care",
  EMERGENCY_TRANSPORTATION_AMBULANCE_SERVICES: "emergency_transport_ground",

  // Preventive
  PREVENTIVE_CARE_SCREENING_IMMUNIZATION: "preventive_care",

  // Hospital
  INPATIENT_HOSPITAL_SERVICES_EG_HOSPITAL_STAY: "inpatient_facility",
  INPATIENT_PHYSICIAN_AND_SURGICAL_SERVICES: "inpatient_physician",
  OUTPATIENT_FACILITY_FEE_EG_AMBULATORY_SURGERY_CENTER: "outpatient_surgery_facility",
  OUTPATIENT_SURGERY_PHYSICIAN_SURGICAL_SERVICES: "outpatient_surgery_physician",

  // Imaging & Lab
  IMAGING_CT_PET_SCANS_MRIS: "advanced_imaging",
  X_RAYS_AND_DIAGNOSTIC_IMAGING: "diagnostic_test",
  LABORATORY_OUTPATIENT_AND_PROFESSIONAL_SERVICES: "lab_outpatient_facility",

  // Rx
  GENERIC_DRUGS: "generic_rx_tier1",
  PREFERRED_BRAND_DRUGS: "preferred_brand_rx_tier2",
  NON_PREFERRED_BRAND_DRUGS: "non_preferred_rx_tier3",
  SPECIALTY_DRUGS: "specialty_rx_tier4",

  // Mental Health
  MENTAL_BEHAVIORAL_HEALTH_OUTPATIENT_SERVICES: "mental_health_outpatient",
  MENTAL_BEHAVIORAL_HEALTH_INPATIENT_SERVICES: "mental_health_inpatient",
  SUBSTANCE_ABUSE_DISORDER_OUTPATIENT_TREATMENT: "substance_abuse_outpatient",
  SUBSTANCE_ABUSE_DISORDER_INPATIENT_TREATMENT: "substance_abuse_inpatient",

  // Maternity
  PRENATAL_AND_POSTNATAL_CARE: "prenatal_visit",
  DELIVERY_AND_ALL_INPATIENT_SERVICES_FOR_MATERNITY_CARE: "delivery_facility",

  // Therapy & Rehab
  REHABILITATION_SERVICES: "pt_rehab",
  HABILITATION_SERVICES: "habilitation",
  SPEECH_THERAPY: "speech_therapy",
  CHIROPRACTIC_CARE: "chiropractic",
  ACUPUNCTURE: "acupuncture",

  // Home & Post-Acute
  SKILLED_NURSING_FACILITY: "skilled_nursing",
  HOME_HEALTH_CARE: "home_health",
  HOSPICE_SERVICES: "hospice_inpatient",
  DURABLE_MEDICAL_EQUIPMENT: "durable_medical_equipment",

  // Children
  CHILDRENS_EYE_EXAM: "childrens_eye_exam",
  CHILDRENS_GLASSES: "childrens_glasses",
  CHILDRENS_DENTAL_CHECK_UP: "childrens_dental",
  DENTAL_CHECK_UP_FOR_CHILDREN: "childrens_dental",
  BASIC_DENTAL_CARE_CHILD: "childrens_dental",
  MAJOR_DENTAL_CARE_CHILD: "childrens_dental",

  // Dental (adult) — mapped to dental_injury as closest match
  ROUTINE_DENTAL_SERVICES_ADULT: "dental_injury",
  BASIC_DENTAL_CARE_ADULT: "dental_injury",
  MAJOR_DENTAL_CARE_ADULT: "dental_injury",

  // Nutritional
  NUTRITIONAL_COUNSELING: "nutritional_counseling",
};

// ── Display String Parser ───────────────────────────────────────────────────
// CMS in_network display strings follow predictable patterns:
//   "$35"                    → copay: 35
//   "20% Coinsurance"        → coinsurance: 0.20
//   "$30 Copay after deductible" → copay: 30, deductible_applies: true
//   "20% Coinsurance after deductible" → coinsurance: 0.20, deductible_applies: true
//   "No Charge"              → copay: 0
//   "No Charge after deductible" → copay: 0, deductible_applies: true
//   "Not Covered"            → is_covered: false

interface ParsedCost {
  copay: number | null;
  coinsurance: number | null;
  deductible_applies: boolean;
  is_covered: boolean;
}

function parseDisplayString(display: string | null | undefined): ParsedCost {
  const result: ParsedCost = {
    copay: null,
    coinsurance: null,
    deductible_applies: false,
    is_covered: true,
  };

  if (!display) return result;

  const d = display.trim();

  if (d === "Not Covered" || d.toLowerCase().includes("not covered")) {
    result.is_covered = false;
    return result;
  }

  if (d.toLowerCase().includes("after deductible")) {
    result.deductible_applies = true;
  }

  // "$X" or "$X Copay" patterns
  const copayMatch = d.match(/^\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
  if (copayMatch) {
    result.copay = parseFloat(copayMatch[1].replace(/,/g, ""));
    return result;
  }

  // "X% Coinsurance" patterns
  const coinsuranceMatch = d.match(/^(\d+)%\s*(?:Coinsurance|coinsurance)/);
  if (coinsuranceMatch) {
    result.coinsurance = parseInt(coinsuranceMatch[1]) / 100;
    return result;
  }

  // "No Charge" patterns
  if (d.toLowerCase().includes("no charge") || d === "$0") {
    result.copay = 0;
    return result;
  }

  return result;
}

// ── Main Wiring Logic ───────────────────────────────────────────────────────

interface BenefitSummary {
  type: string;
  name: string;
  covered: boolean;
  in_network?: string;
  copay_amount?: number | null;
  coinsurance_rate?: number | null;
}

async function main() {
  const args = process.argv.slice(2);
  const testMode = args.includes("--test");
  const stateArg = args.find((a) => a.startsWith("--state="));
  const targetState = stateArg?.split("=")[1];

  console.log("\n🔗 Wiring Plan Catalog → Canonical Plans + Services");
  console.log(`   Mode: ${testMode ? "TEST (10 plans)" : targetState ? `State: ${targetState}` : "ALL plans"}`);
  console.log(`   Supabase: ${SUPABASE_URL}\n`);

  // Load valid service slugs from service_catalog
  const { data: serviceCatalog } = await supabase
    .from("service_catalog")
    .select("slug, concept_id");
  const validSlugs = new Set(serviceCatalog?.map((s) => s.slug) || []);
  const slugConceptMap = new Map(
    serviceCatalog?.map((s) => [s.slug, s.concept_id]) || []
  );
  console.log(`  Loaded ${validSlugs.size} valid service slugs\n`);

  // Fetch ALL plan_catalog entries with raw_data (paginate past Supabase 1000-row limit)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let plans: any[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    let query = supabase
      .from("plan_catalog")
      .select("id, hios_id, insurer_id, plan_name, plan_type, state, year, metal_level, premium_individual, raw_data, fips_code")
      .not("raw_data", "is", null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (targetState) {
      query = query.eq("state", targetState);
    }

    if (testMode) {
      query = query.limit(10);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Failed to fetch plan_catalog:", error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    plans = plans.concat(data);
    if (data.length < PAGE_SIZE || testMode) break;
    offset += PAGE_SIZE;
  }

  if (plans.length === 0) {
    console.log("  No plans found in plan_catalog.");
    return;
  }

  console.log(`  Found ${plans.length} plans to wire\n`);

  let canonicalCreated = 0;
  let canonicalExisting = 0;
  let servicesCreated = 0;
  let servicesSkipped = 0;
  const unmappedTypes = new Map<string, number>();

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const rawData = plan.raw_data as Record<string, unknown>;
    const benefits = rawData?.benefits_summary as BenefitSummary[] | undefined;

    if (!benefits || benefits.length === 0) {
      continue;
    }

    // Step 1: Find or create canonical_plan by hios_id
    let canonicalPlanId: string | null = null;

    if (plan.hios_id) {
      const { data: existing } = await supabase
        .from("canonical_plans")
        .select("id")
        .eq("hios_id", plan.hios_id)
        .single();

      if (existing) {
        canonicalPlanId = existing.id;
        canonicalExisting++;
      }
    }

    if (!canonicalPlanId) {
      // Try matching by (insurer_id, plan_name, state, year)
      const { data: byName } = await supabase
        .from("canonical_plans")
        .select("id")
        .eq("insurer_id", plan.insurer_id)
        .eq("plan_name", plan.plan_name)
        .eq("state", plan.state)
        .eq("plan_year", plan.year)
        .single();

      if (byName) {
        canonicalPlanId = byName.id;
        canonicalExisting++;
        // Backfill hios_id if missing
        if (plan.hios_id) {
          await supabase
            .from("canonical_plans")
            .update({ hios_id: plan.hios_id })
            .eq("id", byName.id);
        }
      }
    }

    if (!canonicalPlanId) {
      // Create new canonical_plan
      const { data: created, error: createErr } = await supabase
        .from("canonical_plans")
        .insert({
          insurer_id: plan.insurer_id,
          plan_name: plan.plan_name,
          plan_type: plan.plan_type,
          state: plan.state,
          plan_year: plan.year,
          hios_id: plan.hios_id,
          metal_level: plan.metal_level?.toLowerCase() || null,
          deductible_individual: rawData?.deductible_individual as number || null,
          oop_max_individual: rawData?.oop_max_individual as number || null,
          premium_monthly: plan.premium_individual,
          confidence_score: 0.5,
          source_count: 1,
          raw_coverage_data: rawData,
          is_verified: false,
        })
        .select("id")
        .single();

      if (createErr) {
        // Might be a race condition / duplicate — try to find it
        if (createErr.message.includes("duplicate") || createErr.message.includes("unique")) {
          const { data: retry } = await supabase
            .from("canonical_plans")
            .select("id")
            .eq("insurer_id", plan.insurer_id)
            .eq("plan_name", plan.plan_name)
            .eq("state", plan.state)
            .eq("plan_year", plan.year)
            .single();
          if (retry) {
            canonicalPlanId = retry.id;
            canonicalExisting++;
          }
        }
        if (!canonicalPlanId) {
          console.warn(`  [${i + 1}] Failed to create canonical for ${plan.plan_name}: ${createErr.message}`);
          continue;
        }
      } else {
        canonicalPlanId = created!.id;
        canonicalCreated++;
      }
    }

    // Step 2: Map CMS benefits → canonical_plan_services
    const serviceInserts = [];

    for (const benefit of benefits) {
      const serviceSlug = CMS_TO_CANDID[benefit.type];

      if (!serviceSlug) {
        unmappedTypes.set(benefit.type, (unmappedTypes.get(benefit.type) || 0) + 1);
        continue;
      }

      if (!validSlugs.has(serviceSlug)) {
        continue; // Slug not in service_catalog
      }

      // Prefer structured data (from updated ingest), fall back to display string parsing
      const hasStructured = benefit.copay_amount !== undefined || benefit.coinsurance_rate !== undefined;
      const parsed = parseDisplayString(benefit.in_network);

      const copay = hasStructured
        ? (benefit.copay_amount ?? null)
        : parsed.copay;
      const coinsurance = hasStructured
        ? (benefit.coinsurance_rate ?? null)
        : parsed.coinsurance;

      serviceInserts.push({
        canonical_plan_id: canonicalPlanId,
        concept_id: slugConceptMap.get(serviceSlug) || null,
        service_slug: serviceSlug,
        copay,
        coinsurance,
        is_covered: benefit.covered && parsed.is_covered,
        requires_prior_auth: false,
        requires_referral: false,
        deductible_applies: parsed.deductible_applies,
        annual_limit: null,
        visit_limit: null,
        coverage_rules: {},
        confidence: 0.5,
        source: "cms_api",
      });
    }

    // Deduplicate by service_slug (multiple CMS types can map to the same slug)
    const dedupedInserts = new Map<string, typeof serviceInserts[0]>();
    for (const insert of serviceInserts) {
      if (!dedupedInserts.has(insert.service_slug)) {
        dedupedInserts.set(insert.service_slug, insert);
      }
    }
    const finalInserts = [...dedupedInserts.values()];

    if (finalInserts.length > 0) {
      const { error: svcErr } = await supabase
        .from("canonical_plan_services")
        .upsert(finalInserts, {
          onConflict: "canonical_plan_id,service_slug",
          ignoreDuplicates: false,
        });

      if (svcErr) {
        console.warn(`  [${i + 1}] Service upsert failed for ${plan.plan_name}: ${svcErr.message}`);
        servicesSkipped += finalInserts.length;
      } else {
        servicesCreated += finalInserts.length;
      }
    }

    if ((i + 1) % 100 === 0 || i === plans.length - 1) {
      process.stdout.write(
        `  [${i + 1}/${plans.length}] ${canonicalCreated} canonical plans created, ${servicesCreated} services wired\r`
      );
    }
  }

  console.log(`\n\n✅ Wiring complete`);
  console.log(`   Canonical plans: ${canonicalCreated} created, ${canonicalExisting} existing`);
  console.log(`   Services wired: ${servicesCreated}`);
  console.log(`   Services skipped: ${servicesSkipped}`);

  if (unmappedTypes.size > 0) {
    console.log(`\n⚠️  Unmapped CMS benefit types (add to CMS_TO_CANDID mapping):`);
    const sorted = [...unmappedTypes.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`     ${type}: ${count} plans`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
