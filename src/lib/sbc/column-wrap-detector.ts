/**
 * Column-wrap drift heuristic (Ing-H / CF-44, S129).
 *
 * Detects OCR text where pdftotext has interleaved adjacent-column text into
 * the same lines (the column-wrap drift that defeats Pattern P-8 verbatim
 * verification on tabular SBC + EOC layouts).
 *
 * Pure function: input is OCR text, output is column_wrap_score ∈ [0, 1] +
 * a decision struct. No DB. No external deps. Safe to call repeatedly with
 * identical results on identical input.
 *
 * Ownership: lives in src/lib/sbc/ because SBC is the primary use case + the
 * S77 empirical work (Kaiser Gold 80: 74.5% → 97.9% cite-grade with self-check)
 * was SBC-centric. EOC parser imports from here. If PROD telemetry shows EOC
 * needs different tuning, fork into a parser-specific detector at that point.
 *
 * HEURISTIC DESIGN
 *
 * Column-wrap drift signatures in pdftotext output:
 *   1. Alternating short/long lines — adjacent columns of different widths
 *      bleeding into the same line buffer.
 *   2. Sustained vertical whitespace columns — multi-column layouts produce
 *      runs of lines with a consistent "wide gap" in the middle (multiple
 *      consecutive spaces at the same column position).
 *   3. Numeric-fragment density — column-wrapped tabular financial data
 *      tends to interleave "$X / Y%" tokens with prose, producing high
 *      numeric-density runs alongside narrative runs.
 *
 * Score combination: weighted average of three signals, each ∈ [0, 1]. Empty
 * or trivially-short OCR returns 0 (no evidence of drift). Threshold 0.6
 * starting point per Ing-H §5 spec — conservative; raise to 0.7+ if
 * post-soak telemetry shows false-positives clustering above 0.6.
 *
 * Decision contract: when the cf44_selective_self_check flag is OFF
 * (`selectiveEnabled=false`), `fired=true` always (preserves current behavior
 * regardless of score). When flag ON, `fired = score > THRESHOLD`.
 */

export const COLUMN_WRAP_THRESHOLD = 0.6;
export type ParserKind = "sbc" | "eoc";

export interface ColumnWrapDecision {
  score: number;
  fired: boolean;
  parserKind: ParserKind;
  threshold: number;
  flagEnabled: boolean;
  signals: {
    line_length_alternation: number;
    sustained_whitespace_columns: number;
    numeric_density_runs: number;
  };
}

/**
 * Compute the column_wrap_score + self-check fire decision for a given OCR text.
 *
 * @param ocrText     Raw OCR text (the same string Haiku sees).
 * @param parserKind  Which parser is asking ('sbc' | 'eoc').
 * @param selectiveEnabled
 *                    Resolved value of cf44_selective_self_check flag. When
 *                    false, fired=true always (preserves current always-fire
 *                    behavior — Ing-H is a no-op).
 */
export function computeColumnWrapDecision(
  ocrText: string,
  parserKind: ParserKind,
  selectiveEnabled: boolean,
): ColumnWrapDecision {
  const score = computeColumnWrapScore(ocrText);
  const fired = selectiveEnabled ? score > COLUMN_WRAP_THRESHOLD : true;
  return {
    score: Number(score.toFixed(3)),
    fired,
    parserKind,
    threshold: COLUMN_WRAP_THRESHOLD,
    flagEnabled: selectiveEnabled,
    signals: computeSignals(ocrText),
  };
}

/**
 * Pure score computation — exported for unit testing + verification scripts.
 */
export function computeColumnWrapScore(ocrText: string): number {
  if (!ocrText || ocrText.length < 200) return 0;
  const signals = computeSignals(ocrText);
  // Weighted blend (calibrated S129 smoke):
  //   sustained_whitespace_columns (0.6) — PRIMARY signal. pdftotext column-
  //     wrap reliably produces consistent whitespace gaps at the same offset
  //     across runs of lines (where the page's column-break was).
  //   numeric_density_runs (0.3) — CORROBORATING signal. Column-wrap of
  //     cost-sharing tables interleaves $/% tokens producing high-density runs.
  //   line_length_alternation (0.1) — DE-EMPHASIZED. Real column-wrap output
  //     often has uniform-long lines (merged-row format), so alternation
  //     isn't always present even in genuinely garbled docs. Kept low for
  //     cases where header-row vs body-row length contrast IS present.
  // Pre-smoke iteration: previous weights (0.45 / 0.4 / 0.15 on alternation /
  // whitespace / numeric) produced score=0.55 on synthetic column-wrap (just
  // below 0.6 threshold) because alternation was 0.0 on uniform-merged-row
  // sample. Restructured to make whitespace the primary signal.
  return (
    signals.sustained_whitespace_columns * 0.6 +
    signals.numeric_density_runs * 0.3 +
    signals.line_length_alternation * 0.1
  );
}

interface ColumnWrapSignals {
  line_length_alternation: number;
  sustained_whitespace_columns: number;
  numeric_density_runs: number;
}

function computeSignals(ocrText: string): ColumnWrapSignals {
  if (!ocrText || ocrText.length < 200) {
    return {
      line_length_alternation: 0,
      sustained_whitespace_columns: 0,
      numeric_density_runs: 0,
    };
  }

  const lines = ocrText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 20) {
    return {
      line_length_alternation: 0,
      sustained_whitespace_columns: 0,
      numeric_density_runs: 0,
    };
  }

  return {
    line_length_alternation: computeLineLengthAlternation(lines),
    sustained_whitespace_columns: computeSustainedWhitespaceColumns(lines),
    numeric_density_runs: computeNumericDensityRuns(lines),
  };
}

/**
 * Signal 1: alternating short/long lines.
 *
 * Column-wrap produces lines like:
 *   "Office Visit       $30 copay  Coinsurance after deductible"
 *   "Specialist Visit  $50 copay   Coinsurance after deductible"
 *   "X-Ray             $0          50% after deductible"
 * vs clean narrative:
 *   "If you need a doctor's care, you will pay the following amounts."
 *
 * Garbled column-wrap tends to have higher variance in adjacent-line length
 * because column-fragments of different widths bleed in/out. Clean narrative
 * has smoother length distribution.
 *
 * Returns the fraction of consecutive line pairs whose length-ratio exceeds
 * 2x — capped at 1.0. >0.3 indicates likely column-wrap.
 */
function computeLineLengthAlternation(lines: string[]): number {
  let alternationPairs = 0;
  let comparedPairs = 0;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].length;
    const b = lines[i].length;
    if (a < 10 && b < 10) continue; // skip noise lines
    const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
    if (ratio > 2) alternationPairs += 1;
    comparedPairs += 1;
  }
  if (comparedPairs === 0) return 0;
  const rawRate = alternationPairs / comparedPairs;
  // Empirical: clean narrative shows ~10-15% alternation naturally;
  // column-wrap docs show 30%+. Map (0.15-0.5) → (0-1) linearly; clamp.
  return Math.max(0, Math.min(1, (rawRate - 0.15) / (0.5 - 0.15)));
}

/**
 * Signal 2: sustained vertical whitespace columns.
 *
 * Multi-column pdftotext output has runs of lines with a consistent "wide gap"
 * at the same column position (where the page's column-break used to be).
 * Detect by finding lines with >=4 consecutive spaces AND checking if the
 * spaces appear at a similar offset across adjacent lines.
 *
 * Returns 0-1 score — fraction of lines participating in sustained
 * whitespace-column runs of ≥5 consecutive lines.
 */
function computeSustainedWhitespaceColumns(lines: string[]): number {
  // For each line, find positions of long whitespace runs (≥4 spaces).
  const whitespaceOffsets: number[][] = lines.map((line) => {
    const offsets: number[] = [];
    const matches = line.matchAll(/ {4,}/g);
    for (const m of matches) {
      if (m.index !== undefined) offsets.push(m.index);
    }
    return offsets;
  });

  let runLines = 0;
  let i = 0;
  while (i < whitespaceOffsets.length) {
    const offsets = whitespaceOffsets[i];
    if (offsets.length === 0) {
      i += 1;
      continue;
    }
    // Look for a sustained run starting here — same offset (±5 chars
    // tolerance) on ≥5 consecutive lines
    for (const candidateOffset of offsets) {
      let runLength = 1;
      for (let j = i + 1; j < whitespaceOffsets.length; j++) {
        const matched = whitespaceOffsets[j].some(
          (off) => Math.abs(off - candidateOffset) <= 5,
        );
        if (matched) runLength += 1;
        else break;
      }
      if (runLength >= 5) {
        runLines += runLength;
        i += runLength;
        break;
      }
    }
    i += 1;
  }

  const rawRate = runLines / lines.length;
  // Map (0-0.4) → (0-1) linearly; clamp.
  return Math.max(0, Math.min(1, rawRate / 0.4));
}

/**
 * Signal 3: numeric-fragment density runs.
 *
 * Column-wrap of cost-sharing tables interleaves "$X" / "Y%" / "after
 * deductible" tokens with prose. Detect by computing per-line numeric token
 * density + looking for runs of high-density lines.
 *
 * Returns 0-1 score — fraction of lines in runs of ≥3 consecutive lines with
 * numeric-density >=0.15.
 */
function computeNumericDensityRuns(lines: string[]): number {
  const numericDensity = lines.map((line) => {
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return 0;
    const numericTokens = tokens.filter((t) => /[\d%$]/.test(t)).length;
    return numericTokens / tokens.length;
  });

  let runLines = 0;
  let currentRun = 0;
  for (const d of numericDensity) {
    if (d >= 0.15) {
      currentRun += 1;
    } else {
      if (currentRun >= 3) runLines += currentRun;
      currentRun = 0;
    }
  }
  if (currentRun >= 3) runLines += currentRun;

  const rawRate = runLines / lines.length;
  // Map (0-0.3) → (0-1) — caps low because narrative SBCs also have some
  // numeric runs; this signal is the weakest of the three.
  return Math.max(0, Math.min(1, rawRate / 0.3));
}
