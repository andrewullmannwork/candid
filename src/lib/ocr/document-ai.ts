// Google Cloud Document AI OCR provider
// Reuses the Firebase Admin service account — no extra credentials needed.
// Supports large PDFs by splitting into chunks (Document AI sync API has a 15-page limit).

import type { OCRProvider, OCRResult, OCRPage, OCRBlock } from "./types";

const MAX_PAGES_PER_REQUEST = 15;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: any = null;

async function loadSDK() {
  if (_sdk) return _sdk;
  _sdk = await import("@google-cloud/documentai");
  return _sdk;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCredentials(): { projectId: string; credentials: any } {
  const encoded = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!encoded) {
    throw new Error(
      "FIREBASE_ADMIN_SERVICE_ACCOUNT env var is required for Document AI"
    );
  }

  const json = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  return {
    projectId: json.project_id,
    credentials: {
      client_email: json.client_email,
      private_key: json.private_key,
    },
  };
}

async function getClient() {
  if (_client) return _client;
  const { DocumentProcessorServiceClient } = await loadSDK();
  const { projectId, credentials } = getCredentials();
  _client = new DocumentProcessorServiceClient({
    projectId,
    credentials,
  });
  return _client;
}

/**
 * Count pages in a PDF buffer.
 *
 * S100 fix (Andrew direction): replaced the regex-based hack with a pdf-lib
 * load. The old heuristic counted `/Type /Page` minus `/Type /Pages` strings
 * in the binary, which silently undercounted on PDFs with object streams /
 * compressed page trees (typical of modern PDFs from insurer portals). An
 * 8-page Blue Shield SBC reproducibly returned 1, leaving the UI stuck at
 * "Page 1 of 1" through the full parse window.
 *
 * pdf-lib's `getPageCount()` is authoritative + same module already imported
 * by `splitPDF`; the import cost is paid once per worker. The function stays
 * `async` so callers must `await`.
 */
export async function estimatePageCount(buffer: Buffer): Promise<number> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    // Corrupt PDF or password-locked — fall back to 1 so callers don't div0.
    return 1;
  }
}

/** Split a PDF into chunks of maxPages using pdf-lib */
export async function splitPDF(buffer: Buffer, maxPages: number): Promise<Buffer[]> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(buffer);
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= maxPages) {
    return [buffer];
  }

  const chunks: Buffer[] = [];
  for (let start = 0; start < totalPages; start += maxPages) {
    const end = Math.min(start + maxPages, totalPages);
    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(
      srcDoc,
      Array.from({ length: end - start }, (_, i) => start + i)
    );
    for (const page of copiedPages) {
      chunkDoc.addPage(page);
    }
    const chunkBytes = await chunkDoc.save();
    chunks.push(Buffer.from(chunkBytes));
  }

  return chunks;
}

/** Process a single PDF buffer through Document AI */
async function processChunk(
  chunkBuffer: Buffer,
  mimeType: string,
  processorName: string
): Promise<{ text: string; pages: OCRPage[]; totalConfidence: number; blockCount: number }> {
  const client = await getClient();

  const [result] = await client.processDocument({
    name: processorName,
    rawDocument: {
      content: chunkBuffer.toString("base64"),
      mimeType: mimeType || "application/pdf",
    },
  });

  const document = result.document;
  if (!document?.text) {
    return { text: "", pages: [], totalConfidence: 0, blockCount: 0 };
  }

  const fullText = document.text;
  const pages: OCRPage[] = [];
  let totalConfidence = 0;
  let blockCount = 0;

  for (const page of document.pages || []) {
    const pageNumber = (page.pageNumber || 1) as number;
    const pageBlocks: OCRBlock[] = [];
    const pageLines: string[] = [];

    for (const line of page.lines || []) {
      const lineText = extractTextFromLayout(line.layout, fullText);
      const confidence = line.layout?.confidence ?? 0;

      pageLines.push(lineText);
      pageBlocks.push({
        text: lineText,
        confidence: confidence as number,
        boundingBox: extractBoundingBox(line.layout),
        blockType: "LINE",
      });

      totalConfidence += confidence as number;
      blockCount++;
    }

    if (pageBlocks.length === 0) {
      for (const paragraph of page.paragraphs || []) {
        const paraText = extractTextFromLayout(paragraph.layout, fullText);
        const confidence = paragraph.layout?.confidence ?? 0;

        pageLines.push(paraText);
        pageBlocks.push({
          text: paraText,
          confidence: confidence as number,
          boundingBox: extractBoundingBox(paragraph.layout),
          blockType: "LINE",
        });

        totalConfidence += confidence as number;
        blockCount++;
      }
    }

    pages.push({
      pageNumber,
      text: pageLines.join("\n"),
      blocks: pageBlocks,
    });
  }

  return { text: fullText, pages, totalConfidence, blockCount };
}

export const documentAIProvider: OCRProvider = {
  name: "google-document-ai",

  async extractText(fileBuffer: Buffer, mimeType: string): Promise<OCRResult> {
    const { projectId } = getCredentials();
    const location = process.env.DOCUMENT_AI_LOCATION || "us";
    const processorId = process.env.DOCUMENT_AI_PROCESSOR_ID;

    if (!processorId) {
      throw new Error(
        "DOCUMENT_AI_PROCESSOR_ID env var is required. Create an OCR processor in the GCP Console."
      );
    }

    const processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    // Check if we need to split the PDF into chunks
    const isPDF = mimeType === "application/pdf" || mimeType?.includes("pdf");
    const estimatedPages = isPDF ? await estimatePageCount(fileBuffer) : 1;

    if (isPDF && estimatedPages > MAX_PAGES_PER_REQUEST) {
      // Split and process in chunks
      const chunks = await splitPDF(fileBuffer, MAX_PAGES_PER_REQUEST);

      let allText = "";
      const allPages: OCRPage[] = [];
      let totalConfidence = 0;
      let totalBlocks = 0;
      let pageOffset = 0;

      for (const chunk of chunks) {
        const result = await processChunk(chunk, mimeType, processorName);
        allText += result.text;

        // Adjust page numbers for concatenation
        for (const page of result.pages) {
          allPages.push({
            ...page,
            pageNumber: page.pageNumber + pageOffset,
          });
        }
        pageOffset += result.pages.length;
        totalConfidence += result.totalConfidence;
        totalBlocks += result.blockCount;
      }

      return {
        text: allText,
        pages: allPages,
        confidence: totalBlocks > 0 ? totalConfidence / totalBlocks : 0,
      };
    }

    // Single chunk — process directly
    const result = await processChunk(fileBuffer, mimeType, processorName);
    return {
      text: result.text,
      pages: result.pages,
      confidence: result.blockCount > 0 ? result.totalConfidence / result.blockCount : 0,
    };
  },
};

// Extract text from a layout using the document's full text + text anchors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromLayout(layout: any, fullText: string): string {
  if (!layout?.textAnchor?.textSegments?.length) return "";
  return layout.textAnchor.textSegments
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((seg: any) => {
      const start = Number(seg.startIndex || 0);
      const end = Number(seg.endIndex || 0);
      return fullText.slice(start, end);
    })
    .join("")
    .trim();
}

function extractBoundingBox(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout: any
): OCRBlock["boundingBox"] | undefined {
  const vertices = layout?.boundingPoly?.normalizedVertices;
  if (!vertices || vertices.length < 4) return undefined;
  const top = vertices[0].y ?? 0;
  const left = vertices[0].x ?? 0;
  const width = (vertices[1].x ?? 0) - left;
  const height = (vertices[2].y ?? 0) - top;
  return { top, left, width, height };
}
