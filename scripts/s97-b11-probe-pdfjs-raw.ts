/**
 * B11 architectural probe — does pdfjs emit BS SBC text in natural reading
 * order, or does it inherit the column-interleaving issue from OCR?
 *
 * Method: extract text from BS Bronze 60 PPO PDF using pdfjs in its natural
 * emission order (NO reflow). Find the drug section. Print the surrounding
 * 1000 chars. If "Tier 1 / Tier 2 / Tier 3" reads cleanly, reflow is
 * unnecessary for the pdfjs path. If it interleaves with explanation text,
 * reflow is still needed.
 */

import { readFileSync } from "fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pdfjs: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPdfjs(): Promise<any> {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return _pdfjs;
}

async function extractRawText(path: string): Promise<string> {
  const pdfjs = await loadPdfjs();
  const buffer = readFileSync(path);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const pdf = await loadingTask.promise;

  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    parts.push(`\n=== PAGE ${pageNum} ===\n`);
    for (const item of textContent.items) {
      if (!("str" in item) || typeof item.str !== "string") continue;
      parts.push(item.str);
      if ("hasEOL" in item && item.hasEOL) parts.push("\n");
      else parts.push(" ");
    }
  }
  return parts.join("");
}

async function main() {
  const fixtures = [
    {
      label: "BS Bronze 60 PPO",
      path: "tests/fixtures/sbcs/blue-shield-ca-2025-bronze-60-ppo/sbc.pdf",
      searchPattern: /Tier 1/i,
    },
    {
      label: "Ambetter Bronze 60 HDHP",
      path: "tests/fixtures/sbcs/ambetter-ca-2024-bronze-60-hdhp/sbc.pdf",
      searchPattern: /Preferred brand drugs/i,
    },
  ];

  for (const fx of fixtures) {
    console.log(`\n${"=".repeat(80)}\n${fx.label}\n${"=".repeat(80)}`);
    const text = await extractRawText(fx.path);
    const match = text.search(fx.searchPattern);
    if (match < 0) {
      console.log(`  [not found: ${fx.searchPattern}]`);
      continue;
    }
    const start = Math.max(0, match - 100);
    const end = Math.min(text.length, match + 1500);
    console.log(`\n--- ${fx.searchPattern} context (chars ${start}-${end}) ---`);
    console.log(text.slice(start, end));
    console.log(`--- end ---`);
  }
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(2);
});
