import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DOC = "12e15bda-bc00-4879-889c-c3cb909948d4";

function norm(s: string): string {
  return s
    .replace(/(\w)-\s+(\w)/g, "$1-$2")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function main() {
  const { data: doc } = await sb.from("documents").select("processing_ocr_text").eq("id", DOC).single();
  const ocr: string = doc!.processing_ocr_text ?? "";
  const ocrNorm = norm(ocr);
  const probe = '"For out-of-network providers $25,000 per member/$50,000 per family per calendar year."';
  const probeNorm = norm(probe);
  console.log("Haiku excerpt:");
  console.log(`  raw:  ${probe}`);
  console.log(`  norm: ${probeNorm}`);
  console.log(`  found in normalized OCR: ${ocrNorm.includes(probeNorm)}`);

  // Find what's actually in the OCR around "25,000" + "out-of-network"
  const idx = ocrNorm.indexOf("$25,000");
  console.log(`\nFirst occurrence of "$25,000" in normalized OCR: ${idx}`);
  if (idx >= 0) {
    console.log(`Context (200 chars around): "${ocrNorm.slice(Math.max(0,idx-100), idx+200)}"`);
  }
  // Try without leading quote
  const without = 'For out-of-network providers $25,000 per member/$50,000 per family per calendar year.';
  const inOcr = ocrNorm.includes(norm(without));
  console.log(`\nExcerpt without leading/trailing quotes found: ${inOcr}`);

  // Try fragments
  const frags = [
    "for out-of-network providers",
    "25,000 per member",
    "$25,000 per member/$50,000",
    "$50,000 per family",
    "out-of-network providers $25,000",
  ];
  console.log(`\nFragment matches:`);
  for (const f of frags) {
    console.log(`  "${f}" → ${ocrNorm.includes(norm(f))}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
