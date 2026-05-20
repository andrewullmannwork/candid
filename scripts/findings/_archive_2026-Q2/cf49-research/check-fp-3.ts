import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const planId = "7410e617-62ed-4fa1-b823-e1cdd444c09b";
  const { data } = await supabase.from("insurance_plans").select("field_provenance").eq("id", planId).single();
  const fp = data?.field_provenance as Record<string, unknown> | null;
  console.log("field_provenance keys:", fp ? Object.keys(fp) : "(null)");
  if (fp) {
    for (const k of Object.keys(fp)) {
      console.log(`\n  ${k}:`, JSON.stringify(fp[k]).slice(0, 250));
    }
  }
}
main();
