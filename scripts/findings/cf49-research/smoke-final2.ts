import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const ANDREW_ADMIN = "2ce55772-bdf1-4edd-bd16-215aa239990e";

async function main() {
  // Most recent processed upload by admin Andrew
  const { data: docs } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", ANDREW_ADMIN)
    .eq("status", "processed")
    .order("created_at", { ascending: false })
    .limit(1);
  const doc = docs?.[0];
  if (!doc) { console.log("No processed doc found for admin user."); return; }
  console.log(`Doc ${(doc.id as string).slice(0,8)} file=${doc.file_name} status=${doc.status} step=${doc.processing_step} created=${doc.created_at}`);

  const { data: plans } = await supabase.from("insurance_plans").select("id, canonical_plan_id, plan_name, insurer_name").eq("source_document_id", doc.id);
  console.log(`\nLinked insurance_plans (${plans?.length} rows):`);
  for (const p of plans ?? []) console.log(`  id=${(p.id as string).slice(0,8)} canonical=${(p.canonical_plan_id as string)?.slice(0,8) ?? "(none)"} "${p.plan_name}"`);
  const canonicalId = plans?.[0]?.canonical_plan_id as string | undefined;
  if (!canonicalId) { console.log("No canonical link."); return; }

  const { count: cpsCount } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true }).eq("canonical_plan_id", canonicalId);
  console.log(`\ncanonical_plan_services for canonical ${canonicalId.slice(0,8)}: ${cpsCount} rows`);

  const { data: events, count: evtCount } = await supabase.from("canonical_promotion_events")
    .select("event_type, field_name, service_slug, fire_source, actor_user_id, fired_at", { count: "exact" })
    .eq("canonical_plan_id", canonicalId).order("fired_at", { ascending: false });
  console.log(`\ncanonical_promotion_events for canonical ${canonicalId.slice(0,8)}: ${evtCount} total`);
  const byType: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  for (const e of events ?? []) {
    byType[e.event_type as string] = (byType[e.event_type as string] ?? 0) + 1;
    const a = (e.actor_user_id as string)?.slice(0,8) ?? "(null)";
    byActor[a] = (byActor[a] ?? 0) + 1;
  }
  console.log("Type breakdown:", byType);
  console.log("Actor breakdown:", byActor);
  console.log("\nFirst 5 events:");
  for (const e of (events ?? []).slice(0,5)) {
    console.log(`  ${e.event_type} | field=${e.field_name} | slug=${e.service_slug ?? "(plan)"} | actor=${(e.actor_user_id as string)?.slice(0,8) ?? "null"} | fired=${e.fired_at}`);
  }

  const { count: globalCps } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true });
  const { count: adminOverrideEvents } = await supabase.from("canonical_promotion_events").select("*", { count: "exact", head: true }).eq("event_type", "admin_override");
  console.log(`\nGLOBAL: canonical_plan_services=${globalCps}, admin_override events=${adminOverrideEvents}`);
}
main();
