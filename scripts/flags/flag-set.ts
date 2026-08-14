/**
 * Flip a feature flag's `enabled` state. Service-role (bypasses RLS). Reversible + verifiable:
 * reads BEFORE, updates, reads AFTER, prints the exact revert command. Mirrors flag-state.ts.
 * Usage:  cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/flags/flag-set.ts <flag_key> <true|false>
 *
 * ⚠ Writes to whichever database `.env.local` points at — DEV by default,
 * PROD after `./scripts/use-db.sh prod`. The banner names it on every run and
 * a PROD flip requires `--prod-write` (S313). This script used to claim "in
 * PROD" in its own first line while reading DEV.
 */
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv, requireWriteAck } from "../_env";

const env = loadScriptEnv();
const supabase = createClient(env.url, env.serviceRoleKey);

async function main() {
  const flagKey = process.argv[2];
  const arg = process.argv[3];
  if (!flagKey || (arg !== "true" && arg !== "false")) {
    console.log("Usage: npx tsx scripts/flags/flag-set.ts <flag_key> <true|false> [--prod-write]");
    process.exit(1);
  }
  const enabled = arg === "true";
  requireWriteAck(env, true);

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
