import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Get most recent 5 documents (no user filter; Andrew is the only one uploading)
  const { data: docs, error } = await sb
    .from("documents")
    .select("id, file_name, doc_type, classified_type, classification_confidence, status, processing_step, created_at, user_id, file_hash, parse_quality_score, parse_quality_layout")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) { console.log("ERROR:", error.message); return; }
  console.log("=== 5 most recent documents ===");
  docs?.forEach((d: any) => {
    console.log(`  ${d.id}`);
    console.log(`    file_name=${d.file_name}`);
    console.log(`    doc_type=${d.doc_type} | classified=${d.classified_type} (conf=${d.classification_confidence})`);
    console.log(`    status=${d.status} | step=${d.processing_step}`);
    console.log(`    parse_quality_score=${d.parse_quality_score} | layout=${d.parse_quality_layout}`);
    console.log(`    file_hash=${(d.file_hash ?? "").slice(0,12)} | user=${d.user_id?.slice(0,8)}`);
    console.log(`    created=${d.created_at}`);
    console.log("");
  });
}

main().catch(e => { console.error(e); process.exit(1); });
