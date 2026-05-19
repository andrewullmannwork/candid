import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Wider time window — last 24h, any user
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, user_id, file_name, status, file_hash, created_at")
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false })
    .limit(10);
  console.log(`Docs in last 24h (any user, any status): ${docs?.length}`);
  for (const d of docs ?? []) {
    console.log(`  ${(d.id as string).slice(0,8)} user=${(d.user_id as string)?.slice(0,8)} status=${d.status} hash=${(d.file_hash as string)?.slice(0,12)} file=${d.file_name?.slice(0,40)} created=${d.created_at}`);
  }
  
  // 2. Check whether mig 111 applied (apply_promotion_event has p_force_event_type)
  console.log("\nChecking apply_promotion_event function signature...");
  const { data: funcInfo, error } = await supabase.rpc("apply_promotion_event", {
    p_canonical_plan_id: "00000000-0000-0000-0000-000000000000",
    p_service_slug: null,
    p_field_name: "test",
    p_corroborated_value: JSON.stringify({}),
    p_sources: [],
    p_fire_source: "smoke-test",
    p_actor_user_id: null,
    p_force_event_type: "admin_override",
  });
  if (error) {
    if (error.message?.includes("p_force_event_type") || error.message?.includes("does not exist")) {
      console.log("  ❌ mig 111 NOT applied — function rejects p_force_event_type parameter");
      console.log(`  Error: ${error.message}`);
    } else if (error.message?.includes("not found")) {
      console.log("  ✅ mig 111 IS applied (function accepted p_force_event_type; failed only because canonical doesn't exist)");
      console.log(`  Expected: ${error.message}`);
    } else {
      console.log(`  ⚠ Ambiguous: ${error.message}`);
    }
  } else {
    console.log(`  ✅ mig 111 applied (call succeeded; data=${JSON.stringify(funcInfo)})`);
  }
}
main();
