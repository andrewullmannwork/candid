/**
 * Quick classification — OCR first 2 pages only, classify, return confidence.
 * Saves OCR budget by not processing full documents that will be rejected.
 */

import type { ClassifiedDocType } from "./index";
import { classifyDocument } from "./index";
import { extractTextFromDocument } from "@/lib/ocr";

/**
 * Extract sample pages from a PDF buffer using pdf-lib.
 * For short documents (<=4 pages), returns the first 2 pages.
 * For long documents (>4 pages), samples first 2 + 2 from the middle
 * to catch healthcare content that appears after cover pages / TOC.
 * For images, returns the buffer unchanged.
 *
 * Sampling is an OCR-budget OPTIMIZATION and must never gate the upload:
 * pdf-lib is stricter about xref structure than pdfjs (the pipeline's primary
 * reader since S97), so a real-world PDF the pipeline can fully read may still
 * throw here (S320: an insurer-published SBC with broken object refs died at
 * getPageCount). On ANY pdf-lib failure we fall back to classifying on the
 * full document — same non-fatal ingest discipline as the OCR layer and the
 * adversarial-PDF assessment. `samplingFailed` carries the error for
 * telemetry; totalPages 0 = unknown, resolved from the OCR result upstream.
 */
export async function extractSamplePages(
  buffer: Buffer,
  mimeType: string,
): Promise<{
  miniBuffer: Buffer;
  mimeType: string;
  totalPages: number;
  samplingFailed?: string;
}> {
  const isPDF = mimeType === "application/pdf" || mimeType?.includes("pdf");

  if (!isPDF) {
    // Images are single-page — return as-is
    return { miniBuffer: buffer, mimeType, totalPages: 1 };
  }

  try {
    const { PDFDocument } = await import("pdf-lib");
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();

    // Short documents — return first 2 pages
    if (totalPages <= 4) {
      if (totalPages <= 2) {
        return { miniBuffer: buffer, mimeType, totalPages };
      }
      const miniDoc = await PDFDocument.create();
      const copiedPages = await miniDoc.copyPages(srcDoc, [0, 1]);
      for (const page of copiedPages) miniDoc.addPage(page);
      return { miniBuffer: Buffer.from(await miniDoc.save()), mimeType: "application/pdf", totalPages };
    }

    // Long documents — sample first 2 + 2 from the middle (skip cover/TOC)
    const midStart = Math.floor(totalPages / 3);
    const pageIndices = [0, 1, midStart, midStart + 1].filter(i => i < totalPages);
    // Deduplicate in case of overlap
    const uniqueIndices = [...new Set(pageIndices)];

    const miniDoc = await PDFDocument.create();
    const copiedPages = await miniDoc.copyPages(srcDoc, uniqueIndices);
    for (const page of copiedPages) {
      miniDoc.addPage(page);
    }
    const miniBytes = await miniDoc.save();

    return {
      miniBuffer: Buffer.from(miniBytes),
      mimeType: "application/pdf",
      totalPages,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[quick-classify] pdf-lib page sampling failed — classifying on the full document: ${msg}`,
    );
    return { miniBuffer: buffer, mimeType, totalPages: 0, samplingFailed: msg };
  }
}

export interface QuickClassifyResult {
  classifiedType: ClassifiedDocType;
  confidence: number;
  pageCount: number;
  ocrTextPreview: string;
  /** Set when pdf-lib page sampling failed and classification ran on the full
   *  document instead (pageCount then comes from the OCR result). Persisted to
   *  documents.metadata.classification_override.sampling_fallback so the class
   *  frequency is queryable. */
  samplingFallback?: string;
}

/**
 * Perform a quick classification by OCR-ing only the first 2 pages.
 * Returns the classification result + OCR text preview for potential reuse.
 */
export async function quickClassify(
  fileBuffer: Buffer,
  mimeType: string
): Promise<QuickClassifyResult> {
  // Extract sample pages (first 2 + middle 2 for long docs)
  const { miniBuffer, mimeType: miniMime, totalPages, samplingFailed } =
    await extractSamplePages(fileBuffer, mimeType);

  // OCR the mini-document (the full document on sampling fallback)
  const ocrResult = await extractTextFromDocument(miniBuffer, miniMime);

  // Classify based on the preview text
  const classification = classifyDocument({ text: ocrResult.text });

  // Sampling fallback: pdf-lib couldn't count pages, but the OCR engine just
  // read the whole document — its page list is the real count. Downstream
  // consumers (UPLOAD_MAX_PAGES cap, doc-type resolver, Cost-H async tier)
  // get the honest number instead of a gate-killing throw.
  const pageCount = samplingFailed ? ocrResult.pages.length : totalPages;

  return {
    classifiedType: classification.classifiedType,
    confidence: classification.confidence,
    pageCount,
    ocrTextPreview: ocrResult.text,
    ...(samplingFailed ? { samplingFallback: samplingFailed } : {}),
  };
}
