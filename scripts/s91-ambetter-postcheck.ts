/**
 * scripts/s91-ambetter-postcheck.ts — Phase 1.2 re-run post-upload verification.
 *
 * Read-only. Run AFTER Andrew uploads ca-iex-bronze-60-hdhp-ambetter-ppo-sbc-2024.pdf
 * (SHA-256 prefix 4407c5d47ccd).
 *
 * Verifies Bug X+Y fix from PR #74 (`34c3fe1`) lands correctly:
 *   1. NEW documents row with file_hash starting 4407c5d47ccd exists
 *      and status progresses queued → processing → processed.
 *   2. NEW insurance_plans row created for this upload with
 *      is_active=FALSE (per Bug Y mismatch-detection: parser-null insurer
 *      + user has active Cigna ⇒ treat as insurer mismatch, create
 *      inactive row).
 *   3. Andrew's Cigna OAP plan (id LIKE '38a33b4f%') UNCHANGED — all
 *      cost-share fields at S71 baseline.
 *   4. Plan-identity recovered: Bug X Haiku fallback should populate
 *      at least insurer_name + plan_name on the NEW Ambetter row (was
 *      previously null pre-PR-#74).
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

const AMBETTER_HASH_PREFIX = "4407c5d47ccd";
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
  console.log("Phase 1.2 re-run post-check — Ambetter upload Bug X+Y verification\n");

  // 1. Find ALL documents with this file_hash prefix (S90 + S91 re-upload)
  console.log("--- All documents matching Ambetter file_hash prefix 4407c5d47ccd ---");
  const { data: docs, error: docsErr } = await sb
    .from("documents")
    .select(
      "id,user_id,doc_type,status,processing_step,file_hash,file_name,created_at",
    )
    .like("file_hash", `${AMBETTER_HASH_PREFIX}%`)
    .order("created_at", { ascending: false });
  if (docsErr) {
    console.error("docs query error:", docsErr);
    process.exit(1);
  }
  if (!docs || docs.length === 0) {
    console.log("  ❌ NO documents with this hash — upload may not have hit PROD yet, or hash differs.");
    process.exit(2);
  }
  for (const d of docs) {
    console.log(
      `  ${d.id.substring(0, 8)} — created=${d.created_at} | ${d.status} | step=${d.processing_step ?? "<null>"} | doc_type=${d.doc_type ?? "<null>"} | name=${d.file_name?.substring(0, 60)}`,
    );
  }

  // Newest doc is the S91 re-upload
  const s91Doc = docs[0];
  const userId = s91Doc.user_id as string;
  console.log(`\nS91 re-upload doc: ${s91Doc.id} (user=${userId})`);

  // 2. Andrew's insurance_plans rows — verify Cigna untouched + NEW Ambetter row is_active=false
  console.log("\n--- Andrew's insurance_plans rows (newest 5) ---");
  const { data: plans, error: plansErr } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_deductible_family,out_oop_max_individual,out_oop_max_family,canonical_plan_id,created_at,updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (plansErr) {
    console.error("plans query error:", plansErr);
  }
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

  // 3. Cigna baseline check
  console.log("\n--- BUG Y GUARD: Andrew's Cigna OAP plan (38a33b4f) vs S71 baseline ---");
  const cigna = plans?.find((p) => p.id.startsWith(CIGNA_PLAN_ID_PREFIX));
  if (!cigna) {
    console.log("  ⚠️  Cigna plan NOT in newest 5 — may have aged out; querying directly.");
    const { data: cignaDirect } = await sb
      .from("insurance_plans")
      .select(
        "id,is_active,historical_only,source_document_id,in_deductible_individual,in_deductible_family,in_oop_max_individual,in_oop_max_family,out_deductible_individual,out_deductible_family,out_oop_max_individual,out_oop_max_family",
      )
      .like("id", `${CIGNA_PLAN_ID_PREFIX}%`)
      .maybeSingle();
    if (cignaDirect) {
      verifyCignaBaseline(cignaDirect);
    } else {
      console.log("  ❌ Cigna plan not found at all by ID prefix");
    }
  } else {
    verifyCignaBaseline(cigna as unknown as Record<string, unknown>);
  }

  // 4. NEW Ambetter row check — should be is_active=false per Bug Y
  console.log("\n--- BUG X+Y SUCCESS CHECK: NEW Ambetter row (source_document_id=${s91Doc.id}) ---");
  const ambetterRow = plans?.find((p) => p.source_document_id === s91Doc.id);
  if (!ambetterRow) {
    console.log("  ⚠️  No insurance_plans row with this S91 doc as source_document_id.");
    console.log("       Possible reasons:");
    console.log("       - Doc still processing (run script again)");
    console.log("       - Parse failed (check documents.status above)");
    console.log("       - Plan-identity null AND user has no active plan → no insurer-mismatch → row UPDATED in place (CHECK if Cigna touched!)");
  } else {
    console.log(`  Row ID: ${ambetterRow.id.substring(0, 8)}`);
    console.log(`  insurer_name: ${ambetterRow.insurer_name ?? "<null>"}`);
    console.log(`  plan_name: ${ambetterRow.plan_name ?? "<null>"}`);
    console.log(`  is_active: ${ambetterRow.is_active}`);
    console.log("");

    // Success criteria check
    const checks: Array<[string, boolean, string]> = [
      [
        "Bug X (insurer): Haiku fallback recovered insurer_name",
        !!ambetterRow.insurer_name,
        ambetterRow.insurer_name ? `✅ insurer_name=${ambetterRow.insurer_name}` : `❌ insurer_name still null`,
      ],
      [
        "Bug Y (mismatch): NEW row is is_active=FALSE",
        ambetterRow.is_active === false,
        ambetterRow.is_active === false
          ? `✅ is_active=false (mismatch detection fired)`
          : `❌ is_active=true (Cigna may have been overwritten!)`,
      ],
    ];
    for (const [label, pass, msg] of checks) {
      console.log(`  ${pass ? "✅" : "❌"} ${label}: ${msg}`);
    }
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
    console.log(`    HALT — Bug Y did NOT hold; do NOT proceed to Phase 1.1 re-run.`);
  }
}

main().catch((err) => {
  console.error("post-check failed:", err);
  process.exit(1);
});
