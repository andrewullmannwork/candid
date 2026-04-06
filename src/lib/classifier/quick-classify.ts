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
 */
async function extractSamplePages(
  buffer: Buffer,
  mimeType: string,
): Promise<{ miniBuffer: Buffer; mimeType: string; totalPages: number }> {
  const isPDF = mimeType === "application/pdf" || mimeType?.includes("pdf");

  if (!isPDF) {
    // Images are single-page — return as-is
    return { miniBuffer: buffer, mimeType, totalPages: 1 };
  }

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
}

export interface QuickClassifyResult {
  classifiedType: ClassifiedDocType;
  confidence: number;
  pageCount: number;
  ocrTextPreview: string;
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
  const { miniBuffer, mimeType: miniMime, totalPages } = await extractSamplePages(
    fileBuffer,
    mimeType,
  );

  // OCR the mini-document
  const ocrResult = await extractTextFromDocument(miniBuffer, miniMime);

  // Classify based on the preview text
  const classification = classifyDocument({ text: ocrResult.text });

  return {
    classifiedType: classification.classifiedType,
    confidence: classification.confidence,
    pageCount: totalPages,
    ocrTextPreview: ocrResult.text,
  };
}
