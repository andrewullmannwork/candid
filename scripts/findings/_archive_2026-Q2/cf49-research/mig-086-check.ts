import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Check if v4 tables from mig 086 exist in PROD
  const v4Tables = ["canonical_doctype_promotion_state", "canonical_invalidation_events", "canonical_field_corroboration", "canonical_correction_challenges"];
  for (const t of v4Tables) {
    const { count, error } = await supabase.from(t).select("*", { count: "exact", head: true });
    console.log(`  ${t}: ${count !== null ? `${count} rows ✅ exists` : `ERR (${error?.message ?? "missing"})`}`);
  }
}
main();
