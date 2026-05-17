/**
 * Universal column-detect + reading-order reflow for multi-column PDF/OCR output.
 *
 * Problem (S96 — Work Block B11): both Google Document AI's "Document OCR"
 * processor AND pdfjs text extraction emit text in horizontal-stripe reading
 * order — left-to-right across the full page width, top-to-bottom row-by-row.
 * On multi-column SBC layouts (notably Blue Shield's federal SBCs), narrow
 * left-column labels ("Tier 1", "Tier 2") get inserted INTO the middle of
 * wide-column explanatory sentences, corrupting the semantic flow before
 * Haiku ever sees the text.
 *
 * Fix: cluster text blocks by horizontal x-coordinate per page; reflow into
 * proper column-by-column reading order (column-1 top→bottom, then column-2,
 * then column-3).
 *
 * Cite-grade safety: each block's text is byte-exact from the source extractor
 * (pdfjs text-run OR Document AI OCR line). Reflow only changes concatenation
 * order — never the per-block character content. Pattern P-8 verifier still
 * works (and improves: bridged-match fallback is needed less often).
 *
 * Universal across:
 *   - Source extractors (pdfjs, Document AI — both produce TextBlock[])
 *   - Doc types (SBCs, EOCs, plan documents, bills — all benefit from
 *     deterministic column reading order)
 *   - Insurers (algorithm is layout-driven, not insurer-specific)
 */

/** A single positioned text fragment from any source extractor. */
export interface TextBlock {
  text: string;
  /** Normalized [0, 1] vertical position from top of page. */
  top: number;
  /** Normalized [0, 1] horizontal position from left of page. */
  left: number;
  /** Normalized [0, 1] block width. */
  width: number;
  /** Normalized [0, 1] block height. */
  height: number;
}

export type LayoutType =
  | "single-column"
  | "multi-column-2"
  | "multi-column-3"
  | "empty"
  | "unknown";

export interface ReflowedPage {
  pageNumber: number;
  text: string;
  layoutType: LayoutType;
  columnCount: number;
  /** Original input blocks preserved for diagnostic inspection. */
  blocks: TextBlock[];
}

// Tuning constants — conservative defaults; iterate via Stage 2 validation.
// All values normalized [0, 1].

/**
 * Block wider than this fraction of page width is treated as page-spanning.
 * Real federal SBC headers span 80%+ of page width; main content columns rarely
 * exceed 70%. 0.75 keeps wide-column content classified as column-restricted
 * (so it participates in column clustering) while catching true spanning content
 * (page headers, footers, full-width section dividers).
 */
const FULL_WIDTH_THRESHOLD = 0.75;

/** Histogram bucket size for x-coordinate clustering. */
const BUCKET_SIZE = 0.05; // 20 buckets across the page

/** A bucket must hold this fraction of column-restricted blocks to count as a peak. */
const MIN_PEAK_DENSITY = 0.08;

/** Minimum gap between column peaks (avoid double-detecting adjacent buckets). */
const MIN_PEAK_GAP = 0.15;

/** Top vertical strata for header spanning blocks. */
const TOP_STRATA_END = 0.18;

/** Bottom vertical strata for footer spanning blocks. */
const BOTTOM_STRATA_START = 0.85;

/**
 * Reflow text blocks on a single page into proper reading order.
 *
 * Returns the reflowed text plus a layoutType signal for downstream callers.
 */
export function reflowPageBlocks(
  pageNumber: number,
  blocks: TextBlock[],
): ReflowedPage {
  if (blocks.length === 0) {
    return {
      pageNumber,
      text: "",
      layoutType: "empty",
      columnCount: 0,
      blocks,
    };
  }

  if (blocks.length === 1) {
    return {
      pageNumber,
      text: blocks[0].text,
      layoutType: "single-column",
      columnCount: 1,
      blocks,
    };
  }

  // Step 1: split spanning blocks (page-wide content) from column-restricted ones.
  const spanning: TextBlock[] = [];
  const columnRestricted: TextBlock[] = [];
  for (const b of blocks) {
    if (b.width >= FULL_WIDTH_THRESHOLD) {
      spanning.push(b);
    } else {
      columnRestricted.push(b);
    }
  }

  // Step 2: detect column anchors via x-coordinate histogram on column-restricted blocks.
  const columnAnchors = detectColumnAnchors(columnRestricted);
  const columnCount = columnAnchors.length;

  // 0-1 anchors → single column, no reflow needed; emit in y-order.
  if (columnCount <= 1) {
    const sorted = [...blocks].sort((a, b) => a.top - b.top);
    return {
      pageNumber,
      text: sorted.map((b) => b.text).join("\n"),
      layoutType: "single-column",
      columnCount: Math.max(1, columnCount),
      blocks,
    };
  }

  // Step 3: assign column-restricted blocks to their nearest column anchor.
  const columnBuckets: TextBlock[][] = Array.from({ length: columnCount }, () => []);
  for (const b of columnRestricted) {
    const blockCenter = b.left + b.width / 2;
    let nearestIdx = 0;
    let nearestDist = Math.abs(blockCenter - columnAnchors[0]);
    for (let i = 1; i < columnAnchors.length; i++) {
      const d = Math.abs(blockCenter - columnAnchors[i]);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    columnBuckets[nearestIdx].push(b);
  }

  // Step 4: stratify spanning blocks (top / middle / bottom).
  const topSpanning: TextBlock[] = [];
  const middleSpanning: TextBlock[] = [];
  const bottomSpanning: TextBlock[] = [];
  for (const b of spanning) {
    if (b.top < TOP_STRATA_END) topSpanning.push(b);
    else if (b.top >= BOTTOM_STRATA_START) bottomSpanning.push(b);
    else middleSpanning.push(b);
  }

  // Step 5: sort each bucket by top-coordinate.
  topSpanning.sort((a, b) => a.top - b.top);
  middleSpanning.sort((a, b) => a.top - b.top);
  bottomSpanning.sort((a, b) => a.top - b.top);
  for (const bucket of columnBuckets) {
    bucket.sort((a, b) => a.top - b.top);
  }

  // Step 6: emit in reading order:
  //   top-spanning → column-1 (with middle-spanning interleaved at y) →
  //   column-2 → ... → column-N → bottom-spanning
  const lines: string[] = [];

  for (const b of topSpanning) lines.push(b.text);

  // Merge middle-spanning into column-1 stream at their y-position.
  // Other columns emit pure (middle-spanning is page-wide so it conceptually
  // belongs once — attach to the first column emission).
  const col1WithMiddle = interleaveByTop(columnBuckets[0], middleSpanning);
  for (const b of col1WithMiddle) lines.push(b.text);

  for (let i = 1; i < columnBuckets.length; i++) {
    for (const b of columnBuckets[i]) lines.push(b.text);
  }

  for (const b of bottomSpanning) lines.push(b.text);

  return {
    pageNumber,
    text: lines.join("\n"),
    layoutType: columnCount === 2 ? "multi-column-2" : columnCount === 3 ? "multi-column-3" : "unknown",
    columnCount,
    blocks,
  };
}

/**
 * Reflow an entire document. Pages joined with double-newlines so downstream
 * section regex (which often anchors on \n\n) keeps working.
 */
export function reflowDocument(
  pages: { pageNumber: number; blocks: TextBlock[] }[],
): {
  text: string;
  perPage: ReflowedPage[];
  documentLayoutType: LayoutType;
} {
  const perPage = pages.map((p) => reflowPageBlocks(p.pageNumber, p.blocks));
  const text = perPage.map((p) => p.text).join("\n\n");

  // Document-level layout = most common multi-column page type, or single-column
  // if no page is multi-column.
  const counts: Record<LayoutType, number> = {
    "single-column": 0,
    "multi-column-2": 0,
    "multi-column-3": 0,
    empty: 0,
    unknown: 0,
  };
  for (const p of perPage) counts[p.layoutType]++;

  let documentLayoutType: LayoutType = "single-column";
  if (counts["multi-column-3"] > 0 && counts["multi-column-3"] >= counts["multi-column-2"]) {
    documentLayoutType = "multi-column-3";
  } else if (counts["multi-column-2"] > 0) {
    documentLayoutType = "multi-column-2";
  } else if (counts["single-column"] === 0 && counts.empty === perPage.length) {
    documentLayoutType = "empty";
  }

  return { text, perPage, documentLayoutType };
}

/**
 * Build a histogram of x-coordinates and identify column anchor positions.
 * Returns an array of anchor x-positions (block centers, normalized [0, 1])
 * sorted left-to-right. Empty array if no clear column structure.
 */
function detectColumnAnchors(blocks: TextBlock[]): number[] {
  if (blocks.length === 0) return [];

  // Histogram on block CENTER x-position (not just `left`) — better captures
  // where text actually sits on the page.
  const buckets = new Map<number, number>();
  for (const b of blocks) {
    const center = b.left + b.width / 2;
    const bucketIdx = Math.floor(center / BUCKET_SIZE);
    buckets.set(bucketIdx, (buckets.get(bucketIdx) || 0) + 1);
  }

  const minPeakCount = Math.max(2, Math.floor(blocks.length * MIN_PEAK_DENSITY));

  // Find local maxima: buckets with count >= minPeakCount AND higher than
  // both neighbors (or at the histogram edge).
  const peaks: { center: number; count: number }[] = [];
  for (const [bucketIdx, count] of buckets.entries()) {
    if (count < minPeakCount) continue;
    const leftCount = buckets.get(bucketIdx - 1) || 0;
    const rightCount = buckets.get(bucketIdx + 1) || 0;
    if (count >= leftCount && count >= rightCount) {
      peaks.push({
        center: (bucketIdx + 0.5) * BUCKET_SIZE,
        count,
      });
    }
  }

  // De-duplicate peaks that are too close (within MIN_PEAK_GAP).
  peaks.sort((a, b) => a.center - b.center);
  const deduped: { center: number; count: number }[] = [];
  for (const p of peaks) {
    const prev = deduped[deduped.length - 1];
    if (!prev || p.center - prev.center >= MIN_PEAK_GAP) {
      deduped.push(p);
    } else if (p.count > prev.count) {
      // Keep the taller peak of the pair.
      deduped[deduped.length - 1] = p;
    }
  }

  return deduped.map((p) => p.center);
}

/**
 * Merge two y-sorted block streams by top-coordinate. Used to interleave
 * middle-spanning blocks into column-1 at their natural y-position.
 */
function interleaveByTop(primary: TextBlock[], inserts: TextBlock[]): TextBlock[] {
  if (inserts.length === 0) return primary;
  const merged: TextBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < primary.length && j < inserts.length) {
    if (primary[i].top <= inserts[j].top) {
      merged.push(primary[i++]);
    } else {
      merged.push(inserts[j++]);
    }
  }
  while (i < primary.length) merged.push(primary[i++]);
  while (j < inserts.length) merged.push(inserts[j++]);
  return merged;
}
