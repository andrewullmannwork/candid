// Ing-G.2/3 — Adversarial-PDF feature extractor (deterministic, no LLM).
//
// Extracts the artifact + structural feature vector that the scorer
// (`adversarial-pdf.ts`) consumes. Runs in the ingest path AND in calibration
// (`scripts/calibration/adversarial/extract-features-ts.ts`) — SAME code in
// both, so the corpus calibration transfers to production with no extractor
// seam (the poppler `extract-features.py` is corpus-build provenance only).
//
// Design constraints (S170 critical pass):
//   - Deterministic; pdf-lib for structure + the pipeline's own pdfjs text-layer
//     reader for markers (NEVER OCR — a scanned doc must read as image_only, not
//     be assessed as if born-digital).
//   - NON-FATAL / fail-closed: any parse failure yields `extraction_ok=false`
//     with neutral features. A doc pdf-lib can't parse (≈1/119 real in the
//     corpus: a malformed-xref Kaiser SBC) must NEVER become a false positive.
//   - `image_only` is detected STRUCTURALLY (n_fonts===0 ∧ n_images>0), never by
//     text length — the OCR layer back-fills text for scans, so text length is
//     not a reliable image-only signal.

import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import type { PDFObject } from "pdf-lib";
import { extractTextFromPDFLayer, ImageOnlyPDFError } from "@/lib/ocr/pdf-text-extract";

/** Federal SBC template markers. `\s*` between words (not a single literal
 *  space) makes detection robust to the production pdfjs text path, which —
 *  unlike poppler's pdftotext — variably drops spaces ("whythismatters") or
 *  multiplies them ("Why   This   Matters") depending on the PDF's glyph
 *  positioning (verified S170 on macOS-Quartz synthetics + FL-Blue reals). The
 *  phrases are distinctive enough that zero-width joins don't false-match. */
const SBC_HEADER_RE = /summary\s*of\s*benefits\s*and\s*coverage/i;
const IMPORTANT_QUESTIONS_RE = /important\s*questions?/i;
const WHY_THIS_MATTERS_RE = /why\s*this\s*matters/i;
const COVERAGE_EXAMPLES_RE = /coverage\s*examples?/i;
const OMB_RE = /0938-?\s?(\d{3,4})/;
const OMB_CORRECT = "1146"; // the federal SBC OMB control number 0938-1146

export interface AdversarialPdfFeatures {
  // --- document metadata ---
  producer: string;
  creator: string;
  pages: number;
  file_size: number;
  encrypted: boolean;
  // --- font profile (the load-bearing artifact signal) ---
  n_fonts: number;
  n_embedded: number;
  n_subset: number;
  // --- raster vs text ---
  n_images: number;
  text_len: number;
  has_text_layer: boolean;
  image_only: boolean;
  // --- structural (federal SBC template) ---
  sbc_header: boolean;
  has_important_questions: boolean;
  has_why_this_matters: boolean;
  has_coverage_examples: boolean;
  omb_present: boolean;
  omb_correct: boolean;
  // --- extraction status (drives assessability; never throws) ---
  structure_ok: boolean; // pdf-lib parsed the object graph
  text_ok: boolean; // pdfjs text-layer read returned text
}

const asName = (v: PDFObject | undefined): string => (v ? v.toString() : "");

/** Resolve a value that may be an indirect ref to a PDFDict; null on miss. */
function resolveDict(
  ctx: PDFDocument["context"],
  v: PDFObject | undefined,
): PDFDict | null {
  try {
    if (v == null) return null;
    if (v instanceof PDFDict) return v;
    const o = ctx.lookup(v);
    return o instanceof PDFDict ? o : null;
  } catch {
    return null;
  }
}

/** A font is embedded if it (or, for a Type0 composite, its descendant CIDFont)
 *  has a FontDescriptor carrying a FontFile/FontFile2/FontFile3 stream. */
function isFontEmbedded(
  ctx: PDFDocument["context"],
  fontDict: PDFDict,
): boolean {
  try {
    let fd = resolveDict(ctx, fontDict.get(PDFName.of("FontDescriptor")));
    if (!fd) {
      let desc = fontDict.get(PDFName.of("DescendantFonts"));
      if (desc && !(desc instanceof PDFArray)) desc = ctx.lookup(desc);
      if (desc instanceof PDFArray && desc.size() > 0) {
        const cid = resolveDict(ctx, desc.get(0));
        if (cid) fd = resolveDict(ctx, cid.get(PDFName.of("FontDescriptor")));
      }
    }
    if (!fd) return false;
    return ["FontFile", "FontFile2", "FontFile3"].some((k) =>
      Boolean(fd!.get(PDFName.of(k))),
    );
  } catch {
    return false;
  }
}

interface StructureStats {
  producer: string;
  creator: string;
  pages: number;
  encrypted: boolean;
  n_fonts: number;
  n_embedded: number;
  n_subset: number;
  n_images: number;
}

/** pdf-lib structural pass. Returns null if the object graph can't be parsed
 *  (caller treats null as structure_ok=false — neutral, never a positive). */
async function parseStructure(
  bytes: Uint8Array,
): Promise<StructureStats | null> {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    const ctx = doc.context;
    let nFonts = 0,
      nEmbedded = 0,
      nSubset = 0,
      nImages = 0;
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      let dict: PDFDict | null = null;
      const streamDict = (obj as unknown as { dict?: unknown })?.dict; // streams carry their dict here
      if (obj instanceof PDFDict) dict = obj;
      else if (streamDict instanceof PDFDict) dict = streamDict;
      if (!dict) continue;
      const type = asName(dict.get(PDFName.of("Type")));
      const subtype = asName(dict.get(PDFName.of("Subtype")));
      if (type === "/XObject" && subtype === "/Image") {
        nImages++;
        continue;
      }
      if (type === "/Font") {
        // skip CIDFont descendants — counted via their Type0 parent
        if (subtype === "/CIDFontType0" || subtype === "/CIDFontType2") continue;
        nFonts++;
        if (/\/[A-Z]{6}\+/.test(asName(dict.get(PDFName.of("BaseFont")))))
          nSubset++;
        if (isFontEmbedded(ctx, dict)) nEmbedded++;
      }
    }
    return {
      producer: doc.getProducer() ?? "",
      creator: doc.getCreator() ?? "",
      pages: doc.getPageCount(),
      encrypted: doc.isEncrypted,
      n_fonts: nFonts,
      n_embedded: nEmbedded,
      n_subset: nSubset,
      n_images: nImages,
    };
  } catch {
    return null;
  }
}

/** pdfjs text-LAYER read (never OCR). Empty string + text_ok=false on a scanned
 *  or unparseable doc — markers then read absent, which is correct for a raster. */
async function readTextLayer(
  bytes: Uint8Array,
): Promise<{ text: string; text_ok: boolean }> {
  try {
    const result = await extractTextFromPDFLayer(Buffer.from(bytes));
    return { text: result.text ?? "", text_ok: true };
  } catch (err) {
    // ImageOnlyPDFError (text < 500 chars) → no usable text layer (scanned).
    // Any other parse error → also no text; both are non-fatal here.
    if (!(err instanceof ImageOnlyPDFError)) {
      console.warn(
        `[adversarial-pdf] text-layer read failed: ${(err as Error).message}`,
      );
    }
    return { text: "", text_ok: false };
  }
}

/**
 * Extract the full adversarial-PDF feature vector from raw PDF bytes.
 * NEVER throws — on total failure returns a neutral, unassessable vector.
 */
export async function extractAdversarialPdfFeatures(
  bytes: Uint8Array,
): Promise<AdversarialPdfFeatures> {
  const [structure, textRead] = await Promise.all([
    parseStructure(bytes),
    readTextLayer(bytes),
  ]);

  const text = textRead.text;
  const omb = OMB_RE.exec(text);

  const s = structure;
  const structure_ok = s !== null;

  return {
    producer: s?.producer ?? "",
    creator: s?.creator ?? "",
    pages: s?.pages ?? 0,
    file_size: bytes.byteLength,
    encrypted: s?.encrypted ?? false,
    n_fonts: s?.n_fonts ?? 0,
    n_embedded: s?.n_embedded ?? 0,
    n_subset: s?.n_subset ?? 0,
    n_images: s?.n_images ?? 0,
    text_len: text.trim().length,
    has_text_layer: textRead.text_ok && text.trim().length > 0,
    // image_only is a STRUCTURAL determination (never text length); requires a
    // successful structural parse so a structure failure isn't mislabeled scanned.
    image_only: structure_ok ? s!.n_fonts === 0 && s!.n_images > 0 : false,
    sbc_header: SBC_HEADER_RE.test(text),
    has_important_questions: IMPORTANT_QUESTIONS_RE.test(text),
    has_why_this_matters: WHY_THIS_MATTERS_RE.test(text),
    has_coverage_examples: COVERAGE_EXAMPLES_RE.test(text),
    omb_present: omb !== null,
    omb_correct: omb !== null && omb[1] === OMB_CORRECT,
    structure_ok,
    text_ok: textRead.text_ok,
  };
}
