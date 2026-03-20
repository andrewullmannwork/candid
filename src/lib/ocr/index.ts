// OCR module — provider selection and document processing
// Providers are loaded dynamically to avoid build errors when SDKs aren't installed

import type { OCRProvider, OCRResult } from "./types";

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

export async function extractTextFromDocument(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult> {
  const provider = await getProvider();
  return provider.extractText(fileBuffer, mimeType);
}
