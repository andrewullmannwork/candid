// S330 DEV probe — does the ad-hoc exec_sql RPC still exist on the DEV project?
// Read-only: runs `select 1`. DEV-guarded by URL prefix.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not the DEV project:", url); process.exit(2); }
const sb = createClient(url, key);
async function main() {
  const r1 = await sb.rpc("exec_sql", { sql: "select 1 as one" });
  console.log("exec_sql(sql):", r1.error ? `ERROR ${r1.error.code} ${r1.error.message}` : JSON.stringify(r1.data).slice(0, 120));
  const r2 = await sb.rpc("exec_sql", { query: "select 1 as one" });
  console.log("exec_sql(query):", r2.error ? `ERROR ${r2.error.code} ${r2.error.message}` : JSON.stringify(r2.data).slice(0, 120));
  const ff = await sb.from("feature_flag_rules").select("flag_key, enabled").in("flag_key", ["case_rail_v1","case_timeline_v1","member_composition_v1","forum_menu_v1"]);
  console.log("DEV flags:", JSON.stringify(ff.data));
  const cols = await sb.from("dfy_engagements").select("id").limit(1);
  console.log("dfy_engagements exists?", cols.error ? `no (${cols.error.code})` : "YES");
}
main();
