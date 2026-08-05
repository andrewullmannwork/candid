/**
 * attach-originals — S305. The originals, bound into the Case File PDF.
 *
 * Spec §5 decision 4: "Attach the originals. Every uploaded bill and EOB goes
 * into the PDF alongside every sent letter. A document that cannot be attached
 * is LISTED rather than silently dropped."
 *
 * The letters are already in the document — the compiler embeds their text as
 * exhibits, so both the text and PDF formats carry them. This module handles the
 * part only a PDF can do: binding the source FILES in after the composed pages.
 *
 * Deliberately takes a `download` function rather than a Supabase client, so the
 * merge is testable without storage and the caller keeps ownership of auth. It
 * never throws: a document that cannot be fetched, decoded or embedded becomes a
 * page saying so, because a legal package that silently loses an exhibit is
 * worse than one that admits it.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface OriginalDocument {
  /** Exhibit label continues the letters' sequence — "D", "E", … */
  label: string;
  fileName: string;
  storagePath: string;
}

export interface AttachResult {
  bytes: Uint8Array;
  attached: string[];
  /** Labels we could not bind, with why — surfaced by the caller, never hidden. */
  failed: Array<{ label: string; fileName: string; reason: string }>;
}

const IMAGE_EXT = /\.(jpe?g|png)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const PDF_EXT = /\.pdf$/i;

/**
 * Append each original after the composed Case File pages.
 *
 * Order follows the exhibit labels, so the document reads in the order its own
 * exhibit list promises.
 */
export async function appendOriginals(
  caseFilePdf: Uint8Array,
  originals: OriginalDocument[],
  download: (storagePath: string) => Promise<ArrayBuffer | null>,
): Promise<AttachResult> {
  if (originals.length === 0) {
    return { bytes: caseFilePdf, attached: [], failed: [] };
  }

  const out = await PDFDocument.load(caseFilePdf);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const attached: string[] = [];
  const failed: AttachResult["failed"] = [];

  for (const doc of originals) {
    try {
      const raw = await download(doc.storagePath);
      if (!raw || raw.byteLength === 0) {
        failed.push({ label: doc.label, fileName: doc.fileName, reason: "the file could not be retrieved" });
        addNotePage(out, font, doc, "the file could not be retrieved from storage");
        continue;
      }
      const added = await appendOne(out, doc, raw);
      if (added) attached.push(doc.label);
      else {
        failed.push({ label: doc.label, fileName: doc.fileName, reason: "unsupported file type" });
        addNotePage(out, font, doc, "this file type cannot be bound into a PDF");
      }
    } catch (err) {
      // Never let one bad exhibit cost the whole package.
      const reason = err instanceof Error ? err.message : "could not be read";
      failed.push({ label: doc.label, fileName: doc.fileName, reason });
      addNotePage(out, font, doc, "the file could not be read");
    }
  }

  return { bytes: await out.save(), attached, failed };
}

/** Returns false when the file is a type we cannot bind. */
async function appendOne(
  out: PDFDocument,
  doc: OriginalDocument,
  raw: ArrayBuffer,
): Promise<boolean> {
  const path = doc.storagePath;

  if (PDF_EXT.test(path)) {
    // ignoreEncryption: a scanned bill is often "encrypted" with an empty owner
    // password purely to disable printing. It is the user's own document.
    const src = await PDFDocument.load(raw, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    return true;
  }

  let bytes = new Uint8Array(raw);
  let isPng = /\.png$/i.test(path);
  if (HEIC_EXT.test(path)) {
    // Phone photos of a bill are the common upload, and pdf-lib cannot embed
    // HEIC. `heic-convert` is already a dependency for the same reason.
    const heicConvert = (await import("heic-convert")).default as unknown as (opts: {
      buffer: Buffer;
      format: "JPEG" | "PNG";
      quality?: number;
    }) => Promise<ArrayBuffer>;
    const converted = await heicConvert({ buffer: Buffer.from(bytes), format: "JPEG", quality: 0.92 });
    bytes = new Uint8Array(converted);
    isPng = false;
  } else if (!IMAGE_EXT.test(path)) {
    return false;
  }

  const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  // Fit the image to a LETTER page, preserving aspect, with a modest margin.
  const page = out.addPage([612, 792]);
  const margin = 36;
  const maxW = 612 - margin * 2;
  const maxH = 792 - margin * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (612 - w) / 2, y: (792 - h) / 2, width: w, height: h });
  return true;
}

/**
 * A page that says what is missing and why.
 *
 * The alternative — dropping the exhibit — leaves an exhibit list that promises
 * a document the package does not contain, which is the one failure mode a
 * lawyer cannot detect by reading.
 */
function addNotePage(
  out: PDFDocument,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  doc: OriginalDocument,
  why: string,
): void {
  const page = out.addPage([612, 792]);
  page.drawText(`Exhibit ${doc.label} — ${doc.fileName}`, {
    x: 56, y: 720, size: 13, font, color: rgb(0.07, 0.09, 0.15),
  });
  page.drawText(`This document is on file but ${why}.`, {
    x: 56, y: 696, size: 10.5, font, color: rgb(0.42, 0.45, 0.5),
  });
  page.drawText("It is listed here so the record shows what is missing.", {
    x: 56, y: 680, size: 10.5, font, color: rgb(0.42, 0.45, 0.5),
  });
}
