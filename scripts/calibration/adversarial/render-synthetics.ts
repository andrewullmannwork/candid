/**
 * Ing-G.2a — render synthetic SBC HTML (Axis A: GPT/Gemini/Claude content) to PDF via
 * headless Chrome (Axis B: the dominant real adversary pipeline → Producer "Skia/PDF").
 *
 * Each rendered PDF gets a .meta.json sidecar recording provenance (axis_a content source,
 * axis_b renderer, fidelity) so the feature extractor can label the corpus.
 *
 * NOTE: only one HTML renderer (Chrome) is installable locally (no wkhtmltopdf/weasyprint/
 * LibreOffice) → the HTML-pipeline synthetic class is single-producer (Skia). Documented
 * representativeness caveat in rubric.md; post-MVP should expand the renderer set.
 *
 * Run: npx tsx scripts/calibration/adversarial/render-synthetics.ts
 */
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIR = resolve(process.cwd(), "scripts/calibration/adversarial");
const RAW = join(DIR, "_synthetic_raw");
const OUT = join(DIR, "_synthetic_pdfs");

function fidelityOf(stem: string): string {
  if (/naive/.test(stem)) return "naive";
  if (/moderate/.test(stem)) return "moderate";
  if (/high/.test(stem)) return "high";
  return "unspecified";
}

function main() {
  if (!existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}`); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  let n = 0, nq = 0;
  for (const vendor of ["chatgpt", "gemini", "claude"]) {
    const vdir = join(RAW, vendor);
    if (!existsSync(vdir)) continue;
    for (const f of readdirSync(vdir).filter((x) => x.endsWith(".html"))) {
      const stem = basename(f, ".html");
      const inPath = join(vdir, f);
      const outPdf = join(OUT, `html-${vendor}__${stem}.pdf`);
      try {
        execFileSync(CHROME, [
          "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
          "--run-all-compositor-stages-before-draw", "--virtual-time-budget=5000",
          `--print-to-pdf=${outPdf}`, `file://${inPath}`,
        ], { stdio: "ignore", timeout: 60000 });
        writeFileSync(outPdf.replace(/\.pdf$/, ".meta.json"), JSON.stringify({
          stratum: "synthetic",
          axis_a_content: vendor,
          axis_b_renderer: "chrome-headless",
          producer_expected: "Skia/PDF",
          fidelity: fidelityOf(stem),
          source_html: `${vendor}/${f}`,
        }, null, 2));
        n++;
        console.log(`  ✓ html-${vendor}__${stem}.pdf`);
      } catch (e) {
        console.error(`  ✗ ${vendor}/${f}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Axis-B 2nd renderer: native macOS Quartz (textutil HTML→txt → cupsfilter → "Quartz PDFContext").
      // Same content, different engine/producer — isolates the artifact signal from content. Text-only
      // (Quartz has no HTML table engine here) → a low-fidelity "macOS-printed" class; producer also
      // appears on real macOS-printed uploads (reinforces the producer-not-separable finding).
      try {
        const tmpTxt = join(tmpdir(), `_advq_${vendor}_${stem}.txt`);
        execFileSync("textutil", ["-convert", "txt", inPath, "-output", tmpTxt], { stdio: "ignore", timeout: 30000 });
        const pdf = execFileSync("cupsfilter", [tmpTxt], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
        const qPdf = join(OUT, `quartz-${vendor}__${stem}.pdf`);
        writeFileSync(qPdf, pdf);
        writeFileSync(qPdf.replace(/\.pdf$/, ".meta.json"), JSON.stringify({
          stratum: "synthetic", axis_a_content: vendor, axis_b_renderer: "macos-quartz",
          producer_expected: "Quartz PDFContext", fidelity: `${fidelityOf(stem)}-textonly`, source_html: `${vendor}/${f}`,
        }, null, 2));
        nq++;
        console.log(`  ✓ quartz-${vendor}__${stem}.pdf`);
      } catch (e) {
        console.error(`  ✗ quartz ${vendor}/${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  console.log(`\nrendered ${n} HTML→Chrome/Skia + ${nq} HTML→macOS-Quartz to _synthetic_pdfs/`);
}

main();
