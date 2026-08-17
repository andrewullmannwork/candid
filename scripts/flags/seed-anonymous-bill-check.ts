/**
 * Seed the `anonymous_bill_check_v1` flag row (OFF) — S315 A-1.
 *
 * Gates: the /check route + the anonymous path through /api/auth/sync + the
 * landing/signup escape links (SP-1). Config keys (readFeatureFlagConfig):
 *   landing_variant           "A" | "B" | "off" — which hero treatment renders
 *                             (Andrew chose "B", S315; "off" hides the landing
 *                             button while keeping /check reachable by URL)
 *   anon_starts_per_ip_per_day  fixed-window cap on NEW anonymous-account
 *                             creations per IP (consume_login_rate_limit RPC)
 *
 * Mirrors mig 075 schema: flag_key sole UNIQUE, target_type (NOT scope),
 * config JSONB. Run against the env in .env.local (DEV by default; PROD seed
 * is a deliberate later step): npx tsx scripts/flags/seed-anonymous-bill-check.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(`### target: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`);
  const flagKey = "anonymous_bill_check_v1";
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
        "S315 no-account bill check (/check): anonymous Firebase entry + landing/signup escape links. Default OFF. Config: landing_variant A|B|off, anon_starts_per_ip_per_day. Design: vault plans/s315-anonymous-funnel-design.md.",
      target_type: "global",
      config: { landing_variant: "B", anon_starts_per_ip_per_day: 5 },
    })
    .select("flag_key,enabled,target_type,config");
  if (ins.error) {
    console.log("INSERT ERR:", ins.error);
    process.exit(1);
  }
  console.log("SEEDED (OFF):", ins.data);
}
main();
