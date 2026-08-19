/**
 * S320 — PDF-OPS DEGRADE FIXTURE (pure, offline, CI-wired).
 *
 * Locks the pipeline's remaining pdf-lib degrade contracts (the classify
 * sampler's contract lives in classify-sampling-fallback.ts):
 *
 *   estimatePageCount:
 *     healthy PDF          -> pdf-lib's count (the fast path)
 *     pdf-lib-hostile PDF  -> pdfjs count when pdfjs can read it; otherwise 1
 *                             (the crafted fragment defeats BOTH engines →
 *                             last-resort 1, and it must NOT throw)
 *   countPagesViaPdfLayer:
 *     healthy PDF          -> real count
 *     unreadable fragment  -> null (never throws)
 *   splitPDF:
 *     hostile PDF          -> { chunks: [whole buffer], degraded: true } —
 *                             NEVER throws (the S320 "Final Steps" wedge: an
 *                             unguarded throw here stranded a claimed doc in
 *                             working_init forever)
 *     healthy <= maxPages  -> single passthrough chunk, degraded: false
 *     healthy > maxPages   -> real chunks, degraded: false
 *
 * The pdfjs-rescues-the-count path on a REAL broken-xref-but-readable SBC is
 * proven by scripts/s320-repro-init.ts against the live specimen (manual —
 * needs the downloaded file; the crafted fragment here cannot be both
 * pdf-lib-hostile and pdfjs-readable).
 */
import { estimatePageCount, splitPDF } from "@/lib/ocr/document-ai";
import { countPagesViaPdfLayer } from "@/lib/ocr/pdf-text-extract";
import { PDFDocument } from "pdf-lib";
import { BROKEN_PDF, healthyPdf } from "./hostile-pdf";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}`);
  }
}

(async () => {
  const healthy3 = await healthyPdf(3);
  const healthy20 = await healthyPdf(20);

  console.log("— countPagesViaPdfLayer —");
  check("healthy: real count", (await countPagesViaPdfLayer(healthy3)) === 3);
  check("unreadable fragment: null, no throw", (await countPagesViaPdfLayer(BROKEN_PDF)) === null);

  console.log("— estimatePageCount —");
  check("healthy: pdf-lib count", (await estimatePageCount(healthy3)) === 3);
  let threw = false;
  let hostileCount = -1;
  try {
    hostileCount = await estimatePageCount(BROKEN_PDF);
  } catch {
    threw = true;
  }
  check("hostile: does not throw", !threw);
  check("hostile (both engines fail): last-resort 1", hostileCount === 1);

  console.log("— splitPDF —");
  let splitThrew = false;
  let hostileSplit: Awaited<ReturnType<typeof splitPDF>> | null = null;
  try {
    hostileSplit = await splitPDF(BROKEN_PDF, 15);
  } catch {
    splitThrew = true;
  }
  check("hostile: does not throw", !splitThrew);
  check("hostile: degraded flag set", hostileSplit?.degraded === true);
  check(
    "hostile: whole buffer as the one chunk",
    hostileSplit?.chunks.length === 1 && hostileSplit.chunks[0] === BROKEN_PDF,
  );

  const small = await splitPDF(healthy3, 15);
  check("healthy <= max: single passthrough, not degraded", small.degraded === false && small.chunks.length === 1);

  const big = await splitPDF(healthy20, 15);
  check("healthy > max: real chunks, not degraded", big.degraded === false && big.chunks.length === 2);
  const chunk2 = await PDFDocument.load(big.chunks[1]);
  check("healthy > max: second chunk carries the remainder (5 pages)", chunk2.getPageCount() === 5);

  console.log(`\n${pass}/${pass + fails.length} passed`);
  if (fails.length > 0) {
    console.error(`FAILED: ${fails.join(" | ")}`);
    process.exit(1);
  }
})();
