// Google Cloud Document AI OCR provider
// Reuses the Firebase Admin service account — no extra credentials needed.
// Requires: npm install @google-cloud/documentai

import type { OCRProvider, OCRResult, OCRPage, OCRBlock } from "./types";

let _client: any = null;
let _sdk: any = null;

async function loadSDK() {
  if (_sdk) return _sdk;
  _sdk = await import("@google-cloud/documentai");
  return _sdk;
}

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

export const documentAIProvider: OCRProvider = {
  name: "google-document-ai",

  async extractText(fileBuffer: Buffer, mimeType: string): Promise<OCRResult> {
    const client = await getClient();
    const { projectId } = getCredentials();
    const location = process.env.DOCUMENT_AI_LOCATION || "us";
    const processorId = process.env.DOCUMENT_AI_PROCESSOR_ID;

    if (!processorId) {
      throw new Error(
        "DOCUMENT_AI_PROCESSOR_ID env var is required. Create an OCR processor in the GCP Console."
      );
    }

    const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    const [result] = await client.processDocument({
      name,
      rawDocument: {
        content: fileBuffer.toString("base64"),
        mimeType: mimeType || "application/pdf",
      },
    });

    const document = result.document;
    if (!document?.text) {
      return { text: "", pages: [], confidence: 0 };
    }

    const fullText = document.text;

    // Build pages from Document AI page structure
    const pages: OCRPage[] = [];
    let totalConfidence = 0;
    let blockCount = 0;

    for (const page of document.pages || []) {
      const pageNumber = (page.pageNumber || 1) as number;
      const pageBlocks: OCRBlock[] = [];
      const pageLines: string[] = [];

      // Extract lines from Document AI's line segments
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

      // Fallback: if no lines, try paragraphs
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

    return {
      text: fullText,
      pages,
      confidence: blockCount > 0 ? totalConfidence / blockCount : 0,
    };
  },
};

// Extract text from a layout using the document's full text + text anchors
function extractTextFromLayout(layout: any, fullText: string): string {
  if (!layout?.textAnchor?.textSegments?.length) return "";
  return layout.textAnchor.textSegments
    .map((seg: any) => {
      const start = Number(seg.startIndex || 0);
      const end = Number(seg.endIndex || 0);
      return fullText.slice(start, end);
    })
    .join("")
    .trim();
}

function extractBoundingBox(
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
