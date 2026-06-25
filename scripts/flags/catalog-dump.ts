/**
 * Live service_catalog dump — the canonical slug palette (non-deprecated) for A2b rulings.
 * Usage:  cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/flags/catalog-dump.ts
 * Read-only. Excludes deprecated/merged slugs so the options sheet shows only live targets.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug, name, category, is_preventive_eligible, deprecated_at, merged_into_id")
    .is("merged_into_id", null)
    .is("deprecated_at", null)
    .order("category")
    .order("slug");
  if (error) { console.log("ERR:", error); process.exit(1); }
  const rows = data ?? [];
  console.log(`LIVE service_catalog (non-deprecated): ${rows.length} slugs`);
  let cat = "";
  for (const r of rows) {
    if (r.category !== cat) { cat = r.category; console.log(`\n[${cat}]`); }
    const prev = r.is_preventive_eligible ? "  *preventive-eligible*" : "";
    console.log(`  ${r.slug} — ${r.name}${prev}`);
  }
}
main();
