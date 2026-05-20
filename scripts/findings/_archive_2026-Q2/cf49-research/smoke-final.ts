import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DOC_ID = "062fdd7b";

async function main() {
  // Full doc + canonical link
  const { data: doc } = await supabase.from("documents").select("*").like("id", `${DOC_ID}%`).single();
  console.log(`Doc ${(doc?.id as string)?.slice(0,8)} file=${doc?.file_name} status=${doc?.status} processing_step=${doc?.processing_step}`);

  const { data: plan } = await supabase.from("insurance_plans").select("id, canonical_plan_id, plan_name, insurer_name").eq("source_document_id", doc?.id).maybeSingle();
  console.log(`\nLinked insurance_plans: id=${(plan?.id as string)?.slice(0,8) ?? "(none)"} canonical=${(plan?.canonical_plan_id as string)?.slice(0,8) ?? "(none)"} name="${plan?.plan_name}"`);
  const canonicalId = plan?.canonical_plan_id as string | undefined;
  if (!canonicalId) { console.log("No canonical link."); return; }

  // canonical_plan_services count for THIS canonical
  const { count: cpsCount } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true }).eq("canonical_plan_id", canonicalId);
  console.log(`\ncanonical_plan_services for canonical ${canonicalId.slice(0,8)}: ${cpsCount} rows`);

  // canonical_promotion_events for this canonical
  const { data: events, count: evtCount } = await supabase.from("canonical_promotion_events")
    .select("event_type, field_name, service_slug, fire_source, actor_user_id, fired_at", { count: "exact" })
    .eq("canonical_plan_id", canonicalId).order("fired_at", { ascending: false }).limit(15);
  console.log(`\ncanonical_promotion_events for canonical ${canonicalId.slice(0,8)}: ${evtCount} total`);
  const byType: Record<string, number> = {};
  for (const e of events ?? []) byType[e.event_type as string] = (byType[e.event_type as string] ?? 0) + 1;
  console.log("Type breakdown:", byType);
  console.log("\nFirst 10 events:");
  for (const e of (events ?? []).slice(0, 10)) {
    console.log(`  ${e.event_type} field=${e.field_name} slug=${e.service_slug ?? "(plan)"} src=${e.fire_source} actor=${(e.actor_user_id as string)?.slice(0,8)} fired=${e.fired_at}`);
  }

  // canonical_plan_services sample rows
  const { data: cpsRows } = await supabase.from("canonical_plan_services")
    .select("service_slug, confidence, source, created_at")
    .eq("canonical_plan_id", canonicalId).limit(8);
  console.log(`\ncanonical_plan_services sample (first 8 of ${cpsCount}):`);
  for (const r of cpsRows ?? []) console.log(`  ${r.service_slug} src=${r.source} conf=${r.confidence}`);

  // GLOBAL stats — has anything else moved?
  const { count: globalCps } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true });
  const { count: globalEvents } = await supabase.from("canonical_promotion_events").select("*", { count: "exact", head: true });
  const { count: adminOverrideEvents } = await supabase.from("canonical_promotion_events").select("*", { count: "exact", head: true }).eq("event_type", "admin_override");
  console.log(`\nGLOBAL: canonical_plan_services=${globalCps} canonical_promotion_events=${globalEvents} admin_override events=${adminOverrideEvents}`);
}
main();
