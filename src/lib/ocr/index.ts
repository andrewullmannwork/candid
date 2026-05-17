// OCR module — provider selection + B11 column-reflow dispatch.
// Providers loaded dynamically to avoid build errors when SDKs aren't installed.

import type { OCRProvider, OCRResult } from "./types";
import type { TextBlock } from "./reflow";

export type { OCRResult, OCRProvider } from "./types";

async function getProvider(): Promise<OCRProvider> {
  const providerName = process.env.OCR_PROVIDER || "google-document-ai";

  switch (providerName) {
    case "google-document-ai": {
      const { documentAIProvider } = await import("./document-ai");
      return documentAIProvider;
    }
    default:
      throw new Error(`Unknown OCR provider: ${providerName}`);
  }
}

/**
 * Extract text from a PDF/image document.
 *
 * B11 dispatch flow (when `pdfjs_primary_v1` flag ON, global):
 *   1. Try pdfjs text-layer extraction (free, byte-exact, fast). pdfjs emits
 *      text in PDF content stream order — naturally column-aware on digital
 *      PDFs; no reflow needed (empirically verified S97 on BS Bronze 60 PPO
 *      drug section).
 *   2. On `ImageOnlyPDFError` (text density below threshold), fall back to
 *      Google Document AI OCR.
 *   3. Other pdfjs errors (encrypted PDF, malformed structure) also fall back
 *      to Document AI — defensively maximize the chance of getting *some*
 *      text out of the upload.
 *
 * When `ocr_reflow_v1` flag ON (global) AND source is Document AI:
 *   - Apply the universal column-reflow primitive to Document AI's block
 *     output. Addresses OCR-specific column-interleaving (S96 finding) for
 *     image-only multi-column SBCs that miss the pdfjs primary path.
 *
 * Default (both flags OFF): legacy Document AI raw `document.text`. Byte-
 * identical to pre-B11 behavior.
 *
 * @param fileBuffer  raw bytes of the document (PDF preferred; images supported)
 * @param mimeType    "application/pdf" or "image/*"
 */
export async function extractTextFromDocument(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<OCRResult> {
  const isPDF = mimeType === "application/pdf" || mimeType?.includes("pdf");

  // Stage 1c — try pdfjs primary path first, gated on flag.
  if (isPDF) {
    const pdfjsPrimary = await safeIsFeatureEnabled("pdfjs_primary_v1");
    if (pdfjsPrimary) {
      try {
        const { extractTextFromPDFLayer } = await import("./pdf-text-extract");
        return await extractTextFromPDFLayer(fileBuffer);
      } catch (err) {
        // ImageOnlyPDFError → fall through to Document AI (expected path for
        // scanned EOBs). Other errors also fall through defensively — we
        // prefer degraded-but-extracted output over hard failure.
        console.warn(
          `[ocr] pdfjs primary failed (${(err as Error).name}): ${(err as Error).message}. Falling back to Document AI.`,
        );
      }
    }
  }

  // Document AI path (default + pdfjs fallback).
  const provider = await getProvider();
  const baseResult = await provider.extractText(fileBuffer, mimeType);

  // Apply column reflow on Document AI output when flag ON.
  const reflowOn = await safeIsFeatureEnabled("ocr_reflow_v1");
  if (!reflowOn) return baseResult;

  return await applyReflowToOCRResult(baseResult);
}

/**
 * Apply the universal column-reflow primitive to an OCR provider's block
 * output. Converts OCRBlocks → TextBlocks, runs reflow, replaces `text` with
 * the reflowed version while preserving per-page blocks for diagnostics.
 *
 * Safe to call on any OCRResult: missing bounding boxes degrade gracefully
 * (block is filtered out → no spurious reflow). No regression on documents
 * whose Document AI output is already single-column (reflow detects 0-1
 * column anchors → falls through to y-order emission).
 */
async function applyReflowToOCRResult(result: OCRResult): Promise<OCRResult> {
  // Convert OCRPage[] → ReflowDocument input shape.
  const pageInputs = result.pages.map((p) => ({
    pageNumber: p.pageNumber,
    blocks: p.blocks
      .filter((b) => b.boundingBox !== undefined)
      .map<TextBlock>((b) => ({
        text: b.text,
        top: b.boundingBox!.top,
        left: b.boundingBox!.left,
        width: b.boundingBox!.width,
        height: b.boundingBox!.height,
      })),
  }));

  // If no page has any positioned blocks, reflow is a no-op — return original.
  const anyPositioned = pageInputs.some((p) => p.blocks.length > 0);
  if (!anyPositioned) return result;

  // Lazy-load reflow to keep cold start small when flag is OFF.
  const { reflowDocument } = await import("./reflow");
  const reflowed = reflowDocument(pageInputs);

  // Preserve pages array; only `text` changes. Per-page text is also reflowed
  // for downstream callers that read individual pages.
  const updatedPages = result.pages.map((p, idx) => ({
    ...p,
    text: reflowed.perPage[idx]?.text ?? p.text,
  }));

  return {
    ...result,
    text: reflowed.text,
    pages: updatedPages,
  };
}

/**
 * Wrapper around isFeatureEnabled that fails closed on DB errors. We never
 * want the OCR pipeline to throw because the feature_flag_rules row was
 * unreachable — that would crash the entire upload flow.
 */
async function safeIsFeatureEnabled(flagKey: string): Promise<boolean> {
  try {
    const { isFeatureEnabled } = await import("@/lib/config/product-flags");
    return await isFeatureEnabled(flagKey);
  } catch (err) {
    console.warn(
      `[ocr] safeIsFeatureEnabled(${flagKey}) failed; defaulting to OFF: ${(err as Error).message}`,
    );
    return false;
  }
}
