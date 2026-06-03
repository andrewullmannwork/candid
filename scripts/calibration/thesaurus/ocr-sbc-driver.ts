/**
 * Tiny OCR driver for calibration — extracts text from SBC PDFs using the
 * pdfjs primary path (extractTextFromPDFLayer). Independence-gate: does NOT
 * call process-plan.ts or any production parser.
 *
 * Usage: npx tsx scripts/calibration/thesaurus/ocr-sbc-driver.ts <pdf-path>
 * Outputs raw text to stdout.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractTextFromPDFLayer } from "@/lib/ocr/pdf-text-extract";

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("Usage: ocr-sbc-driver.ts <pdf-path>");

  const absPath = resolve(pdfPath);
  const buf = readFileSync(absPath);
  const result = await extractTextFromPDFLayer(buf);

  // Write to stdout — caller captures
  process.stdout.write(result.text);
  process.stderr.write(`\n[ocr-driver] pages=${result.pages.length} total_chars=${result.text.length}\n`);
}

main().catch(e => { process.stderr.write(`FATAL: ${e.message}\n`); process.exit(1); });
