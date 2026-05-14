/**
 * scripts/generate-image-only-fixtures.ts — S90 Phase 1.11 + 1.12 fixtures.
 *
 * Generates two PDFs designed to trigger the parser's image-PDF refusal
 * path:
 *   - tests/fixtures/synthetic-image-only/synthetic-image-only-sbc.pdf
 *   - tests/fixtures/synthetic-image-only/synthetic-image-only-eoc.pdf
 *
 * Construction:
 *   1 page, US Letter, no text layer. Draws a few gray rectangles to
 *   simulate the visual shape of scanned page content blocks. Because
 *   nothing is text, any downstream text extraction (pdftotext or OCR over
 *   the rasterized output) returns well under 500 chars — tripping the
 *   `EOC_MIN_TEXT_CHARS` / `SBC_MIN_TEXT_CHARS` guards in
 *   src/app/api/documents/process-chunk/route.ts.
 *
 * Subplan §1.11 / §1.12 expects:
 *   documents.status='error' + processing_step='rejected_image_sbc' (or eoc)
 *   UI prompts user to upload a text-based version.
 *
 * Usage:
 *   npx tsx scripts/generate-image-only-fixtures.ts
 */

import { PDFDocument, rgb } from "pdf-lib";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const OUTPUT_DIR = resolve(__dirname, "..", "tests", "fixtures", "synthetic-image-only");

const LETTER_WIDTH = 612; // 8.5" * 72
const LETTER_HEIGHT = 792; // 11"  * 72

interface FixtureSpec {
  filename: string;
  blocks: Array<{ x: number; y: number; w: number; h: number; shade: number }>;
}

const FIXTURES: FixtureSpec[] = [
  {
    filename: "synthetic-image-only-sbc.pdf",
    blocks: [
      // Heading-band placeholder
      { x: 60, y: 720, w: 492, h: 24, shade: 0.7 },
      // Two "table-like" rows
      { x: 60, y: 660, w: 240, h: 40, shade: 0.85 },
      { x: 320, y: 660, w: 232, h: 40, shade: 0.85 },
      { x: 60, y: 600, w: 240, h: 40, shade: 0.85 },
      { x: 320, y: 600, w: 232, h: 40, shade: 0.85 },
      // Body content block
      { x: 60, y: 200, w: 492, h: 360, shade: 0.92 },
    ],
  },
  {
    filename: "synthetic-image-only-eoc.pdf",
    blocks: [
      // Multi-section EOC-shaped visual
      { x: 60, y: 720, w: 492, h: 24, shade: 0.7 },
      { x: 60, y: 660, w: 492, h: 48, shade: 0.9 },
      { x: 60, y: 580, w: 492, h: 60, shade: 0.92 },
      { x: 60, y: 480, w: 492, h: 80, shade: 0.92 },
      { x: 60, y: 380, w: 492, h: 80, shade: 0.92 },
      { x: 60, y: 60, w: 492, h: 300, shade: 0.95 },
    ],
  },
];

async function buildFixture(spec: FixtureSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
  for (const block of spec.blocks) {
    page.drawRectangle({
      x: block.x,
      y: block.y,
      width: block.w,
      height: block.h,
      color: rgb(block.shade, block.shade, block.shade),
    });
  }
  return pdf.save();
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const spec of FIXTURES) {
    const bytes = await buildFixture(spec);
    const outputPath = resolve(OUTPUT_DIR, spec.filename);
    writeFileSync(outputPath, bytes);
    console.log(`✅ ${spec.filename} (${bytes.length.toLocaleString()} bytes)  →  ${outputPath}`);
  }
  console.log(`\nFixtures ready. Upload via Chrome with the upload type picker set to:`);
  console.log(`  - "Summary of Benefits and Coverage" → synthetic-image-only-sbc.pdf`);
  console.log(`  - "Evidence of Coverage" / "Plan document" → synthetic-image-only-eoc.pdf`);
  console.log(`\nExpected: documents.status='error', processing_step='rejected_image_sbc' (or _eoc).`);
}

main().catch((e) => {
  console.error("Fixture generation crashed:", e);
  process.exit(1);
});
