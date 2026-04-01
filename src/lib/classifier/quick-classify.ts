/**
 * Quick classification — OCR first 2 pages only, classify, return confidence.
 * Saves OCR budget by not processing full documents that will be rejected.
 */

import type { ClassifiedDocType } from "./index";
import { classifyDocument } from "./index";
import { extractTextFromDocument } from "@/lib/ocr";

/**
 * Extract first N pages from a PDF buffer using pdf-lib.
 * For images, returns the buffer unchanged.
 */
async function extractFirstPages(
  buffer: Buffer,
  mimeType: string,
  maxPages: number = 2
): Promise<{ miniBuffer: Buffer; mimeType: string; totalPages: number }> {
  const isPDF = mimeType === "application/pdf" || mimeType?.includes("pdf");

  if (!isPDF) {
    // Images are single-page — return as-is
    return { miniBuffer: buffer, mimeType, totalPages: 1 };
  }

  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= maxPages) {
    return { miniBuffer: buffer, mimeType, totalPages };
  }

  // Extract first N pages into a new PDF
  const miniDoc = await PDFDocument.create();
  const pagesToCopy = Math.min(maxPages, totalPages);
  const copiedPages = await miniDoc.copyPages(
    srcDoc,
    Array.from({ length: pagesToCopy }, (_, i) => i)
  );
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
  // Extract first 2 pages (or full image)
  const { miniBuffer, mimeType: miniMime, totalPages } = await extractFirstPages(
    fileBuffer,
    mimeType,
    2
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
