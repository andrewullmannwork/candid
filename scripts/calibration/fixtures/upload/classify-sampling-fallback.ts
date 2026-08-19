/**
 * S320 — CLASSIFY SAMPLING-FALLBACK FIXTURE (pure, offline, CI-wired).
 *
 * Locks the quick-classify degrade contract: pdf-lib page sampling is an
 * OCR-budget OPTIMIZATION and must never gate an upload. pdf-lib is stricter
 * about xref structure than pdfjs (the pipeline's primary reader), so a
 * real-world PDF the pipeline can fully read may still make pdf-lib throw —
 * the S320 specimen was an insurer-published SBC with broken object refs that
 * pdfjs read perfectly (9 pages, 29k chars) while pdf-lib died at
 * getPageCount, killing the upload with "Classification failed" twice.
 *
 *   pdf-lib-hostile PDF -> extractSamplePages MUST NOT throw; returns the
 *                          full buffer + samplingFailed (classification then
 *                          runs on the whole document; page count comes from
 *                          the OCR engine that actually read it)
 *   healthy short PDF   -> passthrough buffer, real page count, no fallback
 *   healthy long PDF    -> 4-page sample, real page count, no fallback
 *   image upload        -> passthrough, single page, no fallback
 *
 * Offline: buffers built in memory (pdf-lib for the healthy cases, a
 * handcrafted broken-ref body for the hostile case). No DB, no network.
 * The real S320 specimen replay lives in scripts/s320-repro-classify.ts
 * (storage download — manual, not CI).
 */
import { extractSamplePages } from "@/lib/classifier/quick-classify";
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
  console.log("— pdf-lib-hostile PDF degrades, never gates —");
  let hostile: Awaited<ReturnType<typeof extractSamplePages>> | null = null;
  let threw = false;
  try {
    hostile = await extractSamplePages(BROKEN_PDF, "application/pdf");
  } catch {
    threw = true;
  }
  check("hostile: extractSamplePages does not throw", !threw);
  check("hostile: samplingFailed is set", !!hostile?.samplingFailed);
  check("hostile: full buffer passes through", hostile?.miniBuffer === BROKEN_PDF);
  check("hostile: totalPages reads unknown (0)", hostile?.totalPages === 0);

  console.log("— healthy short PDF: passthrough, no fallback —");
  const short = await extractSamplePages(await healthyPdf(2), "application/pdf");
  check("short: no samplingFailed", short.samplingFailed === undefined);
  check("short: totalPages 2", short.totalPages === 2);

  console.log("— healthy long PDF: 4-page sample, no fallback —");
  const longBuf = await healthyPdf(6);
  const long = await extractSamplePages(longBuf, "application/pdf");
  check("long: no samplingFailed", long.samplingFailed === undefined);
  check("long: totalPages 6", long.totalPages === 6);
  const mini = await PDFDocument.load(long.miniBuffer);
  check("long: sample is 4 pages", mini.getPageCount() === 4);

  console.log("— image upload: passthrough —");
  const img = await extractSamplePages(Buffer.from("not-a-pdf"), "image/jpeg");
  check("image: single page, no fallback", img.totalPages === 1 && img.samplingFailed === undefined);

  console.log(`\n${pass}/${pass + fails.length} passed`);
  if (fails.length > 0) {
    console.error(`FAILED: ${fails.join(" | ")}`);
    process.exit(1);
  }
})();
