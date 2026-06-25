/**
 * Session-start flag truth — read-only dump of ALL feature_flag_rules in PROD.
 * Usage:  cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/flags/flag-state.ts
 *
 * The DOC-recorded flag state drifts (S220 caught plan_doc_extraction_v2 ON while every
 * doc said OFF). This script is the ground truth — run it at session start, never trust a
 * hand-maintained list. Read-only (SELECT only); safe to run anytime.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data, error } = await supabase
    .from("feature_flag_rules")
    .select("flag_key, enabled, target_type, config")
    .order("flag_key");
  if (error) { console.log("ERR:", error); process.exit(1); }
  const rows = data ?? [];
  const on = rows.filter((r) => r.enabled).length;
  console.log(`Live feature_flag_rules — PROD ground truth (${rows.length} rows, ${on} ON):`);
  for (const r of rows) {
    const cfg = r.config && Object.keys(r.config).length ? `  ${JSON.stringify(r.config)}` : "";
    console.log(`  ${r.enabled ? "ON " : "off"}  ${r.flag_key}  [${r.target_type}]${cfg}`);
  }
}
main();
