/**
 * Inspect Andrew's hung gold-80 upload to figure out what state it's stuck in.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // Find recent docs matching the filename
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, user_id, file_name, doc_type, classified_type, status, processing_step, processing_error, created_at, classification_signals")
    .ilike("file_name", "%gold-80%")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  console.log(`Found ${docs?.length ?? 0} recent gold-80 docs:\n`);
  for (const d of docs ?? []) {
    const ageMin = ((Date.now() - new Date(d.created_at).getTime()) / 60000).toFixed(1);
    console.log(`--- doc ${d.id} (${ageMin} min old) ---`);
    console.log(`  file_name: ${d.file_name}`);
    console.log(`  doc_type (user pick): ${d.doc_type}`);
    console.log(`  classified_type: ${d.classified_type}`);
    console.log(`  status: ${d.status}`);
    console.log(`  processing_step: ${d.processing_step}`);
    console.log(`  processing_error: ${d.processing_error}`);
    if (d.classification_signals) {
      console.log(`  classification_signals: ${JSON.stringify(d.classification_signals)}`);
    }
    console.log();
  }

  // Also check for any insurance_plans rows linked to the most recent doc
  if (docs && docs.length > 0) {
    const latestDoc = docs[0];
    const { data: plans } = await supabase
      .from("insurance_plans")
      .select("id, source, confidence, created_at, plan_name")
      .eq("source_document_id", latestDoc.id)
      .limit(5);
    console.log(`insurance_plans rows linked to doc ${latestDoc.id}: ${plans?.length ?? 0}`);
    for (const p of plans ?? []) {
      console.log(`  plan ${p.id}: source=${p.source} confidence=${p.confidence} plan_name=${p.plan_name}`);
    }

    // plan_covered_services count
    if (plans && plans.length > 0) {
      const { count } = await supabase
        .from("plan_covered_services")
        .select("*", { count: "exact", head: true })
        .eq("insurance_plan_id", plans[0].id);
      console.log(`plan_covered_services for plan ${plans[0].id}: ${count ?? 0}`);
    }
  }
}

main();
