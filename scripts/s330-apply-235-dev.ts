// S330 — apply migration 235 to the DEV project from the migration FILE, verbatim
// (feedback_candid_migration_source_of_truth: the mig file IS the SQL). DEV-guarded.
// Uses the ad-hoc exec_sql(query) RPC that still exists on DEV. Then verifies.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not the DEV project:", url); process.exit(2); }
const sb = createClient(url, key);
const sql = readFileSync("supabase/migrations/235_dfy_operator_lane.sql", "utf8");
// Strip comment-only lines (the Studio trap), then split on statement terminators.
const body = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const statements = body.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
async function main() {
  console.log("target:", url, "| statements:", statements.length);
  for (const [i, st] of statements.entries()) {
    const r = await sb.rpc("exec_sql", { query: st });
    if (r.error) { console.error(`✗ statement ${i + 1} failed:`, r.error.message, "\n", st.slice(0, 140)); process.exit(1); }
    console.log(`✓ ${i + 1}/${statements.length}`, st.split("\n")[0].slice(0, 90));
  }
  const t = await sb.from("dfy_engagements").select("id", { count: "exact", head: true });
  console.log("dfy_engagements:", t.error ? `ERROR ${t.error.message}` : `present (count ${t.count})`);
  const u = await sb.from("users").select("is_operator").limit(1);
  console.log("users.is_operator:", u.error ? `ERROR ${u.error.message}` : "present");
  const f = await sb.from("feature_flag_rules").select("flag_key, enabled, config").eq("flag_key", "dfy_operator_v1").maybeSingle();
  console.log("flag row:", f.error ? `ERROR ${f.error.message}` : JSON.stringify(f.data));
}
main();
