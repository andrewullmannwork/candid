/**
 * Sub-segmentation helper for EOC parser per Phase 3.1A.1 Subplan + DR-3.1A.1-B.
 *
 * Purpose: split a large section text into smaller chunks before dispatching to
 * Haiku. Verbatim quoting fidelity degrades as input grows; smaller chunks recover
 * verbatim quality (Pattern P-8 source_excerpt verified rate 20% → ≥80% target).
 *
 * Per-section granularity (Q-P3.1A.1-1 LOCK):
 *   - 'paragraph' (\n\n): medical_necessity, appeals_procedures, cob_rules, eligibility_rules
 *   - 'line' (\n): prior_auth_codes (dense table/list)
 *   - 'term' (term-boundary): definitions (glossary entries)
 *
 * Term-granularity falls back to paragraph if <2 pieces emitted (DR-3.1A.1-B-1 LOCK).
 *
 * Insurer-agnostic by construction: all granularities are universal text-structure
 * patterns, not insurer-specific phrasings.
 */

import { estimateTokens } from "./haiku-prompts/_shared";

export type Granularity = "paragraph" | "line" | "term";

export interface Chunk {
  start: number; // offset relative to section start
  end: number; // exclusive
  text: string;
  tokenEstimate: number;
}

const PARAGRAPH_DELIMITER = /\n{2,}/g;
const LINE_DELIMITER = /\n/g;

// Term-boundary pattern: line starts with a Title-Case phrase OR ALL-CAPS phrase,
// followed by a definition separator (em-dash, en-dash, hyphen with spaces, colon).
// Insurer-agnostic — covers common glossary conventions across EOC documents.
const TERM_BOUNDARY = /^(?:[A-Z][a-zA-Z][a-zA-Z ]{0,40}|[A-Z]{2,}[A-Z ]{0,40})[ \t]*[—:–\-][ \t]/gm;

interface Piece {
  text: string;
  start: number;
}

/**
 * Split text on a delimiter regex; returns pieces between delimiters with byte
 * offsets relative to text start. Used for paragraph + line granularity.
 */
function splitOnDelimiter(text: string, delimiter: RegExp): Piece[] {
  const pieces: Piece[] = [];
  const flagged = new RegExp(delimiter.source, delimiter.flags.includes("g") ? delimiter.flags : delimiter.flags + "g");
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = flagged.exec(text)) !== null) {
    if (m.index > lastEnd) {
      pieces.push({ text: text.slice(lastEnd, m.index), start: lastEnd });
    }
    lastEnd = m.index + m[0].length;
    // Guard against infinite loop on zero-width matches.
    if (m[0].length === 0) flagged.lastIndex++;
  }
  if (lastEnd < text.length) {
    pieces.push({ text: text.slice(lastEnd), start: lastEnd });
  }
  return pieces;
}

/**
 * Split text on boundary positions; pieces START at each boundary match.
 * Used for term granularity. The preamble (text before first boundary) is
 * emitted as its own piece if non-trivial.
 */
function splitOnBoundary(text: string, boundary: RegExp): Piece[] {
  const flagged = new RegExp(boundary.source, boundary.flags.includes("g") ? boundary.flags : boundary.flags + "g");
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = flagged.exec(text)) !== null) {
    positions.push(m.index);
    if (m[0].length === 0) flagged.lastIndex++;
  }
  if (positions.length === 0) {
    return text.length > 0 ? [{ text, start: 0 }] : [];
  }

  const pieces: Piece[] = [];
  if (positions[0] > 0) {
    const preamble = text.slice(0, positions[0]);
    if (preamble.trim().length > 0) pieces.push({ text: preamble, start: 0 });
  }
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : text.length;
    pieces.push({ text: text.slice(start, end), start });
  }
  return pieces;
}

function piecesForGranularity(text: string, granularity: Granularity): Piece[] {
  switch (granularity) {
    case "paragraph":
      return splitOnDelimiter(text, PARAGRAPH_DELIMITER);
    case "line":
      return splitOnDelimiter(text, LINE_DELIMITER);
    case "term":
      return splitOnBoundary(text, TERM_BOUNDARY);
  }
}

function makeChunk(pieces: Piece[], sectionText: string): Chunk {
  if (pieces.length === 0) {
    throw new Error("makeChunk: empty pieces array");
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const start = first.start;
  const end = last.start + last.text.length;
  const text = sectionText.slice(start, end);
  return {
    start,
    end,
    text,
    tokenEstimate: estimateTokens(text),
  };
}

/**
 * Sub-segment a section's text into chunks of size ≤ maxTokens (greedy merge of
 * consecutive pieces under the granularity boundary). Returns chunks with
 * byte offsets relative to the section start.
 *
 * Edge cases:
 *   - Empty sectionText → returns [].
 *   - Granularity yields a single piece > maxTokens → emits oversized chunk
 *     anyway (don't sub-split mid-sentence; verbatim quoting suffers more from
 *     mid-sentence cuts than from oversized input).
 *   - 'term' granularity yields <2 pieces AND fallbackGranularity provided →
 *     retries with fallback (DR-3.1A.1-B-1 LOCK).
 */
export function subSegmentSection(
  sectionText: string,
  granularity: Granularity,
  maxTokens: number,
  fallbackGranularity?: Granularity,
): Chunk[] {
  if (sectionText.length === 0) return [];

  let pieces = piecesForGranularity(sectionText, granularity);

  // Term-granularity fallback (DR-3.1A.1-B-1).
  if (granularity === "term" && pieces.length < 2 && fallbackGranularity && fallbackGranularity !== "term") {
    pieces = piecesForGranularity(sectionText, fallbackGranularity);
  }

  if (pieces.length === 0) return [];

  // Greedy merge consecutive pieces up to maxTokens.
  const chunks: Chunk[] = [];
  let buf: Piece[] = [];
  let bufTokens = 0;

  for (const piece of pieces) {
    if (piece.text.length === 0) continue;
    const t = estimateTokens(piece.text);

    if (bufTokens + t > maxTokens && buf.length > 0) {
      chunks.push(makeChunk(buf, sectionText));
      buf = [];
      bufTokens = 0;
    }

    buf.push(piece);
    bufTokens += t;
  }

  if (buf.length > 0) {
    chunks.push(makeChunk(buf, sectionText));
  }

  return chunks;
}
