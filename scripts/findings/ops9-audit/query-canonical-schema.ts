/**
 * Inspect canonical_plans + canonical_promotion_events column names by
 * fetching a single row from each.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // canonical_plans columns
  const { data: cp } = await supabase
    .from("canonical_plans")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (cp) {
    console.log("=== canonical_plans columns ===");
    console.log(Object.keys(cp).sort().join(", "));
    console.log("");
  }

  // canonical_promotion_events columns
  const { data: cpe } = await supabase
    .from("canonical_promotion_events")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (cpe) {
    console.log("=== canonical_promotion_events columns ===");
    console.log(Object.keys(cpe).sort().join(", "));
    console.log("");
    console.log("=== canonical_promotion_events sample row ===");
    console.log(JSON.stringify(cpe, null, 2).substring(0, 2000));
    console.log("");
  }

  // canonical_plan_services columns
  const { data: cps } = await supabase
    .from("canonical_plan_services")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (cps) {
    console.log("=== canonical_plan_services columns ===");
    console.log(Object.keys(cps).sort().join(", "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
