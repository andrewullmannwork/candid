/** One-off: seed the mig 202 flag row (OFF) so flag-set.ts can flip it. Delete after use. */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const flagKey = "dispute_letters_free_start_v1";
  const before = await s
    .from("feature_flag_rules")
    .select("flag_key,enabled,target_type,config")
    .eq("flag_key", flagKey)
    .maybeSingle();
  if (before.error) {
    console.log("READ ERR:", before.error);
    process.exit(1);
  }
  if (before.data) {
    console.log("EXISTS (no seed needed):", before.data);
    return;
  }
  const ins = await s
    .from("feature_flag_rules")
    .insert({
      flag_key: flagKey,
      enabled: false,
      description:
        'Dispute letters "free to start, pay to escalate" FE alignment (mig 202, 2026-07). Default OFF. Gates /disputes Pro-wall removal + landing/billing free-to-start copy. OFF preserves today\'s Pro-wall byte-identical.',
      target_type: "global",
      config: {},
    })
    .select("flag_key,enabled,target_type,config");
  if (ins.error) {
    console.log("INSERT ERR:", ins.error);
    process.exit(1);
  }
  console.log("SEEDED (OFF):", ins.data);
}
main();
