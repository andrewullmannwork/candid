import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const planId = "7410e617-62ed-4fa1-b823-e1cdd444c09b";
  const { data, error } = await supabase.from("insurance_plans").select("*").eq("id", planId).maybeSingle();
  if (error) { console.log("err:", error); return; }
  if (!data) { console.log("no plan found by id"); return; }
  console.log("Columns:", Object.keys(data).join(", "));
  console.log("\nValues:");
  for (const k of Object.keys(data)) {
    const v = (data as Record<string, unknown>)[k];
    if (v && typeof v === "object") console.log(`  ${k}: ${JSON.stringify(v).slice(0,200)}`);
    else console.log(`  ${k}: ${v}`);
  }
}
main();
