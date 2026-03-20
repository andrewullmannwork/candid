// AWS Textract OCR provider
// Requires: npm install @aws-sdk/client-textract

import type { OCRProvider, OCRResult, OCRPage, OCRBlock } from "./types";

let _client: any = null;
let _sdk: any = null;

async function loadSDK() {
  if (_sdk) return _sdk;
  _sdk = await import("@aws-sdk/client-textract");
  return _sdk;
}

async function getClient() {
  if (_client) return _client;
  const { TextractClient } = await loadSDK();
  _client = new TextractClient({
    region: process.env.AWS_REGION || "us-east-1",
  });
  return _client;
}

export const textractProvider: OCRProvider = {
  name: "aws-textract",

  async extractText(fileBuffer: Buffer): Promise<OCRResult> {
    const sdk = await loadSDK();
    const client = await getClient();

    const command = new sdk.DetectDocumentTextCommand({
      Document: { Bytes: fileBuffer },
    });

    const response = await client.send(command);
    const blocks = response.Blocks || [];

    // Group blocks by page
    const pageMap = new Map<number, OCRBlock[]>();
    const pageTexts = new Map<number, string[]>();

    for (const block of blocks) {
      const pageNum = block.Page || 1;

      if (!pageMap.has(pageNum)) {
        pageMap.set(pageNum, []);
        pageTexts.set(pageNum, []);
      }

      if (block.BlockType === "LINE") {
        pageTexts.get(pageNum)!.push(block.Text || "");
        pageMap.get(pageNum)!.push({
          text: block.Text || "",
          confidence: (block.Confidence || 0) / 100,
          boundingBox: block.Geometry?.BoundingBox
            ? {
                top: block.Geometry.BoundingBox.Top,
                left: block.Geometry.BoundingBox.Left,
                width: block.Geometry.BoundingBox.Width,
                height: block.Geometry.BoundingBox.Height,
              }
            : undefined,
          blockType: "LINE",
        });
      }
    }

    const pages: OCRPage[] = [];
    let fullText = "";
    let totalConfidence = 0;
    let lineCount = 0;

    for (const [pageNum, ocrBlocks] of pageMap.entries()) {
      const pageText = pageTexts.get(pageNum)!.join("\n");
      fullText += pageText + "\n\n";
      pages.push({
        pageNumber: pageNum,
        text: pageText,
        blocks: ocrBlocks,
      });

      for (const block of ocrBlocks) {
        totalConfidence += block.confidence;
        lineCount++;
      }
    }

    return {
      text: fullText.trim(),
      pages,
      confidence: lineCount > 0 ? totalConfidence / lineCount : 0,
    };
  },
};
