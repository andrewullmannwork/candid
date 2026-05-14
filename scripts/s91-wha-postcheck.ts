/**
 * scripts/s91-wha-postcheck.ts — Phase 1.3 WHA 2026 SBC verification.
 * Read-only.
 *
 * Tests: (a) WHA SBC parses cleanly; (b) Bug Y mismatch creates is_active=false row;
 * (c) plan_year=2026 captured; (d) Cigna UNCHANGED.
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

const WHA_HASH_PREFIX = "d9ce75b1f56f";
const CIGNA_PLAN_ID_PREFIX = "38a33b4f";
const S71_BASELINE = {
  in_deductible_individual: 0,
  in_deductible_family: 0,
  in_oop_max_individual: 3000,
  in_oop_max_family: 6000,
  out_deductible_individual: 2000,
  out_deductible_family: 4000,
  out_oop_max_individual: 6000,
  out_oop_max_family: 12000,
};

async function main() {
  console.log("Phase 1.3 WHA 2026 SBC post-check\n");

  const { data: docs } = await sb
    .from("documents")
    .select("id,user_id,doc_type,status,processing_step,file_hash,file_name,created_at")
    .like("file_hash", `${WHA_HASH_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (!docs || docs.length === 0) {
    console.log("  ❌ No WHA doc found — upload may not have hit PROD.");
    process.exit(2);
  }
  console.log("--- WHA docs ---");
  for (const d of docs) {
    console.log(
      `  ${d.id.substring(0, 8)} — ${d.created_at} | ${d.status} | step=${d.processing_step ?? "<null>"} | type=${d.doc_type ?? "<null>"}`,
    );
  }
  const wha = docs[0];
  const userId = wha.user_id as string;
  console.log(`\nS91 WHA doc: ${wha.id} (user=${userId})\n`);

  const { data: plans } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_deductible_family,out_oop_max_individual,out_oop_max_family,canonical_plan_id,updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(6);
  console.log("--- Andrew's insurance_plans (newest 6) ---");
  if (plans) {
    for (const p of plans) {
      const flags = [p.is_active ? "ACTIVE" : "inactive", p.historical_only ? "historical_only" : ""]
        .filter(Boolean)
        .join(" | ");
      console.log(
        `  ${p.id.substring(0, 8)} — ${p.insurer_name ?? "<null>"} | ${p.plan_name ?? "<null>"} | ${p.plan_type ?? "<null>"} ${p.plan_year ?? "<null>"} | [${flags}]`,
      );
      console.log(
        `    in_ded ind/fam: ${p.in_deductible_individual}/${p.in_deductible_family} | in_oop ind/fam: ${p.in_oop_max_individual}/${p.in_oop_max_family} | source_doc=${p.source_document_id?.substring(0, 8) ?? "<null>"} canonical=${p.canonical_plan_id?.substring(0, 8) ?? "<null>"}`,
      );
    }
  }

  console.log("\n--- BUG Y GUARD: Cigna OAP unchanged? ---");
  const cigna = plans?.find((p) => p.id.startsWith(CIGNA_PLAN_ID_PREFIX));
  if (cigna) {
    const drift = Object.keys(S71_BASELINE).filter(
      (k) => (S71_BASELINE as Record<string, number>)[k] !== (cigna as Record<string, unknown>)[k],
    );
    console.log(drift.length === 0 ? "  ✅ Cigna at S71 baseline" : `  ❌ DRIFT: ${drift.join(", ")}`);
  }

  console.log(`\n--- BUG X+Y SUCCESS CHECK: NEW WHA row ---`);
  const whaRow = plans?.find((p) => p.source_document_id === wha.id);
  if (!whaRow) {
    console.log("  ⚠️  No row with this WHA doc as source_doc_id.");
  } else {
    console.log(`  Row: ${whaRow.id.substring(0, 8)}`);
    console.log(`  insurer_name: ${whaRow.insurer_name ?? "<null>"}`);
    console.log(`  plan_name:    ${whaRow.plan_name ?? "<null>"}`);
    console.log(`  plan_type:    ${whaRow.plan_type ?? "<null>"}`);
    console.log(`  plan_year:    ${whaRow.plan_year ?? "<null>"}`);
    console.log(`  is_active:    ${whaRow.is_active}`);
    console.log("");
    console.log(`  ${whaRow.insurer_name ? "✅" : "❌"} insurer_name populated`);
    console.log(`  ${whaRow.plan_name ? "✅" : "❌"} plan_name populated (Bug X if was null in parser)`);
    console.log(`  ${whaRow.plan_year === 2026 ? "✅" : "❌"} plan_year=2026 (got ${whaRow.plan_year})`);
    console.log(`  ${whaRow.plan_type === "HMO" ? "✅" : "❌"} plan_type=HMO (got ${whaRow.plan_type})`);
    console.log(`  ${whaRow.is_active === false ? "✅" : "❌"} is_active=false (Bug Y mismatch fired)`);
  }

  console.log("\nDone.");
}
main().catch(console.error);
