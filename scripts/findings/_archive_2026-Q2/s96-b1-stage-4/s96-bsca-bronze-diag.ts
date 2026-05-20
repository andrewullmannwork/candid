import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DOC = "c8b72849-8ef0-411e-849c-66296422228b";

async function main() {
  const { data: doc } = await sb.from("documents").select("linked_insurance_plan_id, processing_ocr_text").eq("id", DOC).single();
  const planId = doc!.linked_insurance_plan_id;
  const ocr = doc!.processing_ocr_text ?? "";

  // 1. Services extracted
  const { data: services } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service, in_copay, in_coinsurance, in_cost_description, out_copay, out_coinsurance, out_cost_description, field_provenance, covered")
    .eq("insurance_plan_id", planId);
  const ids = (services ?? []).map((s:any) => s.service_id).filter(Boolean);
  const { data: catalog } = await sb.from("service_catalog").select("id, slug").in("id", ids);
  const slugMap = new Map((catalog ?? []).map((c:any) => [c.id, c.slug]));

  console.log(`Total plan_covered_services rows: ${services?.length}`);
  console.log(`\nSlug+POS list:`);
  (services ?? []).sort((a:any,b:any) => (slugMap.get(a.service_id) ?? "").localeCompare(slugMap.get(b.service_id) ?? "")).forEach((s:any) => {
    const slug = slugMap.get(s.service_id) ?? "?";
    const hasCost = s.in_copay != null || s.in_coinsurance != null || s.in_cost_description || s.out_copay != null || s.out_coinsurance != null || s.out_cost_description;
    console.log(`  ${slug}::${s.place_of_service ?? "?"}  covered=${s.covered} hasCost=${hasCost}`);
  });

  // 2. Admin review queue — did parser emit proposed_* slugs?
  const { data: queue } = await sb
    .from("service_catalog_admin_review_queue")
    .select("proposed_slug, sample_doc_id, sample_excerpt, first_seen_at, distinct_docs, distinct_users")
    .order("first_seen_at", { ascending: false })
    .limit(20);
  console.log(`\nservice_catalog_admin_review_queue (top 20 most recent):`);
  console.log(`Total rows: ${queue?.length ?? 0}`);
  queue?.forEach((q:any) => {
    console.log(`  ${q.proposed_slug}  docs=${q.distinct_docs} users=${q.distinct_users} excerpt="${(q.sample_excerpt ?? "").slice(0,80)}"`);
  });

  // 3. OCR length + spot check for service-name keywords
  console.log(`\nOCR length: ${ocr.length}`);
  const ocrLower = ocr.toLowerCase();
  const checks = [
    "physical therapy", "occupational therapy", "speech therapy", "rehabilitation",
    "outpatient surgery", "inpatient", "specialist", "primary care",
    "mental health", "substance", "maternity", "delivery", "prenatal",
    "imaging", "x-ray", "ct scan", "mri",
    "lab", "blood work",
    "preventive", "well baby", "well child", "immunization", "vaccine",
    "durable medical", "hearing aid",
    "vision", "dental", "acupuncture", "chiropractic",
    "skilled nursing", "home health", "hospice", "long-term",
    "emergency", "urgent care", "ambulance",
    "prescription", "generic", "brand", "specialty",
  ];
  console.log(`\nKeyword presence in OCR (Blue Shield Bronze 60 PPO):`);
  checks.forEach(k => {
    const present = ocrLower.includes(k);
    console.log(`  ${present ? "✓" : "✗"} "${k}"`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
