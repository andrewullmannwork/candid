import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const CANONICAL = "0de67fb0-7c6f-4c53-83a4-6992a770efc5";
  
  // Check ALL canonical_document_stability rows for this canonical
  const { data: stability } = await supabase.from("canonical_document_stability").select("*").eq("canonical_plan_id", CANONICAL);
  console.log(`canonical_document_stability rows for canonical 0de67fb0: ${stability?.length}`);
  for (const s of stability ?? []) {
    console.log(`  hash=${(s.file_hash as string)?.slice(0,16)} count=${s.identical_parse_count} stable=${s.haiku_output_stable} uploads=${s.upload_count} last=${s.last_seen_at}`);
  }
  
  // Check stability specifically for the current upload hash
  const FULL_HASH_PREFIX = "6723c36bb569";
  const { data: matchStab } = await supabase.from("canonical_document_stability").select("*").eq("canonical_plan_id", CANONICAL).like("file_hash", `${FULL_HASH_PREFIX}%`);
  console.log(`\nStability for (0de67fb0, ${FULL_HASH_PREFIX}*):`);
  for (const s of matchStab ?? []) console.log(`  ${JSON.stringify(s)}`);
  
  // Check verification_count on canonical (gates hash-dedup)
  const { data: canon } = await supabase.from("canonical_plans").select("id, verification_count, source_count, is_promoted, confidence_score").eq("id", CANONICAL).single();
  console.log(`\nCanonical 0de67fb0: verification_count=${canon?.verification_count} source_count=${canon?.source_count} confidence=${canon?.confidence_score}`);
  
  // Look at doc.processing_started_at vs processed_at to see if it was instant
  const { data: doc } = await supabase.from("documents").select("id, created_at, processed_at, processing_started_at, status, processing_step").eq("id", "062fdd7b-cf99-4ea0-a83d-7fd25a85cb0a").maybeSingle();
  // The id 062fdd7b is the prefix; let me search for any docs created in last 1 hour for andrew
  const { data: recent } = await supabase.from("documents").select("id, created_at, processed_at, processing_started_at, processing_step, status").eq("user_id", "2ce55772-bdf1-4edd-bd16-215aa239990e").order("created_at", { ascending: false }).limit(1);
  const r = recent?.[0];
  if (r) {
    console.log(`\nMost recent doc timing:`);
    console.log(`  id=${(r.id as string).slice(0,8)} created=${r.created_at}`);
    console.log(`  processing_started_at=${r.processing_started_at}`);
    console.log(`  processed_at=${r.processed_at}`);
    console.log(`  step=${r.processing_step} status=${r.status}`);
  }
  
  // SMART-SKIP TRACE — any documents.metadata.smart_skip_outcome ?
  const { data: smartSkipDocs } = await supabase.from("documents").select("id, metadata, created_at").eq("user_id", "2ce55772-bdf1-4edd-bd16-215aa239990e").order("created_at", { ascending: false }).limit(3);
  console.log(`\nRecent doc metadata snapshots:`);
  for (const d of smartSkipDocs ?? []) {
    const m = d.metadata as Record<string, unknown> | null;
    const keys = m ? Object.keys(m) : [];
    console.log(`  ${(d.id as string).slice(0,8)} metadata keys: ${keys.join(", ")}`);
  }
}
main();
