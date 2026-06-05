import { config } from "dotenv";
import { resolve } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

async function main() {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug,name,category,description")
    .order("category")
    .order("slug");

  if (error) throw new Error(`service_catalog: ${error.message}`);
  console.log(`Fetched ${data?.length} catalog entries`);

  const outPath = "/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/thesaurus-baseline-2026-06-03/catalog.json";
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
