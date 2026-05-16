import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const GOLD_DOC = "12d70822-e6b8-4095-8f3c-58183fd45b49";
const SILVER_DOC = "50272090-4fd2-4525-a837-d585cbd4c866";

async function getSlugs(docId: string): Promise<Set<string>> {
  const { data: doc } = await sb.from("documents").select("linked_insurance_plan_id").eq("id", docId).single();
  const { data: services } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service")
    .eq("insurance_plan_id", doc!.linked_insurance_plan_id);
  const ids = (services ?? []).map((s:any) => s.service_id).filter(Boolean);
  const { data: catalog } = await sb.from("service_catalog").select("id, slug").in("id", ids);
  const slugById = new Map((catalog ?? []).map((c:any) => [c.id, c.slug]));
  return new Set((services ?? []).map((s:any) => `${slugById.get(s.service_id) ?? "?"}::${s.place_of_service ?? "?"}`));
}

async function main() {
  const gold = await getSlugs(GOLD_DOC);
  const silver = await getSlugs(SILVER_DOC);
  console.log(`Gold 80:   ${gold.size} services`);
  console.log(`Silver 87: ${silver.size} services`);

  const inSilverNotGold = [...silver].filter(s => !gold.has(s)).sort();
  const inGoldNotSilver = [...gold].filter(s => !silver.has(s)).sort();
  console.log(`\nIn Silver but not Gold (${inSilverNotGold.length}): ${inSilverNotGold.join(", ")}`);
  console.log(`In Gold but not Silver (${inGoldNotSilver.length}): ${inGoldNotSilver.join(", ")}`);

  // Also: check Gold 80 plan-identity excerpts for out_oop_max fields
  const { data: gold_plan } = await sb
    .from("insurance_plans")
    .select("id, field_provenance, out_oop_max_individual, out_oop_max_family, document_id")
    .like("document_id", `${GOLD_DOC}%`)
    .limit(1);
  // Try by plan id instead
  const { data: gold_doc } = await sb.from("documents").select("linked_insurance_plan_id, processing_ocr_text").eq("id", GOLD_DOC).single();
  const { data: gp } = await sb.from("insurance_plans").select("id, field_provenance, out_oop_max_individual, out_oop_max_family").eq("id", gold_doc!.linked_insurance_plan_id).single();
  const fp = (gp as any)?.field_provenance ?? {};
  console.log(`\n=== Gold 80 OON OOP-max field_provenance ===`);
  for (const k of ["out_oop_max_individual", "out_oop_max_family"]) {
    const m = fp[k];
    console.log(`  ${k}: status=${m?.source_excerpt_verified} section=${m?.source_section_verified} hint=${m?.source_section_hint}`);
    console.log(`    excerpt: "${(m?.source_excerpt ?? "").slice(0,140)}"`);
    const ocr = (gold_doc!.processing_ocr_text ?? "");
    const norm = (s: string) => s.replace(/(\w)-\s+(\w)/g, "$1-$2").replace(/\s+/g, " ").trim().toLowerCase();
    const inOcr = m?.source_excerpt ? norm(ocr).includes(norm(m.source_excerpt)) : false;
    console.log(`    OCR-contains-normalized: ${inOcr}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
