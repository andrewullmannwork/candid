/**
 * Fixture for the EOB parse hotfix — plans/eob-ocr-per-page-fallback-hotfix.md
 *
 *   Fix A — bill-parser sanity gate blocks ONLY on scanForSbcMarkers (never page count).
 *   Fix B — undecodable-page detection + targeted Document AI recovery + splice.
 *
 * CI-safe assertions run against the committed SBC fixtures (tests/fixtures/sbcs):
 * they prove Fix A (SBCs still blocked) and Fix B's no-over-fire regression (clean
 * SBCs + image-only appendix pages flag ZERO undecodable pages → no Document AI).
 *
 * The Kaiser EOB recovery proof runs only when the source PDF is present locally
 * (it carries member PII, so it is NOT committed) — set EOB_FIXTURE_PATH or drop
 * it at ~/Downloads. Skipped in CI. Manually runnable per Ship Gate G4.
 *
 * Run: npx tsx scripts/eob-hotfix-fixture.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { readFileSync, readdirSync, existsSync } from "fs";
import { getDocumentProxy, extractText } from "unpdf";
import { extractTextFromPDFLayer } from "@/lib/ocr/pdf-text-extract";
import { applyBillParserSanityGate } from "@/lib/classifier/fallback";
import { DEFAULT_CLASSIFIER_FALLBACK_CONFIG } from "@/lib/config/classifier-fallback-config";
import { DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG } from "@/lib/config/ocr-fallback-config";
import { extractPagesToSubPdf, documentAIProvider } from "@/lib/ocr/document-ai";
import { parseBillWithHaiku } from "@/lib/billing/haiku-bill-parser";

const SBC_DIR = resolve(__dirname, "../tests/fixtures/sbcs");
const EOB_PATH =
  process.env.EOB_FIXTURE_PATH ||
  `${process.env.HOME}/Downloads/Explanation of Benefits (EOB).pdf`;

const DET = {
  candidateMaxChars: DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.candidateMaxChars,
  minTextOps: DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.minTextOps,
  minCharsPerOp: DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.minCharsPerOp,
};
const GATE_CFG = { ...DEFAULT_CLASSIFIER_FALLBACK_CONFIG, enabled: true };

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

async function mergedText(path: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

async function main() {
  const sbcDirs = readdirSync(SBC_DIR).filter((d) =>
    existsSync(resolve(SBC_DIR, d, "sbc.pdf")),
  );

  console.log("\n=== Fix A — sanity gate blocks on SBC markers, not page count ===");
  for (const d of sbcDirs) {
    const txt = await mergedText(resolve(SBC_DIR, d, "sbc.pdf"));
    const v = await applyBillParserSanityGate({
      config: GATE_CFG,
      effectiveType: "eob",
      ocrText: txt,
      pageCount: null,
    });
    check(`SBC ${d} → BLOCKED`, v.blocked === true);
  }
  const longBill = await applyBillParserSanityGate({
    config: GATE_CFG,
    effectiveType: "eob",
    ocrText: "Explanation of Benefits\nProvider Visit\nAmount you owe $50.00",
    pageCount: 200,
  });
  check("long bill text @200pp with 0 SBC markers → NOT blocked", longBill.blocked === false);

  console.log("\n=== Fix B regression — clean SBCs flag ZERO undecodable pages (no over-fire) ===");
  for (const d of sbcDirs) {
    const buf = readFileSync(resolve(SBC_DIR, d, "sbc.pdf"));
    const res = await extractTextFromPDFLayer(buf, DET);
    const flagged = res.undecodablePageNumbers ?? [];
    check(`SBC ${d} → 0 undecodable [${flagged.join(",")}]`, flagged.length === 0);
  }

  if (existsSync(EOB_PATH)) {
    console.log("\n=== Fix B recovery — Kaiser EOB (local; PII, not committed) ===");
    const buf = readFileSync(EOB_PATH);
    const res = await extractTextFromPDFLayer(buf, DET);
    const flagged = res.undecodablePageNumbers ?? [];
    check(`EOB flags page 4 undecodable [${flagged.join(",")}]`, flagged.includes(4));

    const gv = await applyBillParserSanityGate({
      config: GATE_CFG,
      effectiveType: "eob",
      ocrText: res.text,
      pageCount: 16,
    });
    check("EOB → NOT blocked by the sanity gate", gv.blocked === false);

    const subPdf = await extractPagesToSubPdf(buf, flagged.map((n) => n - 1));
    const docai = await documentAIProvider.extractText(subPdf, "application/pdf");
    check(
      "targeted DocAI on the undecodable page(s) recovers 90834 + 128.39",
      docai.text.includes("90834") && docai.text.includes("128.39"),
    );

    const pages = res.pages.map((p) => ({ ...p }));
    flagged.forEach((pn, i) => {
      const sp = docai.pages[i];
      const t = pages.find((p) => p.pageNumber === pn);
      if (sp && t) t.text = sp.text;
    });
    const spliced = pages.map((p) => p.text).join("\n\n");
    check("spliced text carries the claim (90834)", spliced.includes("90834"));

    const parsed = await parseBillWithHaiku(
      spliced,
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000",
      "eob",
      "ocr",
    );
    check(
      "parser extracts exactly 1 line item, CPT 90834",
      !!parsed && parsed.lineItems.length === 1 && parsed.lineItems[0].procedureCode === "90834",
    );
  } else {
    console.log(`\n(skip EOB recovery — ${EOB_PATH} not present; CI-safe)`);
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
