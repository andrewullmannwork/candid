import { normalizeWhitespace, findBridgedMatch } from "../src/lib/parser/verify-source-excerpts";
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const GOLD_DOC = "12e15bda-bc00-4879-889c-c3cb909948d4";

const T = (label: string, pass: boolean, details = "") => {
  console.log(`${pass ? "✅" : "❌"} ${label}${details ? "  → " + details : ""}`);
};

async function main() {
  // === Synthetic regression cases ===

  // Case 1: identical text — should match trivially via byte-exact, but bridge should ALSO succeed.
  const ocr1 = normalizeWhitespace("Hello world this is a simple sentence.");
  const ex1 = normalizeWhitespace("Hello world this is a simple sentence.");
  const r1 = findBridgedMatch(ex1, ocr1);
  T("bridge handles identical text", r1 !== null && r1.coverage >= 0.99);

  // Case 2: column-interleaving (the actual Gold 80 pattern) — should bridge.
  const ocr2 = normalizeWhitespace(
    "For out-of-network providers $25,000 per member/$50,000 per family per calendar " +
    "are there other deductibles for specific services? what is the out-of-pocket limit for this plan? year. " +
    "More text after.",
  );
  const ex2 = normalizeWhitespace(
    "For out-of-network providers $25,000 per member/$50,000 per family per calendar year.",
  );
  const r2 = findBridgedMatch(ex2, ocr2);
  T("bridge handles Gold 80 column-interleaving", r2 !== null, `coverage=${r2?.coverage?.toFixed(2)}`);

  // Case 3: completely different text — must NOT bridge (false-positive guard).
  const ocr3 = normalizeWhitespace("The quick brown fox jumps over the lazy dog.");
  const ex3 = normalizeWhitespace("For out-of-network providers $25,000 per member.");
  const r3 = findBridgedMatch(ex3, ocr3);
  T("bridge rejects unrelated text", r3 === null);

  // Case 4: partial overlap — some words match but not in order, must NOT bridge.
  const ocr4 = normalizeWhitespace("calendar year per family $50,000 member $25,000 providers out-of-network for.");
  const ex4 = normalizeWhitespace("For out-of-network providers $25,000 per member/$50,000 per family per calendar year.");
  const r4 = findBridgedMatch(ex4, ocr4);
  T("bridge rejects reversed-order text", r4 === null);

  // Case 5: scattered word salad in different order — must NOT bridge.
  const ocr5 = normalizeWhitespace("for providers per $25,000 family member out-of-network $50,000 year calendar.");
  const ex5 = normalizeWhitespace("For out-of-network providers $25,000 per member/$50,000 per family per calendar year.");
  const r5 = findBridgedMatch(ex5, ocr5);
  T("bridge rejects scattered word salad", r5 === null);

  // Case 6: 5 consecutive words from a 5-word excerpt — should match.
  const ocr6 = normalizeWhitespace("alpha beta gamma delta epsilon zeta eta theta.");
  const ex6 = normalizeWhitespace("alpha beta gamma delta epsilon");
  const r6 = findBridgedMatch(ex6, ocr6);
  T("bridge handles exact 5-word excerpt", r6 !== null);

  // Case 7: < 5 words — bridge returns null (too short).
  const ocr7 = normalizeWhitespace("alpha beta gamma delta epsilon zeta eta theta.");
  const ex7 = normalizeWhitespace("alpha beta gamma");
  const r7 = findBridgedMatch(ex7, ocr7);
  T("bridge rejects excerpt shorter than nGramSize (correct: Tier 1.a/b handles short)", r7 === null);

  // === REAL CASE: Gold 80 OON OOP-max ===
  const { data: doc } = await sb.from("documents").select("processing_ocr_text, linked_insurance_plan_id").eq("id", GOLD_DOC).single();
  const ocr = doc!.processing_ocr_text ?? "";
  const ocrNorm = normalizeWhitespace(ocr);
  const { data: gp } = await sb.from("insurance_plans").select("field_provenance").eq("id", doc!.linked_insurance_plan_id).single();
  const fp = (gp as any)?.field_provenance ?? {};
  for (const k of ["out_oop_max_individual", "out_oop_max_family"]) {
    const m = fp[k];
    if (!m) { console.log(`  (skip ${k}, no provenance)`); continue; }
    const excerpt = m.source_excerpt as string;
    const exNorm = normalizeWhitespace(excerpt);
    const tier1a = ocr.includes(excerpt);
    const tier1b = ocrNorm.includes(exNorm);
    const tier1c = findBridgedMatch(exNorm, ocrNorm);
    console.log(`\n${k}:`);
    console.log(`  excerpt: "${excerpt.slice(0,100)}..."`);
    console.log(`  tier1a (byte-exact): ${tier1a}`);
    console.log(`  tier1b (norm-whitespace): ${tier1b}`);
    console.log(`  tier1c (bridge): ${tier1c !== null ? `MATCHED coverage=${tier1c.coverage.toFixed(2)}` : "no match"}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
