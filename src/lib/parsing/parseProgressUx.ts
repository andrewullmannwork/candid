/**
 * Parse-progress UX helpers — the synthetic page-tick mechanic + static tier
 * duration copy.
 *
 * Synthetic mechanic (Andrew direction S100):
 *   - "We cannot keep track of how many pages have been parsed, so instead we
 *     are doing a page every (random select between) 3, 5, 7 or 10 seconds and
 *     incrementing until we get to number of pages minus 1 and then holding
 *     until complete, or if it completes before we have reached the final page
 *     it just skips to complete."
 *   - UnifiedParseScreen owns the tick loop internally; this file just exports
 *     the interval constants + a random-pick helper.
 *
 * Duration copy (`getExpectedDurationCopy`):
 *   - Static tier matched against measured PROD upload times. Used in the
 *     UnifiedParseScreen subtitle for the parsing phase ("About Y minutes —
 *     we meticulously go over every detail...") + the large-doc async-UX
 *     splash subtitle ("careful extraction takes about Y minutes").
 *
 * Cross-reference: plans/s100_processing_flow_refactor §4 — the universal
 * loader contract Andrew confirmed at S100.
 */

import type { DocType } from "@/lib/classifier/doc-type-vocabulary";

// ─── Synthetic page-tick mechanic ───────────────────────────────────────────

/**
 * Random tick intervals for the synthetic "Page X of N" counter. Andrew
 * direction S100: change from S98's {10, 12, 15, 20}s to {3, 5, 7, 10}s —
 * faster pace, less obvious as a timer.
 */
export const SYNTHETIC_TICK_INTERVALS_MS = [3000, 5000, 7000, 10000] as const;

/** Pick a random next tick interval from SYNTHETIC_TICK_INTERVALS_MS. */
export function pickNextTickInterval(): number {
  return SYNTHETIC_TICK_INTERVALS_MS[
    Math.floor(Math.random() * SYNTHETIC_TICK_INTERVALS_MS.length)
  ];
}

// ─── Static tier copy ───────────────────────────────────────────────────────

/**
 * Doc-type × page-count duration tier copy. Tuned against measured PROD upload
 * times. Empirical floor (S91 measurements with PR #74 Bug X Haiku safety net):
 * SBC ~108-140s; small EOB ~30-60s; large EOC (~150 pp) projected 8-12 min.
 *
 * Used by UnifiedParseScreen's parsing-phase subtitle (universal loader per
 * S100 v3) and by the async-UX large-doc splash variant.
 */
export function getExpectedDurationCopy(
  docType: DocType,
  pages: number | null,
): string {
  const p = pages ?? 0;
  switch (docType) {
    case "eob":
      return "30-60 seconds";
    case "itemized_bill":
      return p >= 30 ? "1-3 minutes" : "30-90 seconds";
    case "sbc":
      return "1-3 minutes";
    case "plan_document":
      if (p >= 100) return "8-12 minutes";
      if (p >= 50) return "5-8 minutes";
      if (p >= 30) return "3-5 minutes";
      return "2-4 minutes";
  }
}
