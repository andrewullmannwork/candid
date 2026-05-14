/**
 * scripts/s91-bsca-postcheck.ts — Phase 1.1 re-run post-upload verification.
 *
 * Read-only. Run AFTER Andrew uploads
 * tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/sbc.pdf
 * (SHA-256 prefix 4692087b).
 *
 * Verifies Bug X (plan_name + plan_year recovery via Haiku fallback) from
 * PR #74. Different from Ambetter scenario: BSCA's parser DOES extract
 * insurer_name natively ("Blue Shield of California") but at S90 returned
 * null on plan_name + plan_year — those are the fields Bug X fallback
 * should recover.
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

const BSCA_HASH_PREFIX = "4692087b";
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
  console.log("Phase 1.1 re-run post-check — BSCA upload Bug X verification (plan_name + plan_year fallback)\n");

  console.log("--- All documents matching BSCA file_hash prefix 4692087b ---");
  const { data: docs, error: docsErr } = await sb
    .from("documents")
    .select("id,user_id,doc_type,status,processing_step,file_hash,file_name,created_at")
    .like("file_hash", `${BSCA_HASH_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (docsErr) {
    console.error("docs query error:", docsErr);
    process.exit(1);
  }
  if (!docs || docs.length === 0) {
    console.log("  ❌ NO documents with this hash.");
    process.exit(2);
  }
  for (const d of docs) {
    console.log(
      `  ${d.id.substring(0, 8)} — created=${d.created_at} | ${d.status} | step=${d.processing_step ?? "<null>"} | doc_type=${d.doc_type ?? "<null>"} | name=${d.file_name?.substring(0, 60)}`,
    );
  }

  const s91Doc = docs[0];
  const userId = s91Doc.user_id as string;
  console.log(`\nS91 re-upload doc: ${s91Doc.id} (user=${userId})\n`);

  console.log("--- Andrew's insurance_plans rows (newest 5) ---");
  const { data: plans, error: plansErr } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_deductible_family,out_oop_max_individual,out_oop_max_family,canonical_plan_id,created_at,updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (plansErr) console.error("plans query error:", plansErr);
  if (plans) {
    for (const p of plans) {
      const flags = [
        p.is_active ? "ACTIVE" : "inactive",
        p.historical_only ? "historical_only" : "",
      ]
        .filter(Boolean)
        .join(" | ");
      console.log(
        `  ${p.id.substring(0, 8)} — ${p.insurer_name ?? "<null>"} | ${p.plan_name ?? "<null>"} | ${p.plan_type ?? "<null>"} ${p.plan_year ?? "<null>"} | [${flags}]`,
      );
      console.log(
        `    in_ded ind/fam: ${p.in_deductible_individual}/${p.in_deductible_family} | in_oop ind/fam: ${p.in_oop_max_individual}/${p.in_oop_max_family}`,
      );
      console.log(
        `    out_ded ind/fam: ${p.out_deductible_individual}/${p.out_deductible_family} | out_oop ind/fam: ${p.out_oop_max_individual}/${p.out_oop_max_family}`,
      );
      console.log(
        `    source_doc=${p.source_document_id?.substring(0, 8) ?? "<null>"} canonical=${p.canonical_plan_id?.substring(0, 8) ?? "<null>"} updated=${p.updated_at}`,
      );
    }
  }

  console.log("\n--- BUG Y GUARD: Andrew's Cigna OAP plan (38a33b4f) vs S71 baseline ---");
  const cigna = plans?.find((p) => p.id.startsWith(CIGNA_PLAN_ID_PREFIX));
  if (!cigna) {
    console.log("  ⚠️  Cigna not in newest 5 — querying directly.");
    const { data: cignaDirect } = await sb
      .from("insurance_plans")
      .select(
        "id,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_deductible_family,out_oop_max_individual,out_oop_max_family",
      )
      .like("id", `${CIGNA_PLAN_ID_PREFIX}%`)
      .maybeSingle();
    if (cignaDirect) verifyCignaBaseline(cignaDirect);
    else console.log("  ❌ Cigna plan not found");
  } else {
    verifyCignaBaseline(cigna as unknown as Record<string, unknown>);
  }

  console.log(`\n--- BUG X SUCCESS CHECK: NEW BSCA row (source_document_id=${s91Doc.id}) ---`);
  const bscaRow = plans?.find((p) => p.source_document_id === s91Doc.id);
  if (!bscaRow) {
    console.log("  ⚠️  No insurance_plans row with this S91 doc as source_document_id.");
    console.log("       Could be: still processing, parse failed, or non-mismatch path took row UPDATE.");
  } else {
    console.log(`  Row ID: ${bscaRow.id.substring(0, 8)}`);
    console.log(`  insurer_name: ${bscaRow.insurer_name ?? "<null>"}`);
    console.log(`  plan_name: ${bscaRow.plan_name ?? "<null>"}`);
    console.log(`  plan_year: ${bscaRow.plan_year ?? "<null>"}`);
    console.log(`  plan_type: ${bscaRow.plan_type ?? "<null>"}`);
    console.log(`  is_active: ${bscaRow.is_active}`);
    console.log("");

    const checks: Array<[string, boolean, string]> = [
      [
        "Bug X (plan_name): Haiku fallback recovered plan_name",
        !!bscaRow.plan_name,
        bscaRow.plan_name ? `✅ plan_name=${bscaRow.plan_name}` : `❌ plan_name still null (Bug X did NOT fire or failed)`,
      ],
      [
        "Bug X (plan_year): Haiku fallback recovered plan_year",
        bscaRow.plan_year !== null && bscaRow.plan_year !== undefined,
        bscaRow.plan_year ? `✅ plan_year=${bscaRow.plan_year}` : `❌ plan_year still null`,
      ],
      [
        "insurer_name native extraction (BSCA usually populates this)",
        !!bscaRow.insurer_name,
        bscaRow.insurer_name ? `✅ insurer_name=${bscaRow.insurer_name}` : `⚠️  insurer_name null (Bug X should have caught this too)`,
      ],
      [
        "Bug Y (mismatch): NEW row is is_active=FALSE",
        bscaRow.is_active === false,
        bscaRow.is_active === false
          ? `✅ is_active=false (mismatch detection fired vs Cigna)`
          : `❌ is_active=true (Cigna may have been overwritten!)`,
      ],
    ];
    for (const [label, , msg] of checks) console.log(`  ${msg.startsWith("✅") ? "✅" : msg.startsWith("⚠️") ? "⚠️ " : "❌"} ${label}: ${msg}`);
  }

  console.log("\nDone.");
}

function verifyCignaBaseline(cigna: Record<string, unknown>) {
  const drift = Object.keys(S71_BASELINE).filter(
    (k) => (S71_BASELINE as Record<string, number>)[k] !== (cigna[k] as number),
  );
  if (drift.length === 0) {
    console.log("  ✅ Cigna at S71 baseline — Bug Y guard HELD (Cigna plan UNCHANGED)");
  } else {
    console.log(`  ❌ DRIFT: ${drift.join(", ")}`);
    console.log(`    expected: ${JSON.stringify(S71_BASELINE)}`);
    const actual: Record<string, unknown> = {};
    for (const k of Object.keys(S71_BASELINE)) actual[k] = cigna[k];
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    HALT — Bug Y did NOT hold.`);
  }
}

main().catch((err) => {
  console.error("post-check failed:", err);
  process.exit(1);
});
