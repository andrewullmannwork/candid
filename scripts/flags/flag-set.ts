/**
 * Flip a feature flag's `enabled` state in PROD. Service-role (bypasses RLS). Reversible + verifiable:
 * reads BEFORE, updates, reads AFTER, prints the exact revert command. Mirrors flag-state.ts.
 * Usage:  cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/flags/flag-set.ts <flag_key> <true|false>
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const flagKey = process.argv[2];
  const arg = process.argv[3];
  if (!flagKey || (arg !== "true" && arg !== "false")) {
    console.log("Usage: npx tsx scripts/flags/flag-set.ts <flag_key> <true|false>");
    process.exit(1);
  }
  const enabled = arg === "true";

  const before = await supabase
    .from("feature_flag_rules")
    .select("flag_key, enabled, target_type")
    .eq("flag_key", flagKey)
    .maybeSingle();
  if (before.error) { console.log("BEFORE read ERR:", before.error); process.exit(1); }
  if (!before.data) { console.log(`No flag row for '${flagKey}' — nothing to flip (seed it via migration first).`); process.exit(1); }
  console.log("BEFORE:", before.data);

  if (before.data.enabled === enabled) {
    console.log(`No-op: '${flagKey}' is already ${enabled ? "ON" : "off"}.`);
    return;
  }

  const upd = await supabase
    .from("feature_flag_rules")
    .update({ enabled })
    .eq("flag_key", flagKey)
    .select("flag_key, enabled, target_type");
  if (upd.error) { console.log("UPDATE ERR:", upd.error); process.exit(1); }
  console.log("AFTER :", upd.data);
  console.log(`Revert: npx tsx scripts/flags/flag-set.ts ${flagKey} ${enabled ? "false" : "true"}`);
}
main();
