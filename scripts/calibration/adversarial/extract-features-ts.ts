// Ing-G.2/3 — re-extract the corpus feature vectors with the PRODUCTION TS
// extractor (`src/lib/parser/adversarial-pdf-features.ts`), so the calibration
// set and production use byte-identical extraction (no poppler-vs-pdf-lib seam).
//
//   Output: manifest-ts.json  — COMMITTED CI fixture (non-PII feature vectors).
//   The poppler manifest.json stays as a build-provenance SANITY ORACLE only.
//
// Raw PDFs are local-only (gitignored). Point the reader at them via env when
// running from a worktree that doesn't co-locate them:
//
//   ADVERSARIAL_RAW_DIR=/Users/.../candid/scripts/calibration/adversarial \
//     npx tsx scripts/calibration/adversarial/extract-features-ts.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractAdversarialPdfFeatures } from "@/lib/parser/adversarial-pdf-features";

const OUT_DIR = join(process.cwd(), "scripts/calibration/adversarial");
const RAW_DIR = process.env.ADVERSARIAL_RAW_DIR || OUT_DIR;
const STRATA_DIR: Record<string, string> = {
  real: "_real_pdfs",
  synthetic: "_synthetic_pdfs",
  modified_real: "_modified_real",
};
// label/provenance fields carried over from the poppler manifest (not re-derivable from the PDF)
const CARRY = [
  "stratum", "axis_a_content", "axis_b_renderer", "fidelity", "variant",
  "insurer", "state", "year", "plan_type", "provenance", "producer_expected",
];

type Row = Record<string, unknown>;

async function main() {
const poppler: Row[] = JSON.parse(readFileSync(join(OUT_DIR, "manifest.json"), "utf8"));

const out: Row[] = [];
let structFails = 0, textFails = 0;
const numericMismatch: Record<string, number> = {};
const boolDisagree: Record<string, { id: string; stratum: string; pop: unknown; ts: unknown }[]> = {};

for (const e of poppler) {
  const stratum = e.stratum as string;
  const id = e.id as string;
  const path = join(RAW_DIR, STRATA_DIR[stratum], `${id}.pdf`);
  let feats;
  try {
    feats = await extractAdversarialPdfFeatures(readFileSync(path));
  } catch (err) {
    console.log(`READ-FAIL ${stratum}/${id}: ${(err as Error).message}`);
    continue;
  }
  if (!feats.structure_ok) structFails++;
  if (!feats.text_ok) textFails++;

  const entry: Row = { id };
  for (const k of CARRY) if (k in e) entry[k] = e[k];
  Object.assign(entry, feats);
  out.push(entry);

  // sanity cross-check vs poppler: gross numeric drift (|diff|>2) + any boolean disagreement
  for (const k of ["pages", "n_fonts", "n_subset", "n_images"]) {
    const p = e[k], t = (feats as unknown as Record<string, unknown>)[k];
    if (typeof p === "number" && typeof t === "number" && Math.abs(p - t) > 2)
      numericMismatch[k] = (numericMismatch[k] || 0) + 1;
  }
  for (const k of ["sbc_header", "has_why_this_matters", "has_important_questions", "omb_present"]) {
    const p = e[k], t = (feats as unknown as Record<string, unknown>)[k];
    if (p !== undefined && p !== t) {
      (boolDisagree[k] ||= []).push({ id, stratum, pop: p, ts: t });
    }
  }
}

writeFileSync(join(OUT_DIR, "manifest-ts.json"), JSON.stringify(out, null, 2));

console.log(`\nwrote manifest-ts.json: ${out.length}/${poppler.length} docs`);
console.log(`extraction status: structure_ok fail=${structFails}, text_ok fail=${textFails}`);
console.log(`\nSANITY vs poppler — gross numeric drift (|diff|>2):`, numericMismatch);
console.log(`SANITY vs poppler — boolean marker disagreements:`);
for (const k of ["sbc_header", "has_why_this_matters", "has_important_questions", "omb_present"]) {
  const ds = boolDisagree[k] || [];
  console.log(`  ${k}: ${ds.length} disagree` + (ds.length ? ` → ${ds.slice(0, 6).map(d => `${d.stratum}/${String(d.id).slice(0, 14)}(pop=${d.pop},ts=${d.ts})`).join(", ")}` : ""));
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
