import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const planId = "7410e617-62ed-4fa1-b823-e1cdd444c09b";
  const { data } = await supabase.from("insurance_plans").select("id, plan_name, deductible_individual, oop_max_individual, plan_year, plan_type, field_provenance").eq("id", planId).single();
  console.log(`Plan: ${data?.plan_name}`);
  console.log(`Values: ded_ind=${data?.deductible_individual} oop_ind=${data?.oop_max_individual} year=${data?.plan_year} type=${data?.plan_type}`);
  const fp = data?.field_provenance as Record<string, unknown> | null;
  console.log(`\nfield_provenance keys: ${fp ? Object.keys(fp).join(", ") : "(null)"}`);
  if (fp) {
    for (const k of ["deductible_individual", "oop_max_individual", "plan_year", "plan_name"]) {
      const v = fp[k] as Record<string, unknown> | undefined;
      if (v) console.log(`  ${k}: source=${v.source}, source_excerpt_verified=${v.source_excerpt_verified}, value=${JSON.stringify(v.value)}`);
      else console.log(`  ${k}: <missing>`);
    }
  }
}
main();
