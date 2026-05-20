import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const AMBETTER_GOLD = "df5b9484-ef05-43c4-8aec-f6ac4101c198";
const BS_BRONZE = "c8b72849-8ef0-411e-849c-66296422228b";
const BS_HMO = "a4b4cc2d-ab43-49cd-8c9b-e8afa3c04ec6";

async function fetch(id: string, label: string) {
  const { data } = await sb.from("documents").select("processing_ocr_text, processing_total_pages").eq("id", id).single();
  const ocr = data?.processing_ocr_text ?? "";
  return { label, ocrLen: ocr.length, pages: data?.processing_total_pages, ocr };
}

function findSection(ocr: string, header: string): { start: number; end: number; snippet: string } | null {
  const lower = ocr.toLowerCase();
  const idx = lower.indexOf(header.toLowerCase());
  if (idx < 0) return null;
  return { start: idx, end: idx + 600, snippet: ocr.slice(idx, idx + 600).replace(/\s+/g, " ").slice(0, 500) };
}

async function main() {
  const docs = [await fetch(AMBETTER_GOLD, "Ambetter Gold 80 (37 svc)"), await fetch(BS_BRONZE, "BS Bronze 60 PPO (23-24 svc)"), await fetch(BS_HMO, "BS Silver 70 HMO (23 svc)")];
  console.log(`=== OCR sizes ===`);
  docs.forEach(d => console.log(`  ${d.label}: ${d.ocrLen} chars, ${d.pages} pages`));

  const sectionHeaders = [
    "Common Medical Event",
    "If you visit a health care provider",
    "If you have a test",
    "If you need drugs",
    "If you need mental health",
    "If you need behavioral health",
    "If you have outpatient surgery",
    "If you need immediate medical attention",
    "If you have a hospital stay",
    "If you are pregnant",
    "If you have outpatient services",
    "If your child needs",
    "Excluded Services",
  ];

  for (const header of sectionHeaders) {
    console.log(`\n--- "${header}" ---`);
    docs.forEach(d => {
      const r = findSection(d.ocr, header);
      console.log(`  ${d.label}:`);
      if (r) console.log(`    @${r.start}: "${r.snippet.slice(0, 250)}"`);
      else console.log(`    NOT FOUND`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
