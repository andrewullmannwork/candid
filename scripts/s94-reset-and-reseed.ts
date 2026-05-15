/**
 * scripts/s94-reset-and-reseed.ts — S94 Work Block B1 Stage 1
 *
 * DESTRUCTIVE — wipes service_catalog + canonical_plan_services + plan_covered_services
 * + claim_line_items + claims + dispute_outcomes + service_catalog_admin_review_queue
 * + concepts WHERE concept_class='service' AND vocabulary_id='CANDID'.
 *
 * Re-seeds 68 canonical concepts + 68 service_catalog rows per S94 LOCK
 * (see plans/s94_unified_parser_meet_or_beat.md "Locked Canonical Winners" table).
 *
 * Per Andrew's S94 LOCK 2026-05-15: pre-launch state authorizes delete-and-rebuild;
 * Pattern 1 #10 hard-delete prohibition overridden for this specific cleanup pass.
 *
 * Preserves: canonical_plans, insurance_plans, users, documents, parse_audit_runs,
 * canonical_promotion_events, billing-code concepts (CPT/HCPCS/NDC/REV/DRG vocabularies),
 * category-class concepts (cat_office_visit etc.), service_group-class concepts (grp_*).
 *
 * Usage:
 *   npx tsx scripts/s94-reset-and-reseed.ts            # DRY RUN (default)
 *   npx tsx scripts/s94-reset-and-reseed.ts --apply    # EXECUTE (destructive)
 */
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const APPLY = process.argv.includes("--apply");

/**
 * 68 canonical service definitions per S94 LOCK 2026-05-15.
 * Source of truth: plans/s94_unified_parser_meet_or_beat.md "Locked Canonical Winners".
 *
 * concept_class = 'service' for all rows; vocabulary_id = 'CANDID'.
 * service_catalog.category constrained by mig 009 CHECK — long_term_care slugs
 * bucket under 'other' (matches existing convention from mig 010 seed).
 */
type CanonicalSlug = {
  slug: string;
  name: string;
  category:
    | "office_visit"
    | "emergency"
    | "hospital"
    | "imaging"
    | "lab"
    | "rx"
    | "therapy"
    | "mental_health"
    | "maternity"
    | "dme"
    | "preventive"
    | "other";
  isPreventiveEligible: boolean;
};

const CANONICAL_SLUGS: CanonicalSlug[] = [
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

if (CANONICAL_SLUGS.length !== 68) {
  console.error(`FATAL: CANONICAL_SLUGS has ${CANONICAL_SLUGS.length} entries; expected 68`);
  process.exit(1);
}

const UNIQ_CATEGORIES = new Set(CANONICAL_SLUGS.map((c) => c.category));
const UNIQ_SLUGS = new Set(CANONICAL_SLUGS.map((c) => c.slug));
if (UNIQ_SLUGS.size !== 68) {
  console.error(`FATAL: duplicate slugs in CANONICAL_SLUGS (size=${UNIQ_SLUGS.size})`);
  process.exit(1);
}

console.log(`\nS94 Reset & Reseed — ${APPLY ? "APPLY (DESTRUCTIVE)" : "DRY RUN"}`);
console.log(`Supabase URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`Canonical slugs: 68 (categories: ${[...UNIQ_CATEGORIES].sort().join(", ")})`);

async function countAll() {
  const tables = [
    "service_catalog",
    "canonical_plan_services",
    "plan_covered_services",
    "claim_line_items",
    "claims",
    "dispute_outcomes",
    "service_catalog_admin_review_queue",
  ];
  console.log("\n=== Pre-reset row counts ===");
  for (const t of tables) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) {
      console.log(`  ${t}: ERROR ${error.message}`);
    } else {
      console.log(`  ${t}: ${count}`);
    }
  }
  // concepts WHERE concept_class='service' AND vocabulary_id='CANDID'
  const { count: serviceConceptsCount, error: scErr } = await sb
    .from("concepts")
    .select("*", { count: "exact", head: true })
    .eq("concept_class", "service")
    .eq("vocabulary_id", "CANDID");
  if (scErr) console.log(`  concepts(service+CANDID): ERROR ${scErr.message}`);
  else console.log(`  concepts(service+CANDID): ${serviceConceptsCount}`);

  // Preserved counts for context
  const { count: catalogPlansCount } = await sb
    .from("canonical_plans")
    .select("*", { count: "exact", head: true });
  console.log(`  canonical_plans (PRESERVED): ${catalogPlansCount}`);
  const { count: docsCount } = await sb
    .from("documents")
    .select("*", { count: "exact", head: true });
  console.log(`  documents (PRESERVED): ${docsCount}`);
}

async function dryRunWipePreview() {
  console.log("\n=== Dry-run: what would be wiped ===");
  // Sample a few rows from each table that would be deleted, to confirm types & FK chain.
  const samples: Record<string, number> = {};
  for (const t of [
    "service_catalog",
    "canonical_plan_services",
    "plan_covered_services",
    "claim_line_items",
    "claims",
    "dispute_outcomes",
    "service_catalog_admin_review_queue",
  ]) {
    const { count } = await sb.from(t).select("*", { count: "exact", head: true });
    samples[t] = count ?? 0;
  }
  console.log("  Tables to wipe (delete all rows):", JSON.stringify(samples, null, 2));

  console.log("\n  After wipe + seed, service_catalog will have 68 rows (all canonical_for_concept=TRUE, proposal_state='canonical').");
  console.log("  After wipe + seed, concepts will have +68 service-class CANDID rows (existing categories + groups preserved).");
}

async function applyReset() {
  console.log("\n=== APPLY: executing reset ===");

  // DELETE order respects FK chain (children before parents).
  // claim_line_items + dispute_outcomes both reference claims.
  // canonical_plan_services + plan_covered_services + service_catalog_admin_review_queue reference service_catalog.
  // service_catalog references concepts via concept_id.
  const deleteOrder = [
    "claim_line_items",
    "dispute_outcomes",
    "claims",
    "canonical_plan_services",
    "plan_covered_services",
    "service_catalog_admin_review_queue",
    "service_catalog",
  ];

  for (const t of deleteOrder) {
    // .delete() requires a filter. Use "id is not null" via .not('id', 'is', null) — matches all rows.
    const { error, count } = await sb.from(t).delete({ count: "exact" }).not("id", "is", null);
    if (error) {
      console.log(`  ❌ DELETE ${t}: ${error.message}`);
      throw new Error(`DELETE failed on ${t}`);
    }
    console.log(`  ✅ DELETE ${t}: ${count} rows`);
  }

  // DELETE concepts WHERE concept_class='service' AND vocabulary_id='CANDID' (preserves categories, groups, CPT/HCPCS, etc.)
  const { error: cErr, count: cCount } = await sb
    .from("concepts")
    .delete({ count: "exact" })
    .eq("concept_class", "service")
    .eq("vocabulary_id", "CANDID");
  if (cErr) {
    console.log(`  ❌ DELETE concepts (service+CANDID): ${cErr.message}`);
    throw new Error("DELETE failed on concepts");
  }
  console.log(`  ✅ DELETE concepts (service+CANDID): ${cCount} rows`);

  // INSERT 68 service-class CANDID concepts. Returns inserted rows with their UUIDs.
  console.log("\n  Inserting 68 service concepts...");
  const conceptInserts = CANONICAL_SLUGS.map((c) => ({
    vocabulary_id: "CANDID",
    concept_code: c.slug,
    concept_name: c.name,
    concept_class: "service",
    domain: "service",
  }));
  const { data: insertedConcepts, error: ciErr } = await sb
    .from("concepts")
    .insert(conceptInserts)
    .select("id, concept_code");
  if (ciErr) {
    console.log(`  ❌ INSERT concepts: ${ciErr.message}`);
    throw new Error("INSERT concepts failed");
  }
  if (!insertedConcepts || insertedConcepts.length !== 68) {
    console.log(`  ❌ Expected 68 inserted concepts, got ${insertedConcepts?.length ?? 0}`);
    throw new Error("INSERT concepts count mismatch");
  }
  console.log(`  ✅ INSERT concepts: 68 rows`);

  // Build slug → concept_id map for service_catalog inserts
  const slugToConceptId = new Map<string, string>();
  for (const row of insertedConcepts) {
    slugToConceptId.set((row as { concept_code: string }).concept_code, (row as { id: string }).id);
  }

  // INSERT 68 service_catalog rows linking concept_id with proposal_state='canonical' + canonical_for_concept=TRUE
  console.log("\n  Inserting 68 service_catalog rows...");
  const catalogInserts = CANONICAL_SLUGS.map((c) => ({
    slug: c.slug,
    name: c.name,
    category: c.category,
    is_preventive_eligible: c.isPreventiveEligible,
    concept_id: slugToConceptId.get(c.slug)!,
    canonical_for_concept: true,
    proposal_state: "canonical",
    deprecated_at: null,
  }));
  const { error: scErr, count: scCount } = await sb
    .from("service_catalog")
    .insert(catalogInserts, { count: "exact" });
  if (scErr) {
    console.log(`  ❌ INSERT service_catalog: ${scErr.message}`);
    throw new Error("INSERT service_catalog failed");
  }
  console.log(`  ✅ INSERT service_catalog: ${scCount} rows`);
}

async function postCheck() {
  console.log("\n=== Post-reset verification ===");
  const { count: catalogCount } = await sb
    .from("service_catalog")
    .select("*", { count: "exact", head: true });
  console.log(`  service_catalog rows: ${catalogCount} (expected 68)`);

  const { count: canonicalCount } = await sb
    .from("service_catalog")
    .select("*", { count: "exact", head: true })
    .eq("canonical_for_concept", true)
    .eq("proposal_state", "canonical");
  console.log(`  service_catalog canonical_for_concept=true AND proposal_state='canonical': ${canonicalCount} (expected 68)`);

  const { count: serviceConceptsCount } = await sb
    .from("concepts")
    .select("*", { count: "exact", head: true })
    .eq("concept_class", "service")
    .eq("vocabulary_id", "CANDID");
  console.log(`  concepts (service-class CANDID): ${serviceConceptsCount} (expected 68)`);

  // Spot-check: a few specific slugs
  for (const probe of ["pcp_visit", "advanced_imaging", "delivery_facility", "vision_exam"]) {
    const { data, error } = await sb
      .from("service_catalog")
      .select("slug, name, category, canonical_for_concept, proposal_state, concept_id")
      .eq("slug", probe)
      .maybeSingle();
    if (error || !data) {
      console.log(`  ❌ ${probe}: NOT FOUND`);
    } else {
      console.log(`  ✅ ${probe}: ${JSON.stringify(data, null, 0)}`);
    }
  }
}

async function main() {
  await countAll();
  if (!APPLY) {
    await dryRunWipePreview();
    console.log("\n=== Dry run complete. Re-run with --apply to execute. ===\n");
    process.exit(0);
  }
  await applyReset();
  await postCheck();
  console.log("\n=== Reset complete. Next: Stage 2 STANDARD_SLUGS rewrite. ===\n");
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
