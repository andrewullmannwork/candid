import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const planId = "7410e617-62ed-4fa1-b823-e1cdd444c09b";
  const { count: pcsCount } = await supabase.from("plan_covered_services").select("*", { count: "exact", head: true }).eq("insurance_plan_id", planId);
  console.log(`plan_covered_services for plan: ${pcsCount}`);

  const { data } = await supabase.from("plan_covered_services").select("*").eq("insurance_plan_id", planId).limit(1);
  if (!data?.[0]) { console.log("no row"); return; }
  console.log(`\nColumns:`, Object.keys(data[0]));
  const fp = data[0].field_provenance as Record<string, unknown> | null;
  console.log(`\nfield_provenance keys: ${fp ? Object.keys(fp).join(", ") : "(null)"}`);
  if (fp) {
    for (const k of Object.keys(fp).slice(0, 3)) {
      console.log(`\n  ${k}: ${JSON.stringify(fp[k]).slice(0, 300)}`);
    }
  }
  
  // Check insurance_plans field_provenance for source_excerpt_verified
  const { data: planRow } = await supabase.from("insurance_plans").select("field_provenance").eq("id", planId).single();
  const planFp = planRow?.field_provenance as Record<string, Record<string, unknown>> | null;
  if (planFp) {
    const sample = planFp["in_deductible_individual"];
    console.log(`\nin_deductible_individual subkeys: ${sample ? Object.keys(sample).join(", ") : "(missing)"}`);
    if (sample) console.log(`  source_excerpt_verified=${sample.source_excerpt_verified}`);
  }
}
main();
