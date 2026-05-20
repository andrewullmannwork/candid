import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Sanity-check canonical_plan_services emptiness
  const { count: cpsCount, error: e1 } = await supabase.from("canonical_plan_services").select("*", { count: "exact", head: true });
  console.log(`canonical_plan_services total rows globally: ${cpsCount} (err: ${e1?.message ?? "none"})`);
  
  // 2. Look for ALL canonical_* tables that might hold services
  const candidates = ["canonical_plan_services", "canonical_services", "canonical_plan_service", "canonical_haiku_extractions"];
  for (const t of candidates) {
    const { count, error } = await supabase.from(t).select("*", { count: "exact", head: true });
    console.log(`  ${t}: ${count ?? "ERR"} rows (err: ${error?.message ?? "none"})`);
  }
  
  // 3. Check canonical_promotion_events
  const { data: promoEvents, error: e3 } = await supabase.from("canonical_promotion_events").select("*").limit(20);
  console.log(`\ncanonical_promotion_events: ${promoEvents?.length ?? 0} rows`);
  if (promoEvents && promoEvents.length > 0) console.log(JSON.stringify(promoEvents.slice(0,3), null, 2));
  
  // 4. Check if canonical_plan_services has ANY rows ANYWHERE (no filter)
  const { data: anyRows } = await supabase.from("canonical_plan_services").select("canonical_plan_id, service_slug").limit(5);
  console.log(`\ncanonical_plan_services sample (first 5):`, anyRows);
}
main();
