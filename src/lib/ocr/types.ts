// OCR provider interface — swap implementations without changing consumers

export interface OCRResult {
  text: string;
  pages: OCRPage[];
  confidence: number; // 0-1 overall confidence
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
