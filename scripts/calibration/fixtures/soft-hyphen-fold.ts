/**
 * Soft-hyphen (U+00AD) fold fixture for `verify-source-excerpts.ts:normalizeWhitespace`.
 *
 * Block Ship Gate G4 — manually-runnable fixture (no CI wiring yet; follow-up
 * obligation per Gate 4 spec).
 *
 * Origin: S137 backend calibration carry. 8 Ambetter tool-use unverifiable
 * excerpts contained U+00AD soft-hyphen between syllables of "out-of-network"
 * that PROD `verify-source-excerpts.ts:74` was missing (folded U+2010-U+2015 +
 * U+2212 but NOT U+00AD). Backend S145+ adds U+00AD to the hyphen fold class.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/soft-hyphen-fold.ts
 *
 * Pass criteria: 5/5 cases assert PASS. Exit code 0 on PASS, 1 on any failure.
 */

import { normalizeWhitespace } from "../../../src/lib/parser/verify-source-excerpts";

interface Case {
  name: string;
  input: string;
  expected: string;
}

const SHY = "­"; // soft hyphen
const HYPHEN = "‐"; // hyphen
const NON_BREAKING_HYPHEN = "‑"; // non-breaking hyphen
const FIGURE_DASH = "‒"; // figure dash
const EN_DASH = "–"; // en dash
const EM_DASH = "—"; // em dash
const HORIZONTAL_BAR = "―"; // horizontal bar
const MINUS_SIGN = "−"; // minus sign

const cases: Case[] = [
  {
    name: "U+00AD between word characters folds to ASCII hyphen (S137 carry)",
    input: `out${SHY}of${SHY}network`,
    expected: "out-of-network",
  },
  {
    name: "U+00AD at word-end + word-start (line-wrap soft-hyphen pattern)",
    input: `cardio${SHY} vascular`,
    // Expected behavior: U+00AD → "-", then run becomes "cardio- vascular";
    // then de-hyphenate line-wrap `(\w)-\s+(\w)` collapses to "cardio-vascular".
    expected: "cardio-vascular",
  },
  {
    name: "Existing hyphen variants (U+2010-U+2015 + U+2212) still fold — regression check",
    input: `a${HYPHEN}b${NON_BREAKING_HYPHEN}c${FIGURE_DASH}d${EN_DASH}e${EM_DASH}f${HORIZONTAL_BAR}g${MINUS_SIGN}h`,
    expected: "a-b-c-d-e-f-g-h",
  },
  {
    name: "S137 exact Ambetter case (multi-codepoint mix of U+00AD + ASCII context)",
    // PDF embedded soft-hyphens for line-break hints between "of" and "network"
    // syllables. Haiku verbatim excerpt has "out-of-network" with ASCII hyphens.
    input: `coverage for out${SHY}of${SHY}network providers`,
    expected: "coverage for out-of-network providers",
  },
  {
    name: "Full normalize-and-match: source with U+00AD matches Haiku ASCII output",
    // Simulates the actual verify flow: both source + Haiku excerpt are passed
    // through normalizeWhitespace; equality check must succeed.
    input: `Please review out${SHY}of${SHY}network benefits.`,
    expected: "Please review out-of-network benefits.",
  },
];

let passed = 0;
let failed = 0;

console.log("Soft-hyphen fold fixture (S137 carry; G4 ship-gate evidence)");
console.log("─".repeat(64));

for (const c of cases) {
  const actual = normalizeWhitespace(c.input);
  const ok = actual === c.expected;
  if (ok) {
    passed++;
    console.log(`✓ ${c.name}`);
  } else {
    failed++;
    console.log(`✗ ${c.name}`);
    console.log(`  input    : ${JSON.stringify(c.input)}`);
    console.log(`  expected : ${JSON.stringify(c.expected)}`);
    console.log(`  actual   : ${JSON.stringify(actual)}`);
  }
}

console.log("─".repeat(64));
console.log(`PASS ${passed}/${cases.length}  FAIL ${failed}/${cases.length}`);

// Also confirm equality across normalize: source (with U+00AD) should match
// Haiku-style output (ASCII) after normalize on both sides. This is the
// downstream invariant the verifier actually depends on.
const sourceText = `out${SHY}of${SHY}network`;
const haikuText = "out-of-network";
const sourceNorm = normalizeWhitespace(sourceText);
const haikuNorm = normalizeWhitespace(haikuText);
const verifierInvariantOK = sourceNorm === haikuNorm;
if (verifierInvariantOK) {
  console.log(`✓ verifier invariant: normalize(source-with-U+00AD) === normalize(haiku-ASCII)`);
} else {
  failed++;
  console.log(`✗ verifier invariant: source-norm=${JSON.stringify(sourceNorm)} haiku-norm=${JSON.stringify(haikuNorm)}`);
}

process.exit(failed === 0 ? 0 : 1);
