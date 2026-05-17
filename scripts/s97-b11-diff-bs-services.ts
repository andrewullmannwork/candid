/**
 * B11 investigation — diff BS Bronze 60 PPO services extracted by Document AI
 * path (doc c34d7159 / plan b186a029, 51 services @ 89.2% cite-grade) vs
 * pdfjs path (doc cf803ac2 / plan f0416b83, 38 services @ 100% cite-grade).
 *
 * Output:
 *   - Services in BOTH (overlap)
 *   - Services ONLY in DocAI (potential pdfjs misses OR DocAI hallucinations)
 *   - Services ONLY in pdfjs (potential DocAI misses, unlikely given service count)
 *
 * For each "only in DocAI" service, also report the cite-grade status — if
 * not cite-grade, it's likely a DocAI hallucination/false positive. If cite-
 * grade, it's a real service pdfjs missed.
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const DOC_AI_PLAN_ID = "b186a029-2c54-4eec-8b1a-b4999768ab7b";
const PDFJS_PLAN_ID = "f0416b83-abc1-4c30-8f60-8197d4f013f9";

interface ServiceRow {
  slug: string;
  in_copay: string | null;
  in_coinsurance: string | null;
  in_cost_description: string | null;
  out_copay: string | null;
  out_coinsurance: string | null;
  out_cost_description: string | null;
  sbc_excerpt: string | null;
  field_provenance: { [k: string]: { source_excerpt_verified?: string } } | null;
}

async function loadServices(planId: string, label: string): Promise<Map<string, ServiceRow>> {
  // Join through service_catalog to get the slug from service_id.
  const { data, error } = await sb
    .from("plan_covered_services")
    .select(`service_id, in_copay, in_coinsurance, in_cost_description, out_copay, out_coinsurance, out_cost_description, sbc_excerpt, field_provenance,
             service_catalog:service_id(slug)`)
    .eq("insurance_plan_id", planId);
  if (error) {
    console.error(`Error loading ${label}:`, error);
    return new Map();
  }
  const map = new Map<string, ServiceRow>();
  for (const r of data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = r as any;
    const slug = (Array.isArray(raw.service_catalog) ? raw.service_catalog[0]?.slug : raw.service_catalog?.slug) ?? "unknown";
    map.set(slug, { ...(raw as Omit<ServiceRow, "slug">), slug });
  }
  console.log(`${label}: ${map.size} services`);
  return map;
}

function citeGradeStatus(row: ServiceRow): string {
  const fp = row.field_provenance ?? {};
  // Pattern P-8 cite-grade: verify on cost-share fields.
  const keys = ["in_copay", "in_coinsurance", "in_cost_description", "out_copay", "out_coinsurance", "out_cost_description"];
  for (const k of keys) {
    if (fp[k]?.source_excerpt_verified === "verified") return "✓ cite-grade";
  }
  return "— no-cite-grade";
}

async function main() {
  const docAi = await loadServices(DOC_AI_PLAN_ID, "DocAI v1");
  const pdfjs = await loadServices(PDFJS_PLAN_ID, "pdfjs v2");

  const allSlugs = new Set([...docAi.keys(), ...pdfjs.keys()]);
  const both: string[] = [];
  const onlyDocAi: string[] = [];
  const onlyPdfjs: string[] = [];

  for (const slug of allSlugs) {
    const a = docAi.has(slug);
    const b = pdfjs.has(slug);
    if (a && b) both.push(slug);
    else if (a) onlyDocAi.push(slug);
    else if (b) onlyPdfjs.push(slug);
  }

  both.sort();
  onlyDocAi.sort();
  onlyPdfjs.sort();

  console.log(`\n── OVERLAP (${both.length}) ──`);
  for (const s of both) console.log(`  ${s}`);

  console.log(`\n── ONLY IN DOC-AI v1 (${onlyDocAi.length}) ──`);
  console.log("  These are services DocAI extracted but pdfjs did not.");
  console.log("  Check cite-grade: verified = real miss; unverified = likely DocAI false positive\n");
  for (const s of onlyDocAi) {
    const row = docAi.get(s)!;
    const cg = citeGradeStatus(row);
    const inSummary = formatCost(row.in_copay, row.in_coinsurance, row.in_cost_description);
    const outSummary = formatCost(row.out_copay, row.out_coinsurance, row.out_cost_description);
    console.log(`  [${cg}] ${s}`);
    console.log(`         in:  ${inSummary}`);
    console.log(`         out: ${outSummary}`);
  }

  console.log(`\n── ONLY IN PDFJS v2 (${onlyPdfjs.length}) ──`);
  for (const s of onlyPdfjs) {
    const row = pdfjs.get(s)!;
    const cg = citeGradeStatus(row);
    const inSummary = formatCost(row.in_copay, row.in_coinsurance, row.in_cost_description);
    const outSummary = formatCost(row.out_copay, row.out_coinsurance, row.out_cost_description);
    console.log(`  [${cg}] ${s}`);
    console.log(`         in:  ${inSummary}`);
    console.log(`         out: ${outSummary}`);
  }

  console.log(`\n── SUMMARY ──`);
  console.log(`  Overlap: ${both.length}`);
  console.log(`  Only DocAI: ${onlyDocAi.length} (the gap to investigate)`);
  const realMissCount = onlyDocAi.filter((s) => citeGradeStatus(docAi.get(s)!).startsWith("✓")).length;
  console.log(`  Real misses (cite-grade ✓): ${realMissCount}`);
  console.log(`  Likely DocAI false positives (not cite-grade): ${onlyDocAi.length - realMissCount}`);
  console.log(`  Only pdfjs: ${onlyPdfjs.length}`);
}

function formatCost(copay: string | null, coins: string | null, desc: string | null): string {
  const parts = [];
  if (copay) parts.push(`copay=${copay}`);
  if (coins) parts.push(`coins=${coins}`);
  if (desc) parts.push(`desc=${desc.slice(0, 35)}`);
  return parts.join(" / ") || "(empty)";
}

main().catch((err) => {
  console.error("Diff failed:", err);
  process.exit(1);
});
