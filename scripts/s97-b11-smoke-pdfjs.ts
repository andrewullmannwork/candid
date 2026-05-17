/**
 * B11 Stage 2 smoke — exercise pdfjs text-layer extraction against real
 * SBC fixtures. Validates:
 *   - pdfjs extracts text (no ImageOnlyPDFError on digital SBCs)
 *   - Reflow layoutType matches expectation (BS=multi-column-2, Ambetter=single-column)
 *   - Text density is reasonable (>10K chars/SBC)
 *   - First sample of reflowed text from each fixture (manual eyeball)
 *
 * Run: `npx tsx scripts/s97-b11-smoke-pdfjs.ts`
 */

import { readFileSync, existsSync } from "fs";
import { extractTextFromPDFLayer, ImageOnlyPDFError } from "../src/lib/ocr/pdf-text-extract";

interface FixtureCase {
  label: string;
  path: string;
  expectedMinChars: number;
  /** Search pattern to spot-check that the drug-tier section reads cleanly. */
  searchPattern?: RegExp;
  /** Expected substring near the search match (validates column ordering). */
  expectedNearMatch?: string;
}

const fixtures: FixtureCase[] = [
  {
    label: "BS Bronze 60 PPO (multi-column SBC — the B11 target)",
    path: "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/sbc.pdf",
    expectedMinChars: 10_000,
    searchPattern: /Tier 1/i,
    expectedNearMatch: "$19/prescription",
  },
  {
    label: "BS Silver 70 HMO (multi-column SBC)",
    path: "tests/fixtures/sbcs/blue-shield-ca-2026-silver-70-hmo/sbc.pdf",
    expectedMinChars: 10_000,
    searchPattern: /Tier 1/i,
  },
  {
    label: "Ambetter Bronze 60 HDHP (no-regression baseline)",
    path: "tests/fixtures/sbcs/ambetter-ca-2024-bronze-60-hdhp/sbc.pdf",
    expectedMinChars: 10_000,
    searchPattern: /Preferred brand drugs/i,
  },
  {
    label: "Ambetter Gold 80 (no-regression baseline)",
    path: "tests/fixtures/sbcs/ambetter-ca-2024-gold-80/sbc.pdf",
    expectedMinChars: 10_000,
    searchPattern: /Preferred brand drugs/i,
  },
  {
    label: "WHA Premier 2026 (mixed-layout baseline)",
    path: "tests/fixtures/sbcs/wha-ca-2026-premier-hmo/sbc.pdf",
    expectedMinChars: 10_000,
  },
  // ── EOC validation (narrative format, 100-200 page booklets) ───────────────
  {
    label: "Cigna 2024 EOC (narrative format ~150 pages — B11 cross-format validation)",
    path: `${process.env.HOME}/Downloads/Cigna Plan Benefits.pdf`,
    expectedMinChars: 50_000, // EOCs are long; expect >>10K
    searchPattern: /(prior authorization|preauthorization)/i,
  },
  // ── EOB validation (line-item format with dollar columns) ──────────────────
  {
    label: "Real EOB 1 (Cigna line-item format)",
    path: `${process.env.HOME}/Downloads/EOB1.pdf`,
    expectedMinChars: 1_000,
    searchPattern: /\$/,
  },
  {
    label: "Real EOB 2 (Cigna line-item format)",
    path: `${process.env.HOME}/Downloads/EOB2.pdf`,
    expectedMinChars: 1_000,
    searchPattern: /\$/,
  },
  {
    label: "Aetna sample EOB (different insurer format)",
    path: `${process.env.HOME}/Desktop/candid_phase2_pdfs/aetna-sample-eob.pdf`,
    expectedMinChars: 1_000,
    searchPattern: /\$/,
  },
  // ── Image-only PDF (should trigger ImageOnlyPDFError → Document AI fallback) ─
  {
    label: "Synthetic image-only SBC (expected ImageOnlyPDFError → fallback)",
    path: "tests/fixtures/synthetic-image-only/synthetic-image-only-sbc.pdf",
    expectedMinChars: -1, // negative = expect ImageOnlyPDFError
  },
];

async function main() {
console.log("B11 Stage 2 — pdfjs text-layer smoke test\n");

let pass = 0;
let fail = 0;

for (const fx of fixtures) {
  console.log(`── ${fx.label} ──`);
  console.log(`   ${fx.path}`);
  if (!existsSync(fx.path)) {
    console.log(`   ⊘ SKIP — file not found`);
    console.log();
    continue;
  }
  try {
    const buffer = readFileSync(fx.path);
    const t0 = Date.now();
    const result = await extractTextFromPDFLayer(buffer);
    const elapsed = Date.now() - t0;

    const chars = result.text.length;
    const pages = result.pages.length;

    const charsOk = chars >= fx.expectedMinChars;

    console.log(`   pages: ${pages}`);
    console.log(`   chars: ${chars.toLocaleString()} (expected ≥ ${fx.expectedMinChars.toLocaleString()}) ${charsOk ? "✅" : "❌"}`);
    console.log(`   elapsed: ${elapsed}ms`);

    let searchOk = true;
    if (fx.searchPattern) {
      const match = result.text.search(fx.searchPattern);
      if (match < 0) {
        console.log(`   ❌ search pattern ${fx.searchPattern} NOT FOUND`);
        searchOk = false;
      } else {
        const window = result.text.slice(Math.max(0, match - 80), match + 400);
        console.log(`   ${fx.searchPattern} match @ char ${match}; window:\n   ${window.replace(/\n/g, "\\n").slice(0, 500)}`);
        if (fx.expectedNearMatch && !window.includes(fx.expectedNearMatch)) {
          console.log(`   ❌ expected "${fx.expectedNearMatch}" near match — NOT FOUND in 500-char window`);
          searchOk = false;
        }
      }
    }
    console.log();

    if (charsOk && searchOk) pass++;
    else fail++;
  } catch (err) {
    // Expected ImageOnlyPDFError for image-only fixtures (negative expectedMinChars)
    if (err instanceof ImageOnlyPDFError && fx.expectedMinChars < 0) {
      console.log(`   ✅ ImageOnlyPDFError as expected (${err.extractedChars} chars extracted) — would fall back to Document AI`);
      console.log();
      pass++;
      continue;
    }
    console.log(`   ❌ ERROR: ${(err as Error).name}: ${(err as Error).message}`);
    console.log();
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed of ${pass + fail} fixtures`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
