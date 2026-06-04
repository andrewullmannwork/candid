/**
 * pii-adjudication-score.ts — Ing-E (PII safety) Phase-1 adjudication scorer.
 *
 * READ-ONLY + INDEPENDENT of the system under test (per feedback_calibration_independence):
 * it ingests Andrew's human-adjudicated sample and never touches the patterns/redactor.
 *
 * PII discipline (feedback_pii_audit_discipline): the input TSV is a LOCAL raw sample.
 * This script emits AGGREGATES ONLY — it NEVER prints the `text` column. PII rows are
 * reported by (surface, row_id UUID, adjudicated pii_types) — identifiers, not content.
 *
 * Usage:
 *   npx tsx scripts/calibration/pii/pii-adjudication-score.ts <adjudicated.tsv>
 *
 * TSV columns (tab-delimited, 1 header row):
 *   surface_id  row_id  field  has_auto_match  auto_patterns  review_patterns
 *   text  is_pii_y_n  pii_types  coverage_corruption_risk_y_n
 */
import * as fs from "fs";

const tsvPath = process.argv[2];
if (!tsvPath) {
  console.error("usage: pii-adjudication-score.ts <adjudicated.tsv>");
  process.exit(1);
}

const C = {
  surface: 0,
  rowId: 1,
  field: 2,
  autoMatch: 3,
  autoPat: 4,
  reviewPat: 5,
  text: 6, // intentionally never emitted
  isPii: 7,
  piiTypes: 8,
  covRisk: 9,
} as const;

const raw = fs.readFileSync(tsvPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const rows = lines.slice(1).map((l) => l.split("\t"));

const cell = (r: string[], i: number) => (r[i] ?? "").trim();
const yes = (s: string) => s.toLowerCase() === "y" || s.toLowerCase() === "yes";
const isAuto = (r: string[]) => yes(cell(r, C.autoMatch)) || cell(r, C.autoPat) !== "";
const isReview = (r: string[]) => cell(r, C.reviewPat) !== "";
const isFlagged = (r: string[]) => isAuto(r) || isReview(r);
const isPii = (r: string[]) => yes(cell(r, C.isPii));
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const total = rows.length;
const autoFlagged = rows.filter(isAuto);
const reviewFlagged = rows.filter(isReview);
const unmatched = rows.filter((r) => !isFlagged(r));
const piiRows = rows.filter(isPii);
const covRiskRows = rows.filter((r) => yes(cell(r, C.covRisk)));

// per review-pattern precision (confirms whether a review pattern should ever go auto)
const perPattern: Record<string, { total: number; pii: number; pii_precision_pct: number | null }> = {};
for (const r of reviewFlagged) {
  const p = cell(r, C.reviewPat) || "(none)";
  (perPattern[p] ??= { total: 0, pii: 0, pii_precision_pct: null }).total++;
  if (isPii(r)) perPattern[p].pii++;
}
for (const p of Object.keys(perPattern)) perPattern[p].pii_precision_pct = pct(perPattern[p].pii, perPattern[p].total);

const summary = {
  source_tsv: tsvPath.split("/").pop(),
  total_rows: total,
  flagged: { auto: autoFlagged.length, review: reviewFlagged.length, unmatched: unmatched.length },
  adjudicated: { pii_rows: piiRows.length, coverage_corruption_risk_rows: covRiskRows.length },
  // PRECISION — auto tier is the hard gate ("zero coverage-token false positive")
  precision: {
    auto_tier_pct: pct(piiRows.filter(isAuto).length, autoFlagged.length),
    review_tier_pct: pct(piiRows.filter(isReview).length, reviewFlagged.length),
  },
  // RECALL — of adjudicated PII, where the patterns landed it
  recall: {
    pii_total: piiRows.length,
    caught_auto: piiRows.filter(isAuto).length,
    caught_review: piiRows.filter(isReview).length,
    missed_unmatched: piiRows.filter((r) => !isFlagged(r)).length,
  },
  per_review_pattern: perPattern,
  // identifiers ONLY — never the `text` column
  pii_rows: piiRows.map((r) => ({
    surface: cell(r, C.surface),
    row_id: cell(r, C.rowId),
    pii_types: cell(r, C.piiTypes) || null,
    coverage_corruption_risk: yes(cell(r, C.covRisk)),
    landed_in: isAuto(r) ? "auto" : isReview(r) ? "review" : "unmatched",
  })),
};

console.log(JSON.stringify(summary, null, 2));
