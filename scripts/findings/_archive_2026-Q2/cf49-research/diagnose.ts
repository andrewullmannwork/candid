import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ANDREW_ADMIN = "2ce55772-bdf1-4edd-bd16-215aa239990e";

async function main() {
  // Latest doc + metadata
  const { data: docs } = await supabase.from("documents").select("*").eq("user_id", ANDREW_ADMIN).order("created_at", { ascending: false }).limit(1);
  const doc = docs?.[0];
  if (!doc) { console.log("no doc"); return; }
  console.log(`Doc: ${(doc.id as string).slice(0,8)} doc_type=${doc.doc_type} classified=${doc.classified_type} status=${doc.status} step=${doc.processing_step}`);
  console.log(`  file_hash=${(doc.file_hash as string)?.slice(0,16)}`);
  console.log(`  metadata=${JSON.stringify(doc.metadata).slice(0,500)}`);
  console.log(`  processing_error=${doc.processing_error}`);
  
  // canonical_haiku_extractions for this doc — did Haiku actually parse?
  const { count: heCount } = await supabase.from("canonical_haiku_extractions").select("*", { count: "exact", head: true }).eq("source_document_id", doc.id);
  console.log(`\ncanonical_haiku_extractions for this doc: ${heCount} rows`);

  // is_admin sanity check
  const { data: user } = await supabase.from("users").select("id, email, is_admin").eq("id", ANDREW_ADMIN).single();
  console.log(`\nAdmin user verified: ${user?.email} is_admin=${user?.is_admin}`);
  
  // Check the doc's confidence_score on canonical link — maybe it was high-conf auto-link OR needs_confirmation
  const { data: plan } = await supabase.from("insurance_plans").select("*").eq("source_document_id", doc.id).maybeSingle();
  console.log(`\nLinked plan canonical=${(plan?.canonical_plan_id as string)?.slice(0,8)} confidence=${plan?.canonical_match_confidence} needs_confirmation=${plan?.canonical_needs_confirmation}`);
  
  // Check if canonical_promotion_event_v1 flag is on
  const { data: flag } = await supabase.from("feature_flag_rules").select("*").eq("flag_key", "canonical_promotion_event_v1").maybeSingle();
  console.log(`\ncanonical_promotion_event_v1: enabled=${flag?.enabled} target_type=${flag?.target_type} config=${JSON.stringify(flag?.config)}`);
}
main();
