/**
 * Subtractive boilerplate cleanup for plan_doc Haiku parser (S72 commit 7).
 *
 * Strips predictable boilerplate (TOC region + page headers/footers) from plan
 * document text so per-section Haiku dispatch sees denser semantic content. Per
 * S72-COMMIT-7 user direction: invert regex usage from "find where the data is"
 * (hard — vocabulary varies wildly) to "find what to throw away" (easier —
 * boilerplate has predictable shapes across all insurers).
 *
 * Conservative bias: when in doubt, KEEP. False positives (stripping real
 * content) are catastrophic; false negatives (leaving harmless boilerplate)
 * cost a few extra Haiku tokens.
 *
 * Strips:
 *   - Table of Contents region (contiguous run of "Chapter X......Page N" lines)
 *   - Page headers/footers (lines repeating ≥3 times across doc with page-furniture
 *     characteristics: "Page X of Y" / URL / all-caps insurer name)
 *
 * Does NOT strip (per S72-COMMIT-7 user direction — legal boilerplate matters for disputes):
 *   - Definitions section (legal definitions cited in disputes)
 *   - Plan terms / exclusions / appeals procedures / coverage details
 *   - Plan-identity scalars / per-service cost-sharing / access instructions
 *   - ALL legal boilerplate (ERISA language, COB rules, state-mandated notices)
 *
 * S73 follow-up candidates (deferred):
 *   - Cover-page detection (rare in observed fixtures; risky vs SBC pages)
 *   - Index detection (alphabetical term + page tables; risky vs definitions section)
 */

export interface CleanupResult {
  cleanedText: string;
  originalLineCount: number;
  cleanedLineCount: number;
  strippedLineCount: number;
  warnings: string[];
}

// ── TOC detection ───────────────────────────────────────────────────────────

const TOC_LINE_PATTERNS: RegExp[] = [
  // Lines ending in dots + page number: "Chapter 1: Introduction.........Page 5"
  // OR "Definitions ................. 12"
  /^.{3,}\.{3,}\s*\d+\s*$/,
  // Chapter/Section/Part/Appendix headers with page numbers at end:
  // "Chapter 4. Medical Benefits ..... 25", "Section 5.2 Appeals ... 47"
  /^\s*(Chapter|Section|Part|Appendix)\s+[\dIVXivx]+[\.\:]?\s+.+\s+\d+\s*$/i,
];

const TOC_MIN_CONSECUTIVE_LINES = 5;

function detectTOCRegions(lines: string[]): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  let runLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const isTOC = TOC_LINE_PATTERNS.some((p) => p.test(lines[i]));
    if (isTOC) {
      if (runStart < 0) runStart = i;
      runLength++;
    } else {
      if (runLength >= TOC_MIN_CONSECUTIVE_LINES && runStart >= 0) {
        regions.push({ start: runStart, end: runStart + runLength });
      }
      runStart = -1;
      runLength = 0;
    }
  }
  if (runLength >= TOC_MIN_CONSECUTIVE_LINES && runStart >= 0) {
    regions.push({ start: runStart, end: runStart + runLength });
  }
  return regions;
}

// ── Repeated page-furniture detection ───────────────────────────────────────

const FURNITURE_MIN_OCCURRENCES = 3;
const FURNITURE_LINE_MIN_CHARS = 5;
const FURNITURE_LINE_MAX_CHARS = 100;

function looksLikePageFurniture(line: string): boolean {
  // Page X of Y / Page X
  if (/Page\s+\d+(\s+of\s+\d+)?/i.test(line)) return true;
  // URL or domain
  if (/https?:\/\/|www\.|\.com\b|\.org\b|\.net\b|\.gov\b/i.test(line)) return true;
  // All-caps insurer name (e.g., "CIGNA HEALTH AND LIFE INSURANCE COMPANY")
  if (/^[A-Z][A-Z\s\d\-\.&,]{4,}$/.test(line.trim())) return true;
  // Phone number patterns (often in footers)
  if (/^\s*1[-\s]?[\(]?\d{3}[\)]?[-\s]?\d{3}[-\s]?\d{4}\s*$/.test(line)) return true;
  return false;
}

function detectRepeatedFurniture(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < FURNITURE_LINE_MIN_CHARS || trimmed.length > FURNITURE_LINE_MAX_CHARS) {
      continue;
    }
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  const repeated = new Set<string>();
  for (const [line, count] of counts) {
    if (count < FURNITURE_MIN_OCCURRENCES) continue;
    if (looksLikePageFurniture(line)) {
      repeated.add(line);
    }
  }
  return repeated;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip TOC regions + repeating page furniture from plan document text. Returns
 * cleaned text + diagnostic counts.
 *
 * Pattern P-8 verifier should receive the CLEANED text (not original ocrText)
 * because section ranges + per-section Haiku dispatch operate in cleaned-text
 * coordinates. Excerpts that Haiku emits will be from cleaned content; verifier
 * checks substring match in cleaned text. (Stripped boilerplate isn't worth
 * extracting per Pattern P-8 hard rule, so verifier doesn't need to handle it.)
 */
export function cleanupBoilerplate(text: string): CleanupResult {
  const warnings: string[] = [];
  const lines = text.split("\n");
  const originalLineCount = lines.length;

  // Step 1: TOC region detection
  const tocRegions = detectTOCRegions(lines);
  const tocLineSet = new Set<number>();
  for (const region of tocRegions) {
    for (let i = region.start; i < region.end; i++) {
      tocLineSet.add(i);
    }
    warnings.push(`subtractive_cleanup_toc_region:lines_${region.start}-${region.end}`);
  }

  // Step 2: Repeated page furniture detection
  const repeatedLines = detectRepeatedFurniture(lines);
  if (repeatedLines.size > 0) {
    warnings.push(`subtractive_cleanup_repeated_furniture:${repeatedLines.size}_unique_patterns`);
  }

  // Step 3: Filter
  let strippedLineCount = 0;
  const cleanedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (tocLineSet.has(i)) {
      strippedLineCount++;
      continue;
    }
    if (repeatedLines.has(lines[i].trim())) {
      strippedLineCount++;
      continue;
    }
    cleanedLines.push(lines[i]);
  }

  return {
    cleanedText: cleanedLines.join("\n"),
    originalLineCount,
    cleanedLineCount: cleanedLines.length,
    strippedLineCount,
    warnings,
  };
}
