/**
 * Session-start flag truth — read-only dump of ALL feature_flag_rules for
 * WHICHEVER DATABASE `.env.local` currently points at.
 * Usage:  cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/flags/flag-state.ts
 *         (for PROD:  ./scripts/use-db.sh prod  first, then re-run)
 *
 * The DOC-recorded flag state drifts (S220 caught plan_doc_extraction_v2 ON while every
 * doc said OFF). This script is the ground truth — run it at session start, never trust a
 * hand-maintained list. Read-only (SELECT only); safe to run anytime.
 *
 * ⚠ S313 correction: this header used to read "in PROD" unconditionally. Post-OPS.9
 * `.env.local` is DEV unless `use-db.sh prod` was run, so for two months the tool that
 * exists to prevent stale flag beliefs was itself asserting the wrong database. The
 * banner below now names the project on every run — trust the banner, not the docstring.
 */
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv } from "../_env";

const env = loadScriptEnv();
const supabase = createClient(env.url, env.serviceRoleKey);

async function main() {
  const { data, error } = await supabase
    .from("feature_flag_rules")
    .select("flag_key, enabled, target_type, config")
    .order("flag_key");
  if (error) { console.log("ERR:", error); process.exit(1); }
  const rows = data ?? [];
  const on = rows.filter((r) => r.enabled).length;
  console.log(
    `Live feature_flag_rules — ${env.target} ground truth (${rows.length} rows, ${on} ON):`,
  );
  for (const r of rows) {
    const cfg = r.config && Object.keys(r.config).length ? `  ${JSON.stringify(r.config)}` : "";
    console.log(`  ${r.enabled ? "ON " : "off"}  ${r.flag_key}  [${r.target_type}]${cfg}`);
  }
}
main();
