import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ANDREW = "2ce55772-bdf1-4edd-bd16-215aa239990e";
const CANONICAL = "0de67fb0-7c6f-4c53-83a4-6992a770efc5";

async function main() {
  // Recent doc + query canonical_haiku_extractions with all possible link columns
  const { data: docs } = await supabase.from("documents").select("id, created_at").eq("user_id", ANDREW).order("created_at", { ascending: false }).limit(1);
  const docId = docs?.[0]?.id;
  console.log(`Most recent doc id: ${docId}`);

  // Try different link columns
  const colCandidates = ["source_document_id", "document_id", "user_document_id", "doc_id"];
  for (const col of colCandidates) {
    const { count, error } = await supabase.from("canonical_haiku_extractions").select("*", { count: "exact", head: true }).eq(col, docId);
    if (!error) console.log(`  canonical_haiku_extractions.${col}=${docId} → ${count} rows`);
  }
  
  // Try by haiku_run_id near upload time
  const upAt = docs?.[0]?.created_at;
  if (upAt) {
    const { count } = await supabase.from("canonical_haiku_extractions").select("*", { count: "exact", head: true }).eq("canonical_plan_id", CANONICAL).gte("created_at", upAt);
    console.log(`  canonical_haiku_extractions for canonical=0de67fb0 created>=${upAt}: ${count} rows`);
  }
  
  // Sample one extraction row to see column schema
  const { data: he } = await supabase.from("canonical_haiku_extractions").select("*").eq("canonical_plan_id", CANONICAL).order("created_at", { ascending: false }).limit(1);
  if (he?.[0]) {
    console.log(`\nMost recent canonical_haiku_extractions row keys: ${Object.keys(he[0]).join(", ")}`);
    console.log(`Most recent created_at: ${he[0].created_at}`);
    console.log(`Most recent source_doc-like fields:`, {
      source_user_doc_hash: he[0].source_user_doc_hash,
      source_document_id: he[0].source_document_id,
      document_id: he[0].document_id,
    });
  }
}
main();
