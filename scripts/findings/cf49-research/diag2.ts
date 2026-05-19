import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Most recent doc + canonical_haiku_extractions confirms Haiku actually ran
  const { data: docs } = await supabase.from("documents").select("id, created_at, file_hash, doc_type, status").eq("user_id", "2ce55772-bdf1-4edd-bd16-215aa239990e").order("created_at", { ascending: false }).limit(2);
  for (const d of docs ?? []) {
    const { count: heCount } = await supabase.from("canonical_haiku_extractions").select("*", { count: "exact", head: true }).eq("document_id", d.id);
    console.log(`Doc ${(d.id as string).slice(0,8)} created=${d.created_at} status=${d.status} hash=${(d.file_hash as string)?.slice(0,12)} canonical_haiku_extractions=${heCount}`);
  }

  // Check stability for the SBC canonical+hash combo  
  const { data: stab } = await supabase.from("canonical_document_stability").select("*").eq("canonical_plan_id", "0de67fb0-7c6f-4c53-83a4-6992a770efc5");
  console.log(`\ncanonical_document_stability for 0de67fb0:`);
  for (const s of stab ?? []) console.log(`  hash=${(s.file_hash as string)?.slice(0,12)} count=${s.identical_parse_count} uploads=${s.upload_count} stable=${s.haiku_output_stable} last=${s.last_seen_at}`);
}
main();
