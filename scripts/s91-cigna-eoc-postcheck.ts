/**
 * scripts/s91-cigna-eoc-postcheck.ts — Phase 1.4 Cigna 2024 EOC investigation.
 * Read-only.
 *
 * Surfaces: (a) doc state + duration; (b) what got parsed (insurer/plan/year);
 * (c) full plan row created; (d) Cigna 2026 still untouched; (e) whether the
 * parse "skipped" or completed fast naturally.
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

const CIGNA_EOC_HASH_PREFIX = "c1c35da73771";
const CIGNA_2026_PLAN_ID_PREFIX = "38a33b4f";

async function main() {
  console.log("Phase 1.4 Cigna 2024 EOC post-check\n");

  const { data: docs } = await sb
    .from("documents")
    .select("id,user_id,doc_type,status,processing_step,file_hash,file_name,created_at,updated_at,processing_total_pages,processing_completed_pages,processing_error,retry_count")
    .like("file_hash", `${CIGNA_EOC_HASH_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (!docs || docs.length === 0) {
    console.log("  ❌ No doc with this hash.");
    process.exit(2);
  }
  console.log("--- Cigna EOC docs ---");
  for (const d of docs) {
    const startedAt = new Date(d.created_at as string);
    const endedAt = new Date(d.updated_at as string);
    const elapsedSec = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    console.log(
      `  ${d.id.substring(0, 8)} — ${d.created_at} → ${d.updated_at} (${elapsedSec}s)`,
    );
    console.log(
      `    status=${d.status} step=${d.processing_step ?? "<null>"} type=${d.doc_type ?? "<null>"} retry=${d.retry_count ?? 0}`,
    );
    console.log(
      `    pages: total=${d.processing_total_pages ?? "<null>"} completed=${d.processing_completed_pages ?? "<null>"}`,
    );
    if (d.processing_error) console.log(`    err: ${d.processing_error.substring(0, 160)}`);
  }
  const doc = docs[0];
  const userId = doc.user_id as string;

  console.log("\n--- Andrew's insurance_plans rows (newest 6) ---");
  const { data: plans } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,canonical_plan_id,updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(6);
  if (plans) {
    for (const p of plans) {
      const flags = [p.is_active ? "ACTIVE" : "inactive", p.historical_only ? "historical_only" : ""].filter(Boolean).join(" | ");
      console.log(
        `  ${p.id.substring(0, 8)} — ${p.insurer_name ?? "<null>"} | ${p.plan_name ?? "<null>"} | ${p.plan_type ?? "<null>"} ${p.plan_year ?? "<null>"} | [${flags}]`,
      );
      console.log(
        `    in_ded ind/fam: ${p.in_deductible_individual}/${p.in_deductible_family} | in_oop ind/fam: ${p.in_oop_max_individual}/${p.in_oop_max_family} | source_doc=${p.source_document_id?.substring(0, 8) ?? "<null>"}`,
      );
    }
  }

  console.log(`\n--- NEW Cigna EOC row (source_document_id=${doc.id}) ---`);
  const eocRow = plans?.find((p) => p.source_document_id === doc.id);
  if (!eocRow) {
    console.log("  ⚠️  No row with this doc as source_doc_id — parse may not have written one.");
  } else {
    console.log(`  Row: ${eocRow.id.substring(0, 8)}`);
    console.log(`  insurer_name:  ${eocRow.insurer_name ?? "<null>"}`);
    console.log(`  plan_name:     ${eocRow.plan_name ?? "<null>"}`);
    console.log(`  plan_type:     ${eocRow.plan_type ?? "<null>"}`);
    console.log(`  plan_year:     ${eocRow.plan_year ?? "<null>"}`);
    console.log(`  is_active:     ${eocRow.is_active}`);
    console.log(`  canonical:     ${eocRow.canonical_plan_id?.substring(0, 8) ?? "<null>"}`);
  }

  console.log("\n--- Cigna 2026 OAP plan unchanged? ---");
  const cigna2026 = plans?.find((p) => p.id.startsWith(CIGNA_2026_PLAN_ID_PREFIX));
  if (cigna2026) {
    const expected = { in_deductible_individual: 0, in_oop_max_individual: 3000, out_deductible_individual: 2000, out_oop_max_individual: 6000 };
    const drift = Object.keys(expected).filter((k) => (expected as Record<string, number>)[k] !== (cigna2026 as Record<string, unknown>)[k]);
    console.log(drift.length === 0 ? "  ✅ Cigna 2026 unchanged" : `  ❌ DRIFT: ${drift.join(", ")}`);
  }

  // Check canonical_haiku_extractions count for this doc — if parser ran fully, should have many rows
  console.log("\n--- canonical_haiku_extractions for this doc ---");
  const { count: cheCount } = await sb
    .from("canonical_haiku_extractions")
    .select("id", { count: "exact", head: true })
    .eq("source_document_id", doc.id);
  console.log(`  count: ${cheCount ?? 0}`);
  if ((cheCount ?? 0) < 20) {
    console.log("  ⚠️  Low count — for a 150-page EOC we'd expect 50+ extractions. Could indicate truncated parse OR smart-skip OR classifier route diverged.");
  }

  // Check canonical_plan_services for the canonical (if assigned)
  if (eocRow?.canonical_plan_id) {
    const { count: cpsCount } = await sb
      .from("canonical_plan_services")
      .select("id", { count: "exact", head: true })
      .eq("canonical_plan_id", eocRow.canonical_plan_id);
    console.log(`\n  canonical_plan_services for canonical_plan_id=${eocRow.canonical_plan_id.substring(0, 8)}: ${cpsCount ?? 0}`);
  }

  console.log("\nDone.");
}
main().catch(console.error);
