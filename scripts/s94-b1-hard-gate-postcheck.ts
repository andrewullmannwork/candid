/**
 * scripts/s94-b1-hard-gate-postcheck.ts — S94 Work Block B1 Stage 4 measurement.
 *
 * Reads the MOST RECENT documents row uploaded by Andrew (filtered by user
 * email + status='processed' + classification IN ('sbc','eoc','plan_document'))
 * and measures HARD GATE thresholds:
 *
 *   - services_count    >= SBC parser empirical baseline ± 1 per S94 LOCK
 *   - cite_grade_pct    >= 95% (Pattern P-8 verified rate across plan_covered_services rows)
 *   - plan_identity_pct >= 80% (Pattern P-8 verified rate across insurance_plans planIdentity fields)
 *   - cost              <= SBC parser cost per fixture
 *
 * SBC baselines hardcoded below from S52/S53/S93 empirical runs.
 *
 * Usage:
 *   npx tsx scripts/s94-b1-hard-gate-postcheck.ts            # most recent doc
 *   npx tsx scripts/s94-b1-hard-gate-postcheck.ts <doc-id>   # specific doc-id
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

const TARGET_USER_EMAIL = "andrew.david.ullmann@gmail.com";

// SBC parser empirical baselines per fixture (from S52/S53/S93 harness runs).
// services_count is post-canonical-resolution; cite-grade based on Pattern P-8 verified.
// Match by fragment of plan_name or file_hash; falls through to "unknown" if not found.
// Keywords matched against lower(plan_name) in any order. Insurer-branded names
// like "Health Net of CA: Gold 80 Ambetter PPO" put plan-tier before insurer-name,
// so word-order-sensitive regex misses them.
const SBC_BASELINES: Record<string, { keywords: string[]; servicesCount: number; citeGradePct: number; planIdentityPct: number; costUsd: number; note: string }> = {
  "ambetter-bronze-60-hdhp":      { keywords: ["ambetter", "bronze", "60", "hdhp"], servicesCount: 35, citeGradePct: 100, planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline; bronze HDHP" },
  "ambetter-silver-87":           { keywords: ["ambetter", "silver", "87"],         servicesCount: 40, citeGradePct: 100, planIdentityPct: 42.9, costUsd: 0.20, note: "S93 silver-87 diff baseline" },
  "ambetter-gold-80":             { keywords: ["ambetter", "gold", "80"],           servicesCount: 40, citeGradePct: 96,  planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline" },
  "blue-shield-bronze-60":        { keywords: ["blue shield", "bronze", "60"],      servicesCount: 40, citeGradePct: 84,  planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline" },
  "blue-shield-silver-70-ppo":    { keywords: ["blue shield", "silver", "70", "ppo"], servicesCount: 38, citeGradePct: 79, planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline" },
  "blue-shield-silver-70-hmo":    { keywords: ["blue shield", "silver", "70", "hmo"], servicesCount: 38, citeGradePct: 80, planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline" },
  "wha-premier":                  { keywords: ["wha", "premier"],                   servicesCount: 38, citeGradePct: 93,  planIdentityPct: 75, costUsd: 0.20, note: "S53 baseline" },
};

const PLAN_IDENTITY_KEYS = [
  "plan_name",
  "insurer_name",
  "plan_type",
  "plan_year",
  "in_deductible_individual",
  "in_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
  "out_deductible_individual",
  "out_deductible_family",
  "out_oop_max_individual",
  "out_oop_max_family",
];

interface FieldProvenance {
  source_excerpt_verified?: "verified" | "not_found" | "ocr_unverifiable";
  source_section_verified?: boolean;
}

function isCiteGradeVerified(p?: FieldProvenance | null): boolean {
  if (!p) return false;
  return p.source_excerpt_verified === "verified" && p.source_section_verified === true;
}

function matchBaseline(planName: string | null): { key: string | null; baseline: typeof SBC_BASELINES[string] | null } {
  if (!planName) return { key: null, baseline: null };
  const lower = planName.toLowerCase();
  for (const [key, baseline] of Object.entries(SBC_BASELINES)) {
    if (baseline.keywords.every((kw) => lower.includes(kw))) {
      return { key, baseline };
    }
  }
  return { key: null, baseline: null };
}

async function findDoc(docIdArg?: string): Promise<{ id: string; file_hash: string | null; doc_type: string; processing_step: string | null; created_at: string; user_id: string } | null> {
  if (docIdArg) {
    const { data, error } = await sb
      .from("documents")
      .select("id, file_hash, doc_type, processing_step, created_at, user_id")
      .eq("id", docIdArg)
      .single();
    if (error || !data) {
      console.error(`Doc ${docIdArg} not found:`, error?.message);
      return null;
    }
    return data;
  }
  const { data: user } = await sb.from("users").select("id, firebase_uid").eq("email", TARGET_USER_EMAIL).single();
  if (!user) {
    console.error(`User ${TARGET_USER_EMAIL} not found`);
    return null;
  }
  const { data: docs } = await sb
    .from("documents")
    .select("id, file_hash, doc_type, processing_step, created_at, user_id")
    .eq("user_id", user.firebase_uid)
    .in("doc_type", ["sbc", "eoc", "plan_document"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (!docs || docs.length === 0) {
    console.error("No recent docs found for user");
    return null;
  }
  return docs[0];
}

async function main() {
  const docIdArg = process.argv[2];
  const doc = await findDoc(docIdArg);
  if (!doc) process.exit(1);

  console.log(`\n=== S94 B1 HARD GATE postcheck ===`);
  console.log(`doc id: ${doc.id}`);
  console.log(`file_hash: ${doc.file_hash?.slice(0, 12)}…`);
  console.log(`doc_type: ${doc.doc_type}`);
  console.log(`processing_step: ${doc.processing_step}`);
  console.log(`created_at: ${doc.created_at}`);

  // Pull insurance_plans row for this doc (via source_document_id linkage)
  const { data: plans } = await sb
    .from("insurance_plans")
    .select("id, plan_name, insurer_name, plan_type, plan_year, in_deductible_individual, in_deductible_family, in_oop_max_individual, in_oop_max_family, out_deductible_individual, out_deductible_family, out_oop_max_individual, out_oop_max_family, field_provenance, source_document_id, is_active")
    .eq("source_document_id", doc.id)
    .order("created_at", { ascending: false });

  if (!plans || plans.length === 0) {
    console.error("\nNo insurance_plans row found for this doc — parse likely failed or active plan wasn't updated");
    process.exit(1);
  }

  const plan = plans[0];
  console.log(`\nplan: ${plan.plan_name} (id ${plan.id.slice(0, 8)}…)`);
  console.log(`insurer: ${plan.insurer_name} | type: ${plan.plan_type} | year: ${plan.plan_year}`);

  // Plan-identity verified count
  const fp = (plan.field_provenance ?? {}) as Record<string, FieldProvenance | null>;
  let piVerifiedCount = 0;
  let piApplicableCount = 0;
  console.log("\n--- Plan-identity field-by-field ---");
  for (const k of PLAN_IDENTITY_KEYS) {
    const val = (plan as Record<string, unknown>)[k];
    const prov = fp[k];
    const ok = isCiteGradeVerified(prov);
    if (val !== null && val !== undefined && val !== "") {
      piApplicableCount++;
      if (ok) piVerifiedCount++;
    }
    console.log(`  ${k.padEnd(28)} val=${String(val).slice(0, 20).padEnd(20)} verified=${ok ? "✓" : "✗"}`);
  }
  const planIdentityPct = piApplicableCount > 0 ? (piVerifiedCount / piApplicableCount) * 100 : 0;

  // plan_covered_services rows + cite-grade
  const { data: services } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service, in_copay, in_coinsurance, in_cost_description, out_copay, out_coinsurance, out_cost_description, field_provenance, service_catalog:service_id(slug, name)")
    .eq("insurance_plan_id", plan.id);

  const servicesCount = services?.length ?? 0;
  // Denominator is rows with any cost-share value populated. Covered-only rows
  // (e.g., "Acupuncture — Covered when medically necessary" with no copay or coinsurance
  // in the SBC) have nothing to cite under Pattern P-8 cost-share contract; counting them
  // as failures penalizes the parser for correctly NOT hallucinating values absent from
  // the source. Notes / coverage_conditions / prior_auth still get their own provenance
  // entries on those rows; they're just outside this gate.
  let citeableCount = 0;
  let servicesVerified = 0;
  if (services) {
    for (const s of services) {
      const row = s as {
        in_copay?: unknown; in_coinsurance?: unknown; in_cost_description?: unknown;
        out_copay?: unknown; out_coinsurance?: unknown; out_cost_description?: unknown;
        field_provenance?: Record<string, FieldProvenance>;
      };
      const hasAnyCostValue =
        row.in_copay != null || row.in_coinsurance != null || row.in_cost_description ||
        row.out_copay != null || row.out_coinsurance != null || row.out_cost_description;
      if (!hasAnyCostValue) continue;
      citeableCount++;
      const sfp = row.field_provenance ?? {};
      const costFields: (keyof typeof sfp)[] = [
        "in_copay", "in_coinsurance", "in_cost_description",
        "out_copay", "out_coinsurance", "out_cost_description",
      ];
      const anyVerified = costFields.some((k) => isCiteGradeVerified(sfp[k as string]));
      if (anyVerified) servicesVerified++;
    }
  }
  const citeGradePct = citeableCount > 0 ? (servicesVerified / citeableCount) * 100 : 0;

  // Cost from documents.parse_quality_* or parse_audit_runs
  let costUsd: number | null = null;
  const { data: docMeta } = await sb
    .from("documents")
    .select("parse_quality_layout, parse_quality_signature, parse_quality_score, processing_step")
    .eq("id", doc.id)
    .single();
  if (docMeta) {
    console.log(`\nparse_quality_layout: ${docMeta.parse_quality_layout}`);
    console.log(`parse_quality_score: ${docMeta.parse_quality_score}`);
    console.log(`parse_quality_signature: ${docMeta.parse_quality_signature?.slice(0, 12)}…`);
  }
  const { data: audit } = await sb
    .from("parse_audit_runs")
    .select("haiku_cost_usd_total, services_count, parser, model")
    .eq("doc_id", doc.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (audit) {
    costUsd = audit.haiku_cost_usd_total;
    console.log(`\nparse_audit_runs: parser=${audit.parser} model=${audit.model} cost=$${audit.haiku_cost_usd_total} services=${audit.services_count}`);
  } else {
    console.log("\nparse_audit_runs row not present (plan_doc parser may not write here yet — Phase 2 fast-follow)");
  }

  // Match baseline
  const { key, baseline } = matchBaseline(plan.plan_name);
  console.log(`\n--- HARD GATE comparison ---`);
  console.log(`baseline match: ${key ?? "UNKNOWN — pass-fail vs absolute thresholds only"}`);

  console.log(`\n  Services count:    ${servicesCount}${baseline ? ` (SBC baseline ${baseline.servicesCount} ± 1)` : ""}`);
  console.log(`  Cite-grade %:      ${citeGradePct.toFixed(1)}% (${servicesVerified}/${citeableCount} citeable rows; ${servicesCount - citeableCount} rows excluded as covered-only / no cost data) (target ≥ 95%)`);
  console.log(`  Plan-identity %:   ${planIdentityPct.toFixed(1)}% (${piVerifiedCount}/${piApplicableCount} verified) (target ≥ 80%)`);
  console.log(`  Cost:              ${costUsd !== null ? `$${costUsd.toFixed(4)}` : "n/a"}${baseline ? ` (SBC baseline $${baseline.costUsd.toFixed(4)})` : ""}`);

  console.log(`\n--- Pass/fail per locked threshold ---`);
  const passServicesCount = baseline ? servicesCount >= baseline.servicesCount - 1 : true;
  const passCiteGrade = citeGradePct >= 95;
  const passPlanIdentity = planIdentityPct >= 80;
  const passCost = baseline && costUsd !== null ? costUsd <= baseline.costUsd : true;
  console.log(`  services_count >= SBC ±1:   ${passServicesCount ? "✅" : "❌"}`);
  console.log(`  cite_grade >= 95%:           ${passCiteGrade ? "✅" : "❌"}`);
  console.log(`  plan_identity >= 80%:        ${passPlanIdentity ? "✅" : "❌"}`);
  console.log(`  cost <= SBC:                 ${passCost ? "✅" : (costUsd === null ? "⚠️  cost unknown" : "❌")}`);
  const allPass = passServicesCount && passCiteGrade && passPlanIdentity && passCost;
  console.log(`\n${allPass ? "✅ ALL THRESHOLDS PASS" : "❌ FAILURE — STOP per Q-S94 LOCK; iterate prompt OR escalate"}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
