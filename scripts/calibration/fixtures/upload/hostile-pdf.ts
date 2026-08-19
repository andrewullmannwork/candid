/**
 * S320 — shared PDF specimens for the pdf-lib degrade fixtures.
 *
 * BROKEN_PDF: a catalog whose /Pages points at an object that doesn't exist —
 * the S320 failure shape (an insurer-published SBC with broken object refs
 * made pdf-lib throw `Expected instance of PDFDict, but got instance of
 * undefined` at getPageCount while pdfjs read all 9 pages cleanly). pdf-lib
 * either rejects at load or throws at getPageCount; both must degrade.
 *
 * ONE specimen, imported by every fixture that needs a pdf-lib-hostile buffer
 * — so the crafted shape can't drift between fixtures.
 */
import { PDFDocument } from "pdf-lib";

export const BROKEN_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 99 0 R >>",
    "endobj",
    "trailer",
    "<< /Size 2 /Root 1 0 R >>",
    "%%EOF",
  ].join("\n"),
);

/** Build a healthy N-page PDF in memory. */
export async function healthyPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}
