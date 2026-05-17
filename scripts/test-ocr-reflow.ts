/**
 * Unit tests for OCR reflow primitive (B11 Stage 1b).
 * Run: `npx tsx scripts/test-ocr-reflow.ts`
 * Exit 0 on all-pass; 1 on any failure.
 *
 * Coverage:
 *   - Empty page + single-block edge cases
 *   - Single-column layouts (no regression on Ambetter-style)
 *   - 2-column and 3-column layouts (BS-style reflow)
 *   - Spanning blocks (top header / bottom footer / middle divider)
 *   - Ambiguous block scatter → safe fallback to y-order
 *   - Realistic BS-style column-interleaved input
 *   - Document-level multi-page reflow
 */

import {
  reflowPageBlocks,
  reflowDocument,
  type TextBlock,
} from "../src/lib/ocr/reflow";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     expected: ${e}`);
    console.log(`     actual:   ${a}`);
    failures.push(label);
    fail++;
  }
}

function block(text: string, top: number, left: number, width: number, height = 0.02): TextBlock {
  return { text, top, left, width, height };
}

console.log("OCR Reflow — unit tests\n");

// ── T1: empty page ───────────────────────────────────────────────────────────
{
  const result = reflowPageBlocks(1, []);
  expect("T1 empty page → empty text + layoutType=empty", { text: result.text, lt: result.layoutType }, { text: "", lt: "empty" });
}

// ── T2: single block ─────────────────────────────────────────────────────────
{
  const result = reflowPageBlocks(1, [block("Hello world", 0.1, 0.1, 0.8)]);
  expect("T2 single block → text emitted as-is + single-column", { text: result.text, lt: result.layoutType }, { text: "Hello world", lt: "single-column" });
}

// ── T3: single-column layout (3 blocks same x) preserves y-order ─────────────
{
  // Note: blocks are wide → treated as spanning (width >= 0.55). Spanning
  // blocks all in top strata are emitted as top-spanning headers in y-order.
  // Either way the y-order is preserved.
  const result = reflowPageBlocks(1, [
    block("Line C", 0.30, 0.10, 0.80),
    block("Line A", 0.10, 0.10, 0.80),
    block("Line B", 0.20, 0.10, 0.80),
  ]);
  expect("T3 single-column 3 blocks → emitted in y-order", result.text, "Line A\nLine B\nLine C");
  expect("T3 single-column 3 blocks → layoutType single-column", result.layoutType, "single-column");
}

// ── T4: classic 2-column SBC layout ──────────────────────────────────────────
{
  // Column 1 (left): x ~ 0.10, width 0.35
  // Column 2 (right): x ~ 0.55, width 0.35
  // Blocks in horizontal-stripe (OCR-emitted) order:
  const result = reflowPageBlocks(1, [
    block("L1 row1 left", 0.10, 0.10, 0.35),
    block("R1 row1 right", 0.10, 0.55, 0.35),
    block("L2 row2 left", 0.20, 0.10, 0.35),
    block("R2 row2 right", 0.20, 0.55, 0.35),
    block("L3 row3 left", 0.30, 0.10, 0.35),
    block("R3 row3 right", 0.30, 0.55, 0.35),
  ]);
  expect(
    "T4 2-column 6 blocks → reflowed col-1 then col-2",
    result.text,
    "L1 row1 left\nL2 row2 left\nL3 row3 left\nR1 row1 right\nR2 row2 right\nR3 row3 right",
  );
  expect("T4 2-column → layoutType multi-column-2", result.layoutType, "multi-column-2");
  expect("T4 2-column → columnCount 2", result.columnCount, 2);
}

// ── T5: 3-column layout ──────────────────────────────────────────────────────
{
  const result = reflowPageBlocks(1, [
    block("C1A", 0.10, 0.05, 0.25),
    block("C2A", 0.10, 0.38, 0.25),
    block("C3A", 0.10, 0.70, 0.25),
    block("C1B", 0.30, 0.05, 0.25),
    block("C2B", 0.30, 0.38, 0.25),
    block("C3B", 0.30, 0.70, 0.25),
  ]);
  expect(
    "T5 3-column 6 blocks → reflowed col-1 then col-2 then col-3",
    result.text,
    "C1A\nC1B\nC2A\nC2B\nC3A\nC3B",
  );
  expect("T5 3-column → layoutType multi-column-3", result.layoutType, "multi-column-3");
}

// ── T6: top-spanning header in 2-column page ─────────────────────────────────
{
  const result = reflowPageBlocks(1, [
    block("PAGE HEADER", 0.05, 0.05, 0.90), // spanning, top strata
    block("L1", 0.20, 0.10, 0.35),
    block("R1", 0.20, 0.55, 0.35),
    block("L2", 0.30, 0.10, 0.35),
    block("R2", 0.30, 0.55, 0.35),
  ]);
  expect(
    "T6 top spanning header → emitted first then col-1 then col-2",
    result.text,
    "PAGE HEADER\nL1\nL2\nR1\nR2",
  );
}

// ── T7: bottom-spanning footer in 2-column page ──────────────────────────────
{
  const result = reflowPageBlocks(1, [
    block("L1", 0.20, 0.10, 0.35),
    block("R1", 0.20, 0.55, 0.35),
    block("L2", 0.30, 0.10, 0.35),
    block("R2", 0.30, 0.55, 0.35),
    block("Page 1 of 8", 0.95, 0.45, 0.20), // spanning by virtue of being centered + small
  ]);
  // Note: "Page 1 of 8" has width 0.20 (< FULL_WIDTH_THRESHOLD 0.55), so it's
  // NOT classified as spanning. It'll fall into column-2 by x-clustering.
  // Verify the reflow handles it sensibly: emits in column-2's stream.
  expect(
    "T7 narrow bottom block → clustered into nearest column (col-2)",
    result.text,
    "L1\nL2\nR1\nR2\nPage 1 of 8",
  );
}

// ── T8: middle-spanning divider interleaved into col-1 by y-position ─────────
{
  const result = reflowPageBlocks(1, [
    block("L1", 0.10, 0.10, 0.35),
    block("R1", 0.10, 0.55, 0.35),
    block("--- SECTION DIVIDER ---", 0.50, 0.05, 0.90), // middle-spanning
    block("L2", 0.70, 0.10, 0.35),
    block("R2", 0.70, 0.55, 0.35),
  ]);
  // Divider is page-spanning + middle strata → interleaves into col-1 at y=0.50
  // Order: L1 (y=0.10), DIVIDER (y=0.50), L2 (y=0.70), then R1 (y=0.10), R2 (y=0.70)
  expect(
    "T8 middle spanning divider → interleaves into col-1 stream by y-position",
    result.text,
    "L1\n--- SECTION DIVIDER ---\nL2\nR1\nR2",
  );
}

// ── T9: BS-style column-interleaved drug coverage section ────────────────────
{
  // Simulates what BS Silver 70 HMO produces in OCR:
  //   Narrow left column with "Tier 1", "Tier 2", "Tier 3" labels (x ~ 0.05, width 0.15)
  //   Wide right column with explanatory drug coverage text (x ~ 0.30, width 0.60)
  // Document AI emits horizontal-stripe order: Tier 1 → text → Tier 2 → text → Tier 3.
  // Reflow should separate cleanly: left column first, then right column.
  const result = reflowPageBlocks(1, [
    block("Tier 1", 0.10, 0.05, 0.15),
    block("If you need drugs to treat your", 0.10, 0.30, 0.60),
    block("Tier 2", 0.20, 0.05, 0.15),
    block("illness or condition. More info", 0.20, 0.30, 0.60),
    block("Tier 3", 0.30, 0.05, 0.15),
    block("at blueshieldca.com/formulary.", 0.30, 0.30, 0.60),
  ]);
  expect(
    "T9 BS-style column-interleaved → tiers grouped, text grouped",
    result.text,
    "Tier 1\nTier 2\nTier 3\nIf you need drugs to treat your\nillness or condition. More info\nat blueshieldca.com/formulary.",
  );
  expect("T9 BS-style → layoutType multi-column-2", result.layoutType, "multi-column-2");
}

// ── T10: Ambetter-style single-column (no regression) ────────────────────────
{
  // Ambetter SBCs render cleanly with mostly full-width rows that have inline
  // values. Each row is one wide block. Should not reflow (single-column path).
  const result = reflowPageBlocks(1, [
    block("Preferred brand drugs (Tier 2)", 0.10, 0.05, 0.85),
    block("$60 copay/retail order", 0.15, 0.05, 0.85),
    block("$120 copay/mail order", 0.20, 0.05, 0.85),
    block("Not covered", 0.25, 0.05, 0.85),
  ]);
  expect(
    "T10 Ambetter-style wide rows → emitted in y-order, no reflow",
    result.text,
    "Preferred brand drugs (Tier 2)\n$60 copay/retail order\n$120 copay/mail order\nNot covered",
  );
  expect("T10 Ambetter-style → layoutType single-column", result.layoutType, "single-column");
}

// ── T11: scattered blocks fall back to single-column safely ──────────────────
{
  // No clear column structure — random positions. Should fall back to y-order
  // (single-column path; no spurious reflow).
  const result = reflowPageBlocks(1, [
    block("alpha", 0.10, 0.30, 0.20),
    block("bravo", 0.20, 0.10, 0.20),
    block("charlie", 0.30, 0.50, 0.20),
    block("delta", 0.40, 0.20, 0.20),
  ]);
  // With only 4 blocks scattered, MIN_PEAK_DENSITY (0.08 → minPeakCount=max(2, 0))
  // pegs minPeakCount at 2. None of these buckets has 2 blocks → 0 anchors → single-column.
  expect(
    "T11 scattered blocks → fallback to y-order (single-column)",
    result.text,
    "alpha\nbravo\ncharlie\ndelta",
  );
  expect("T11 scattered → layoutType single-column", result.layoutType, "single-column");
}

// ── T12: document-level multi-page reflow ────────────────────────────────────
{
  const result = reflowDocument([
    {
      pageNumber: 1,
      blocks: [
        block("Page 1 line", 0.10, 0.10, 0.80), // single-column page
      ],
    },
    {
      pageNumber: 2,
      blocks: [
        // 2-column page
        block("p2 L1", 0.10, 0.10, 0.35),
        block("p2 R1", 0.10, 0.55, 0.35),
        block("p2 L2", 0.20, 0.10, 0.35),
        block("p2 R2", 0.20, 0.55, 0.35),
      ],
    },
  ]);
  expect(
    "T12 document-level → pages joined with \\n\\n",
    result.text,
    "Page 1 line\n\np2 L1\np2 L2\np2 R1\np2 R2",
  );
  expect("T12 document-level → documentLayoutType multi-column-2", result.documentLayoutType, "multi-column-2");
  expect("T12 document-level → 2 pages in perPage", result.perPage.length, 2);
}

// ── T13: blocks preserved (diagnostic invariant) ─────────────────────────────
{
  const inputBlocks = [
    block("L1", 0.10, 0.10, 0.35),
    block("R1", 0.10, 0.55, 0.35),
  ];
  const result = reflowPageBlocks(1, inputBlocks);
  expect("T13 input blocks preserved on output", result.blocks.length, 2);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed of ${pass + fail} total`);
if (fail > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
