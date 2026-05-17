/**
 * B11 helper v2 — re-extract pages 1-8 of BS Bronze 60 PPO bundle with
 * altered Title metadata so the file hash differs from v1 (which was already
 * uploaded + processed via Document AI fallback). This lets us re-upload and
 * exercise the now-working pdfjs path on the same multi-column SBC content.
 */

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { PDFDocument } from "pdf-lib";

async function main() {
  const inputPath = "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/sbc.pdf";
  const outputPath = join(homedir(), "Downloads", "bs-bronze-60-ppo-clean-sbc-v2.pdf");

  const inputBytes = readFileSync(inputPath);
  const inputPdf = await PDFDocument.load(inputBytes);

  const outputPdf = await PDFDocument.create();
  const copiedPages = await outputPdf.copyPages(inputPdf, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const page of copiedPages) outputPdf.addPage(page);

  // Alter metadata so file hash differs from v1 — content stays identical.
  outputPdf.setTitle("BS Bronze 60 PPO SBC — clean extract v2 (B11 pdfjs validation)");
  outputPdf.setSubject("Federal SBC pages 1-8 extracted from bundle for testing");
  outputPdf.setProducer("Candid B11 test fixture extractor");

  const outputBytes = await outputPdf.save();
  writeFileSync(outputPath, outputBytes);
  console.log(`✅ Clean BS SBC v2 written: ${outputPath}`);
  console.log(`   pages: ${outputPdf.getPageCount()}`);
  console.log(`   size: ${(outputBytes.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error("Extract failed:", err);
  process.exit(1);
});
