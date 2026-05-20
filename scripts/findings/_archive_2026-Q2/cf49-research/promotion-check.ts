import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Check canonical_promotion_event_v1 flag
  const { data: flagData } = await supabase.from("feature_flag_rules").select("*").eq("flag_key", "canonical_promotion_event_v1");
  console.log("canonical_promotion_event_v1 flag:", JSON.stringify(flagData, null, 2));

  // Check is_promoted on the test canonical
  const { data: canon } = await supabase.from("canonical_plans").select("id, is_promoted, source_count, confidence_score, plan_name, field_provenance").eq("id", "0de67fb0-7c6f-4c53-83a4-6992a770efc5").single();
  console.log("\nTest canonical 0de67fb0:");
  console.log("  is_promoted:", canon?.is_promoted);
  console.log("  source_count:", canon?.source_count);
  console.log("  confidence_score:", canon?.confidence_score);
  console.log("  plan_name:", canon?.plan_name);
  console.log("  field_provenance keys:", canon?.field_provenance ? Object.keys(canon.field_provenance) : "(null)");

  // Check ALL canonicals' is_promoted state
  const { data: allCanon } = await supabase.from("canonical_plans").select("id, is_promoted, source_count, plan_name").not("is_promoted", "is", null).order("source_count", { ascending: false }).limit(10);
  console.log("\nTop 10 canonicals by source_count:");
  for (const c of allCanon ?? []) console.log(`  ${c.id.slice(0,8)}… promoted=${c.is_promoted} sources=${c.source_count} name="${c.plan_name?.slice(0,50)}"`);
  
  const { count: promotedCount } = await supabase.from("canonical_plans").select("*", { count: "exact", head: true }).eq("is_promoted", true);
  console.log(`\nTotal promoted canonicals: ${promotedCount}`);
  
  const { count: totalCanon } = await supabase.from("canonical_plans").select("*", { count: "exact", head: true });
  console.log(`Total canonicals: ${totalCanon}`);

  // Pattern 1 #3 corroboration threshold — look in feature_flag config
  const { data: corrCfg } = await supabase.from("feature_flag_rules").select("*").like("flag_key", "%corrobor%");
  console.log("\nCorroboration-related flags:", JSON.stringify(corrCfg, null, 2));
}
main();
