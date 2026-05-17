/**
 * Direct PDF text-layer extraction via pdfjs-dist (B11 — Path F primary path).
 *
 * For digital PDFs (the vast majority of SBCs, EOCs, and plan documents from
 * insurer compliance teams) the PDF contains a native text layer — the
 * characters were typed into the source document, not transcribed from a scan.
 * Reading that layer directly is:
 *   - Byte-exact (zero transcription errors — better cite-grade fidelity than OCR)
 *   - Free (no Document AI API call required)
 *   - Fast (~100ms vs ~2-5s for Document AI network round-trip)
 *   - **Naturally column-aware**: pdfjs emits text items in PDF content stream
 *     order, which is the order the document author placed them — for federal
 *     SBCs this is proper top-to-bottom, left-to-right reading order per column
 *     (empirically verified S97 on BS Bronze 60 PPO drug section: "Tier 1" →
 *     "Retail : $19..." → "Mail Service : $38..." emits cleanly with NO
 *     column-interleaving — the bug pattern that Document AI OCR exhibits).
 *
 * For image-only PDFs (scanned EOBs, photo'd documents) the text layer is
 * empty or sparse. We detect this via a text-density probe and signal the
 * dispatcher to fall back to Document AI OCR.
 *
 * Cite-grade safety: each pdfjs `TextItem.str` is byte-exact from the PDF
 * text layer. Each item carries its `transform` (origin in PDF user space)
 * which we convert to normalized [0, 1] coordinates and attach to per-block
 * `OCRBlock.boundingBox` so downstream code (e.g. Pattern P-8 verifier) can
 * access positions if needed.
 *
 * No reflow applied here — pdfjs natural emission order is correct for digital
 * PDFs. The `reflowDocument` primitive in `./reflow.ts` is reserved for the
 * Document AI fallback path (image-only PDFs whose OCR output exhibits the
 * S96 column-interleaving artifact).
 *
 * Serverless compatibility: uses the pdfjs-dist legacy build (no web worker,
 * no DOM dependency for text-only extraction). Dynamic-imported so cold-start
 * cost only fires on first call.
 */

import type { OCRResult, OCRPage, OCRBlock } from "./types";

/**
 * Minimum total characters across the document to consider "digital".
 * Below this threshold, fall back to Document AI OCR (likely image-only PDF
 * where pdfjs returns blanks or scraps).
 *
 * Calibration: smallest legitimate SBC in `tests/fixtures/sbcs/` is ~15K chars;
 * smallest EOC is ~30K chars. 500 is a conservative floor that catches scanned
 * PDFs (which typically return < 50 chars) without false-positive rejecting
 * sparse-but-real digital documents.
 *
 * Mirrors the SBC_MIN_TEXT_CHARS / EOC_MIN_TEXT_CHARS thresholds already used
 * in process-chunk/route.ts:39-47 (image-PDF refusal).
 */
const MIN_DOC_TEXT_CHARS = 500;

/** Marker error so the dispatcher can fall back without ambiguity. */
export class ImageOnlyPDFError extends Error {
  readonly extractedChars: number;
  constructor(extractedChars: number) {
    super(
      `PDF text layer too sparse (${extractedChars} chars) — likely image-only PDF; fall back to OCR.`,
    );
    this.name = "ImageOnlyPDFError";
    this.extractedChars = extractedChars;
  }
}

/**
 * unpdf is a Node/serverless-friendly wrapper around pdfjs-dist (same upstream
 * library) that handles the worker-setup complexity that Turbopack's dynamic-
 * import resolver chokes on (observed S97 — both default fake-worker and
 * createRequire workerSrc workarounds failed under Next.js 16.2 / Turbopack).
 * unpdf's `getDocumentProxy` returns the same `PDFDocumentProxy` shape as
 * `pdfjs.getDocument({...}).promise`, so the per-page text-extraction loop
 * stays unchanged.
 */

/**
 * Extract text + per-block positions from a PDF's native text layer.
 *
 * Returns an OCRResult-shaped object with `text` emitted in pdfjs's natural
 * order (PDF content stream order, which is the document author's intended
 * reading order for digital PDFs).
 *
 * Per-page `blocks` carry bounding boxes for downstream consumers that need
 * spatial information (cite-grade verifier extensions, Document AI fallback
 * reflow when image-only).
 *
 * Throws `ImageOnlyPDFError` if total extracted text is below
 * MIN_DOC_TEXT_CHARS, signaling the caller to fall back to OCR. Throws other
 * errors (encrypted PDF, malformed structure, etc.) directly so the caller
 * can decide whether to retry via OCR.
 */
export async function extractTextFromPDFLayer(
  fileBuffer: Buffer,
): Promise<OCRResult> {
  // unpdf hides the worker-setup details that fail under Turbopack. Same
  // underlying pdfjs-dist; same PDFDocumentProxy shape on the other side.
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(fileBuffer));
  const pages: OCRPage[] = [];
  const allPageText: string[] = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const textContent = await page.getTextContent();
    const blocks: OCRBlock[] = [];
    const lineParts: string[] = [];

    for (const item of textContent.items) {
      // Type guard: pdfjs emits both TextItem (has `str`) and TextMarkedContent
      // (structure markers, no `str`). Skip the latter.
      if (!("str" in item) || typeof item.str !== "string") continue;
      const str = item.str;
      if (str.length === 0) continue;

      // pdfjs transform: [a, b, c, d, e, f] — a 2D affine matrix.
      // For text items: a/d carry font scale (height ≈ |d|); e/f carry origin.
      // PDF coordinates: origin at bottom-left of page (y grows upward).
      const transform = item.transform;
      const x = transform[4];
      const yBottom = transform[5];
      const itemWidth = item.width ?? 0;
      // Use |d| as font height; falls back to item.height if available.
      const itemHeight = Math.abs(transform[3] ?? 0) || (item.height ?? 0);

      // Convert PDF user space (bottom-left origin) to top-down normalized [0, 1].
      const yTopAbs = pageHeight - yBottom - itemHeight;

      blocks.push({
        text: str,
        confidence: 1.0, // byte-exact from PDF text layer — no transcription
        boundingBox: {
          top: clamp01(yTopAbs / pageHeight),
          left: clamp01(x / pageWidth),
          width: clamp01(itemWidth / pageWidth),
          height: clamp01(itemHeight / pageHeight),
        },
        blockType: "LINE",
      });

      // Concatenate text in emission order. pdfjs sets `hasEOL=true` on items
      // at end of a visual line — use that to insert newlines; otherwise space.
      lineParts.push(str);
      if ("hasEOL" in item && item.hasEOL) {
        lineParts.push("\n");
      } else {
        lineParts.push(" ");
      }

      totalChars += str.length;
    }

    const pageText = lineParts.join("");
    pages.push({
      pageNumber: pageNum,
      text: pageText,
      blocks,
    });
    allPageText.push(pageText);
  }

  // Text-density gate: below threshold, signal caller to fall back to OCR.
  if (totalChars < MIN_DOC_TEXT_CHARS) {
    throw new ImageOnlyPDFError(totalChars);
  }

  // Pages joined with double-newlines (mirrors Document AI's `document.text`
  // separator pattern + downstream section-regex compatibility).
  const text = allPageText.join("\n\n");

  return {
    text,
    pages,
    confidence: 1.0,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
