/**
 * B11 helper — extract pages 1-8 of the BS Bronze 60 PPO bundle into a clean
 * BS SBC PDF (federal SBCs are 8 pages by mandate). Output written to
 * ~/Downloads/ so Andrew can upload it via the localhost UI.
 *
 * Run: `npx tsx scripts/s97-b11-extract-clean-bs-sbc.ts`
 */

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { PDFDocument } from "pdf-lib";

async function main() {
  const inputPath = "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/sbc.pdf";
  const outputPath = join(homedir(), "Downloads", "bs-bronze-60-ppo-clean-sbc.pdf");

  console.log(`Reading bundle: ${inputPath}`);
  const inputBytes = readFileSync(inputPath);
  const inputPdf = await PDFDocument.load(inputBytes);
  console.log(`Bundle total pages: ${inputPdf.getPageCount()}`);

  // Federal SBC mandate: 8 pages. Extract pages 1-8 (0-indexed 0-7).
  const outputPdf = await PDFDocument.create();
  const copiedPages = await outputPdf.copyPages(inputPdf, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const page of copiedPages) outputPdf.addPage(page);

  const outputBytes = await outputPdf.save();
  writeFileSync(outputPath, outputBytes);
  console.log(`\n✅ Clean BS SBC written: ${outputPath}`);
  console.log(`   pages: ${outputPdf.getPageCount()}`);
  console.log(`   size: ${(outputBytes.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error("Extract failed:", err);
  process.exit(1);
});
