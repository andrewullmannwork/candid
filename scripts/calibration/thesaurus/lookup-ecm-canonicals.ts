/**
 * Look up canonical_plan_id for the 2 Clarity NH SBC docs.
 * Filename: 13219NH0010001_2026_SBC_Clarity_NH_Gold_2000_01.pdf
 *           13219NH0010005_2026_SBC_Clarity_NH_Bronze_7500_HSA_01.pdf
 * HIOS prefix: 13219NH001
 */
import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

async function main() {
  // Try by HIOS ID first
  const hiosPatterns = ["13219NH0010001", "13219NH0010005"];
  for (const h of hiosPatterns) {
    const { data, error } = await supabase
      .from("canonical_plans")
      .select("id, plan_name, metal_level, state, hios_id")
      .eq("hios_id", h)
      .limit(5);
    console.log(`\nHIOS ${h}:`, error?.message ?? JSON.stringify(data));
  }

  // Try by plan name
  const names = ["Clarity NH Gold", "Clarity NH Bronze", "Gold 2000", "Bronze 7500"];
  for (const n of names) {
    const { data, error } = await supabase
      .from("canonical_plans")
      .select("id, plan_name, metal_level, state, hios_id")
      .ilike("plan_name", `%${n}%`)
      .limit(5);
    console.log(`\nName ~${n}:`, error?.message ?? JSON.stringify(data));
  }

  // Try by state NH
  const { data: nhPlans } = await supabase
    .from("canonical_plans")
    .select("id, plan_name, metal_level, state, hios_id")
    .eq("state", "NH")
    .eq("plan_year", 2026)
    .limit(20);
  console.log(`\nAll NH 2026 plans (${nhPlans?.length}):`);
  nhPlans?.forEach(r => console.log(`  ${r.id} | ${r.plan_name} | ${r.metal_level} | hios=${r.hios_id}`));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
