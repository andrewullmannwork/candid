// OCR provider interface — swap implementations without changing consumers

export interface OCRResult {
  text: string;
  pages: OCRPage[];
  confidence: number; // 0-1 overall confidence
  /**
   * 1-based page numbers (relative to the buffer this result was extracted from)
   * where the PDF drew text but pdfjs decoded ~nothing — i.e. a real text layer
   * that failed to map to Unicode (subset fonts with no ToUnicode CMap). The
   * dispatcher recovers these pages via a targeted Document AI OCR pass and
   * splices them back. Absent/empty on clean extractions. Set only by
   * `extractTextFromPDFLayer` when undecodable-page detection is enabled.
   */
  undecodablePageNumbers?: number[];
}

export interface OCRPage {
  pageNumber: number;
  text: string;
  blocks: OCRBlock[];
}

export interface OCRBlock {
  text: string;
  confidence: number;
  boundingBox?: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  blockType: "LINE" | "WORD" | "TABLE" | "KEY_VALUE";
}

export interface OCRProvider {
  name: string;
  extractText(fileBuffer: Buffer, mimeType: string): Promise<OCRResult>;
}
