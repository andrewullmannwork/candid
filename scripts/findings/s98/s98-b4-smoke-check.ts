/** scripts/findings/s98/s98-b4-smoke-check.ts — verify Andrew's SBC-as-Bill smoke result. */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  // Get Andrew's most recent 5 docs
  const { data: u } = await sb.from("users").select("id").eq("email", "andrew.david.ullmann@gmail.com").single();
  const userId = u!.id as string;
  const { data: docs } = await sb
    .from("documents")
    .select("id, doc_type, classified_type, classification_confidence, type_mismatch, status, processing_step, processing_error, file_name, created_at, parse_quality_layout, parse_quality_failure_mode")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("Andrew's last 5 docs:\n");
  for (const d of docs ?? []) {
    console.log(`  ${d.created_at}`);
    console.log(`    id=${(d.id as string).substring(0, 8)} file=${d.file_name}`);
    console.log(`    user_picked=${d.doc_type} → classified=${d.classified_type} (conf=${d.classification_confidence}, mismatch=${d.type_mismatch})`);
    console.log(`    status=${d.status} step=${d.processing_step ?? "<null>"} err=${d.processing_error ?? "<null>"}`);
    if (d.parse_quality_layout !== null && d.parse_quality_layout !== undefined) {
      console.log(`    layout=${d.parse_quality_layout} failure_mode=${d.parse_quality_failure_mode ?? "<null>"}`);
    }
    console.log("");
  }
  // For the most recent doc — was a claim row created (bill parser ran) OR insurance_plans (plan_doc parser)?
  if (docs && docs.length > 0) {
    const docId = docs[0].id as string;
    const { count: claimCount } = await sb.from("claims").select("id", { count: "exact", head: true }).eq("source_document_id", docId);
    const { count: planCount } = await sb.from("insurance_plans").select("id", { count: "exact", head: true }).eq("source_document_id", docId);
    console.log(`Most recent doc ${(docId as string).substring(0, 8)}:`);
    console.log(`  claims rows from this doc: ${claimCount ?? 0}`);
    console.log(`  insurance_plans rows from this doc: ${planCount ?? 0}`);
  }
})();
