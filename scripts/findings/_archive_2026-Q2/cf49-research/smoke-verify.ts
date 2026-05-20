import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ANDREW_USER_ID = "2ce55772-bdf1-4edd-bd16-215aa239990e";

async function main() {
  // 1. Find Andrew's most recent processed document
  const { data: recentDocs } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, classified_type, status, file_hash, created_at, processed_at")
    .eq("user_id", ANDREW_USER_ID)
    .eq("status", "processed")
    .order("created_at", { ascending: false })
    .limit(3);
  console.log("Andrew's 3 most recent processed docs:");
  for (const d of recentDocs ?? []) {
    console.log(`  ${d.id.slice(0,8)} hash=${(d.file_hash as string)?.slice(0,12)} type=${d.doc_type}/${d.classified_type} created=${d.created_at}`);
  }
  const newestDoc = recentDocs?.[0];
  if (!newestDoc) { console.log("No processed docs found."); return; }

  // 2. Find linked insurance_plans row + canonical
  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("id, canonical_plan_id, plan_name, insurer_name, created_at")
    .eq("source_document_id", newestDoc.id)
    .maybeSingle();
  console.log(`\nLinked insurance_plans for doc ${newestDoc.id.slice(0,8)}:`);
  console.log("  ", plan ? `${plan.id.slice(0,8)} canonical=${plan.canonical_plan_id?.slice(0,8)} name="${plan.plan_name}"` : "NONE");
  
  const canonicalId = plan?.canonical_plan_id;
  if (!canonicalId) { console.log("No canonical link — admin bypass cannot have fired."); return; }

  // 3. Check canonical_plan_services count for that canonical (was 0 globally pre-S102)
  const { count: cpsCount } = await supabase
    .from("canonical_plan_services")
    .select("*", { count: "exact", head: true })
    .eq("canonical_plan_id", canonicalId);
  console.log(`\ncanonical_plan_services rows for canonical ${canonicalId.slice(0,8)}: ${cpsCount}`);

  // 4. Check canonical_promotion_events for admin_override events on this canonical
  const { data: events, count: evtCount } = await supabase
    .from("canonical_promotion_events")
    .select("event_type, field_name, service_slug, fire_source, actor_user_id, fired_at", { count: "exact" })
    .eq("canonical_plan_id", canonicalId)
    .order("fired_at", { ascending: false });
  console.log(`\ncanonical_promotion_events for canonical ${canonicalId.slice(0,8)}: ${evtCount} total`);
  const byType: Record<string, number> = {};
  for (const e of events ?? []) byType[e.event_type as string] = (byType[e.event_type as string] ?? 0) + 1;
  for (const [t, c] of Object.entries(byType)) console.log(`  ${t}: ${c}`);
  console.log("\nFirst 5 events:");
  for (const e of (events ?? []).slice(0, 5)) {
    console.log(`  ${e.event_type} field=${e.field_name} slug=${e.service_slug ?? "(plan-identity)"} actor=${(e.actor_user_id as string)?.slice(0,8)} fired=${e.fired_at}`);
  }

  // 5. Global sanity — total canonical_plan_services count (was 0 before S102)
  const { count: globalCps } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true });
  console.log(`\nGlobal canonical_plan_services row count: ${globalCps}`);
  const { count: globalEvents } = await supabase.from("canonical_promotion_events").select("*", { count: "exact", head: true });
  console.log(`Global canonical_promotion_events row count: ${globalEvents}`);
  const { count: adminOverrideEvents } = await supabase.from("canonical_promotion_events").select("*", { count: "exact", head: true }).eq("event_type", "admin_override");
  console.log(`Global admin_override events: ${adminOverrideEvents}`);
}
main();
