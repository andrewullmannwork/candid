/**
 * scripts/s91-pre-ambetter-snapshot.ts — S91 pre-upload baseline.
 *
 * Read-only. Confirms Andrew primary's Cigna OAP plan is at the S71 baseline
 * BEFORE the Ambetter re-upload kicks off Phase 1.2 re-run. Also captures
 * the existing Ambetter doc state (status='error' from S90 recovery) so we
 * can prove the dedup whitelist excludes it.
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ANDREW_EMAIL = "andrew.david.ullmann@gmail.com";
const CIGNA_PLAN_ID = "38a33b4f-89d6-4b6d-b89e-c25b87ef3eaf"; // from S90 recovery log
const AMBETTER_DOC_ID = "76d22f2f"; // prefix

async function main() {
  console.log("S91 pre-Ambetter snapshot — baseline before Bug X+Y fix verification\n");

  // Resolve Andrew's user_id via users table (project's own table; auth.users may
  // need full pagination at scale, and users mirrors it for app queries).
  const { data: userRow } = await sb
    .from("users")
    .select("id,email,is_admin,phone_verified,email_verified")
    .eq("email", ANDREW_EMAIL)
    .maybeSingle();
  if (!userRow) {
    console.error(`❌ Could not find user with email ${ANDREW_EMAIL} in users table`);
    process.exit(1);
  }
  const andrew = { id: userRow.id as string };
  console.log(
    `Andrew primary user_id: ${andrew.id}  admin=${userRow.is_admin}  phone_verified=${userRow.phone_verified}  email_verified=${userRow.email_verified}\n`,
  );

  // 1. Andrew's active insurance_plans rows
  console.log("--- Andrew's insurance_plans rows ---");
  const { data: plans } = await sb
    .from("insurance_plans")
    .select(
      "id,insurer_name,plan_name,plan_type,plan_year,is_active,historical_only,source_document_id,in_network_deductible_individual,in_network_deductible_family,in_network_oop_max_individual,in_network_oop_max_family,out_network_deductible_individual,out_network_deductible_family,out_network_oop_max_individual,out_network_oop_max_family,canonical_plan_id,created_at,updated_at",
    )
    .eq("user_id", andrew.id)
    .order("created_at", { ascending: false });

  if (plans) {
    for (const p of plans) {
      const flags = [
        p.is_active ? "ACTIVE" : "inactive",
        p.historical_only ? "historical_only" : "",
      ]
        .filter(Boolean)
        .join(" | ");
      console.log(
        `  ${p.id.substring(0, 8)} — ${p.insurer_name ?? "<null>"}  ${p.plan_name ?? "<null>"}  ${p.plan_type ?? "<null>"} ${p.plan_year ?? "<null>"}  [${flags}]`,
      );
      console.log(
        `    in_ded ind/fam: ${p.in_network_deductible_individual}/${p.in_network_deductible_family} | in_oop ind/fam: ${p.in_network_oop_max_individual}/${p.in_network_oop_max_family}`,
      );
      console.log(
        `    out_ded ind/fam: ${p.out_network_deductible_individual}/${p.out_network_deductible_family} | out_oop ind/fam: ${p.out_network_oop_max_individual}/${p.out_network_oop_max_family}`,
      );
      console.log(
        `    source_doc=${p.source_document_id?.substring(0, 8) ?? "<null>"} canonical=${p.canonical_plan_id?.substring(0, 8) ?? "<null>"} updated=${p.updated_at}`,
      );
    }
  }

  // 2. Andrew's recent documents
  console.log("\n--- Andrew's recent documents (last 10) ---");
  const { data: docs } = await sb
    .from("documents")
    .select(
      "id,doc_type,classification_type,status,processing_step,file_hash,file_name,created_at,error_message",
    )
    .eq("user_id", andrew.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (docs) {
    for (const d of docs) {
      console.log(
        `  ${d.id.substring(0, 8)} — ${d.doc_type ?? d.classification_type ?? "<null>"} | ${d.status} | ${d.processing_step ?? "<null>"} | hash=${d.file_hash?.substring(0, 12) ?? "<null>"} | name=${d.file_name?.substring(0, 60) ?? "<null>"}`,
      );
      if (d.error_message) {
        console.log(`    err: ${d.error_message.substring(0, 120)}`);
      }
    }
  }

  // 3. Verify Cigna plan state matches S71 baseline
  console.log("\n--- Cigna OAP plan vs S71 baseline ---");
  const cigna = plans?.find((p) => p.id.startsWith(CIGNA_PLAN_ID.substring(0, 8)));
  if (!cigna) {
    console.log("  ⚠️  Could not find Cigna plan by ID prefix");
  } else {
    const expected = {
      in_ded_ind: 0,
      in_ded_fam: 0,
      in_oop_ind: 3000,
      in_oop_fam: 6000,
      out_ded_ind: 2000,
      out_ded_fam: 4000,
      out_oop_ind: 6000,
      out_oop_fam: 12000,
    };
    const actual = {
      in_ded_ind: cigna.in_network_deductible_individual,
      in_ded_fam: cigna.in_network_deductible_family,
      in_oop_ind: cigna.in_network_oop_max_individual,
      in_oop_fam: cigna.in_network_oop_max_family,
      out_ded_ind: cigna.out_network_deductible_individual,
      out_ded_fam: cigna.out_network_deductible_family,
      out_oop_ind: cigna.out_network_oop_max_individual,
      out_oop_fam: cigna.out_network_oop_max_family,
    };
    const drift = Object.keys(expected).filter(
      (k) =>
        (expected as Record<string, unknown>)[k] !==
        (actual as Record<string, unknown>)[k],
    );
    if (drift.length === 0) {
      console.log("  ✅ Cigna plan at S71 baseline (no drift since S90 recovery)");
    } else {
      console.log(`  ❌ DRIFT detected: ${drift.join(", ")}`);
      console.log(`    expected: ${JSON.stringify(expected)}`);
      console.log(`    actual:   ${JSON.stringify(actual)}`);
    }
  }

  // 4. Verify Ambetter S90 doc dedup-eligibility
  console.log("\n--- Dedup-eligibility check for Ambetter S90 doc ---");
  const ambetterDoc = docs?.find((d) => d.id.startsWith(AMBETTER_DOC_ID));
  if (!ambetterDoc) {
    console.log("  ⚠️  Ambetter doc not found — may have been deleted; re-upload will create fresh row.");
  } else {
    const dedupable = ["queued", "processing", "processed"].includes(ambetterDoc.status as string);
    if (!dedupable) {
      console.log(
        `  ✅ Ambetter doc ${ambetterDoc.id.substring(0, 8)} status='${ambetterDoc.status}' — EXCLUDED from dedup whitelist; re-upload will create fresh row.`,
      );
    } else {
      console.log(
        `  ⚠️  Ambetter doc ${ambetterDoc.id.substring(0, 8)} status='${ambetterDoc.status}' — would HIT dedup; re-upload will return same documentId without re-parsing.`,
      );
    }
  }
}

main().catch((err) => {
  console.error("Snapshot failed:", err);
  process.exit(1);
});
