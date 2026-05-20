import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DOC = "c8b72849-8ef0-411e-849c-66296422228b";

async function main() {
  const { count } = await sb
    .from("canonical_haiku_extractions")
    .select("*", { count: "exact", head: true })
    .eq("document_id", DOC);
  console.log(`canonical_haiku_extractions total: ${count}`);

  const { count: serviceRows } = await sb
    .from("canonical_haiku_extractions")
    .select("*", { count: "exact", head: true })
    .eq("document_id", DOC)
    .eq("field_name", "services_cost_sharing_row");
  console.log(`  services_cost_sharing_row rows: ${serviceRows}`);

  const { data: serviceData } = await sb
    .from("canonical_haiku_extractions")
    .select("extracted_value, source_excerpt_verified, source_excerpt")
    .eq("document_id", DOC)
    .eq("field_name", "services_cost_sharing_row")
    .order("created_at", { ascending: true });

  console.log(`\nAll services_cost_sharing_row entries from Haiku:`);
  serviceData?.forEach((s: any, i: number) => {
    const val = s.extracted_value;
    const slug = typeof val === "object" && val !== null ? val.service_slug ?? val.slug ?? "(no-slug)" : String(val).slice(0, 60);
    const pos = typeof val === "object" && val !== null ? val.place_of_service ?? "?" : "?";
    console.log(`  [${i+1}] slug=${slug}::${pos} verified=${s.source_excerpt_verified}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
