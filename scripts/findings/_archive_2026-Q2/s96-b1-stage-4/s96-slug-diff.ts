import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const BEFORE_DOC = "a4b4cc2d-ab43-49cd-8c9b-e8afa3c04ec6";  // 23 services
const AFTER_DOC = "973e9754-01ae-4a36-a3c7-f93f410d5f99";   // 19 services

async function slugsFor(docId: string): Promise<Set<string>> {
  const { data: doc } = await sb.from("documents").select("linked_insurance_plan_id").eq("id", docId).single();
  const { data: services } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service")
    .eq("insurance_plan_id", doc!.linked_insurance_plan_id);
  const ids = (services ?? []).map((s: any) => s.service_id).filter(Boolean);
  const { data: catalog } = await sb.from("service_catalog").select("id, slug").in("id", ids);
  const slugMap = new Map((catalog ?? []).map((c: any) => [c.id, c.slug]));
  return new Set((services ?? []).map((s: any) => `${slugMap.get(s.service_id) ?? "?"}::${s.place_of_service ?? "?"}`));
}

async function main() {
  const before = await slugsFor(BEFORE_DOC);
  const after = await slugsFor(AFTER_DOC);
  console.log(`Before (23 svc):   ${before.size} entries`);
  console.log(`After  (19 svc):   ${after.size} entries`);
  const lost = [...before].filter(s => !after.has(s)).sort();
  const gained = [...after].filter(s => !before.has(s)).sort();
  console.log(`\nLost on new prompt (${lost.length}): ${lost.join(", ")}`);
  console.log(`\nGained on new prompt (${gained.length}): ${gained.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
