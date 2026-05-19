import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Verification count on test canonical
  const { data, error } = await supabase.from("canonical_plans").select("id, verification_count, source_count, plan_name, confidence_score").eq("id", "0de67fb0-7c6f-4c53-83a4-6992a770efc5").single();
  console.log("Test canonical 0de67fb0:", JSON.stringify(data, null, 2), "err:", error?.message);
  // Top canonicals by verification_count
  const { data: top } = await supabase.from("canonical_plans").select("id, verification_count, source_count, plan_name").order("verification_count", { ascending: false, nullsFirst: false }).limit(10);
  console.log("\nTop 10 canonicals by verification_count:");
  for (const c of top ?? []) console.log(`  ${c.id.slice(0,8)}… v_count=${c.verification_count} src=${c.source_count} "${c.plan_name?.slice(0,50)}"`);
  // How many canonicals are at verification_count >= 3 (would trigger hash-dedup early return)
  const { count: promotedCount } = await supabase.from("canonical_plans").select("*", { count: "exact", head: true }).gte("verification_count", 3);
  console.log(`\nCanonicals with verification_count >= 3 (hash-dedup eligible): ${promotedCount}`);
  // Check distinct uploader_ids on insurance_plans linked to test canonical
  const { data: plans } = await supabase.from("insurance_plans").select("user_id").eq("canonical_plan_id", "0de67fb0-7c6f-4c53-83a4-6992a770efc5");
  const distinctUsers = new Set((plans ?? []).map(p => p.user_id));
  console.log(`\nDistinct user_ids who uploaded plans linked to test canonical: ${distinctUsers.size} (${[...distinctUsers].slice(0,3).map(u => u?.slice(0,8)).join(", ")}…)`);
  console.log(`Total insurance_plans rows linked to test canonical: ${plans?.length}`);
}
main();
