/**
 * Coverage snapshot + diff helpers (S111 smoke iteration 5).
 *
 * When the user changes the bound canonical plan for a dispute, we want to
 * surface what changed in coverage AND whether the dispute is still valid
 * under the new plan. The mechanism:
 *
 *   1. Before applying a new bind, the bind endpoint captures the CURRENT
 *      per-line coverage state into `dispute.metadata.preBindCoverageSnapshot`
 *      via `captureCoverageSnapshot`.
 *   2. On the next GET, the handler computes the AFTER snapshot from fresh
 *      evidence + diffs against the stored before-snapshot via
 *      `diffCoverageSnapshots`. The diff is surfaced in the GET response.
 *   3. The user dismisses the diff panel (or cancels the dispute) via
 *      `POST /api/disputes/[id]/clear-coverage-diff`, which clears the
 *      stored snapshot so future GETs don't keep re-surfacing the same diff.
 *
 * Verdict classifier maps the diff to one of three states:
 *   - `still_valid`  — coverage still supports the disputed amount; numbers
 *                      may shift but dispute proceeds
 *   - `weakened`     — total expected discrepancy reduced materially (>50%)
 *                      but not zero
 *   - `invalidated`  — new plan supports the bill as charged (no remaining
 *                      discrepancy) OR no coverage on disputed services
 *
 * Pattern 1 #2 alignment: the snapshot is captured per line item with the
 * `sourcedFrom` + `sourcedFromYear` tags from `evidence-resolver`, so the
 * diff display honestly attributes each value to its source (user_exact /
 * canonical_archive / user_fallback).
 */

import type { DisputeEvidence } from "./evidence-resolver";
import type { PlanContext } from "./plan-context";

export type CoverageSource =
  | "user_exact"
  | "canonical_archive"
  | "user_fallback"
  | "no_coverage";

export interface CoverageSnapshotLine {
  lineItemId: string;
  serviceName: string;
  billingCode: string | null;
  billingCodeType: string | null;
  billedAmount: number;
  patientOwes: number | null;
  covered: boolean | null;
  copay: number | null;
  coinsurance: number | null;
  source: string | null;
  sourceYear: number | null;
  discrepancy: number | null;
}

export interface CoverageSnapshot {
  capturedAt: string;
  insurerName: string | null;
  planName: string | null;
  planYear: number | null;
  source: CoverageSource;
  lines: CoverageSnapshotLine[];
}

export function captureCoverageSnapshot(
  evidence: DisputeEvidence | null,
  planContext: PlanContext | null,
): CoverageSnapshot {
  const lines: CoverageSnapshotLine[] = [];
  if (evidence) {
    for (const claim of evidence.claims) {
      for (const li of claim.lineItemEvidence) {
        lines.push({
          lineItemId: li.lineItemId,
          serviceName: li.serviceName,
          billingCode: li.billingCode?.value ?? null,
          billingCodeType: li.billingCode?.type ?? null,
          billedAmount: li.billedAmount,
          patientOwes: li.patientOwes,
          covered: li.planBenefit?.covered ?? null,
          copay: li.planBenefit?.copay ?? null,
          coinsurance: li.planBenefit?.coinsurance ?? null,
          source: li.planBenefit?.sourcedFrom ?? null,
          sourceYear: li.planBenefit?.sourcedFromYear ?? null,
          discrepancy: li.discrepancyAmount ?? null,
        });
      }
    }
  }

  // Derive snapshot-level source from line items. If all lines agree on a
  // single source tag, use it. Otherwise fall back to `no_coverage` (mixed
  // or empty).
  const sources = new Set(
    lines.map((l) => l.source).filter((s): s is string => s !== null),
  );
  let source: CoverageSource = "no_coverage";
  if (sources.size === 1) {
    const only = Array.from(sources)[0];
    if (
      only === "user_exact" ||
      only === "canonical_archive" ||
      only === "user_fallback"
    ) {
      source = only;
    }
  }

  // Plan-level metadata for the snapshot header. Precedence mirrors the
  // letter template's insurer chain (planContext.insurer wins, but
  // fall through to fallback / bound for offline-readable snapshots).
  return {
    capturedAt: new Date().toISOString(),
    insurerName:
      planContext?.insurer?.name ??
      planContext?.boundCanonicalPlan?.insurerName ??
      planContext?.fallbackPlan?.insurerName ??
      planContext?.plan?.insurerName ??
      null,
    planName:
      planContext?.plan?.planName ??
      planContext?.boundCanonicalPlan?.planName ??
      planContext?.fallbackPlan?.planName ??
      null,
    planYear:
      planContext?.plan?.planYear ??
      planContext?.boundCanonicalPlan?.planYear ??
      planContext?.fallbackPlan?.planYear ??
      null,
    source,
    lines,
  };
}

export type CoverageDiffChange =
  | "unchanged"
  | "updated"
  | "coverage_added"
  | "coverage_removed";

export interface CoverageDiffLine {
  lineItemId: string;
  serviceName: string;
  billingCode: string | null;
  billingCodeType: string | null;
  change: CoverageDiffChange;
  before: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    sourceYear: number | null;
  } | null;
  after: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    sourceYear: number | null;
  } | null;
  beforeDiscrepancy: number | null;
  afterDiscrepancy: number | null;
}

export type CoverageDiffVerdict = "still_valid" | "weakened" | "invalidated";

export interface CoverageDiff {
  verdict: CoverageDiffVerdict;
  verdictReason: string;
  before: {
    insurerName: string | null;
    planName: string | null;
    planYear: number | null;
    source: CoverageSource;
  };
  after: {
    insurerName: string | null;
    planName: string | null;
    planYear: number | null;
    source: CoverageSource;
  };
  lines: CoverageDiffLine[];
  totalBeforeDiscrepancy: number;
  totalAfterDiscrepancy: number;
}

/**
 * S111 smoke #7 — predicate for "is this diff worth surfacing to the user?"
 * Returns false when the before/after snapshots are functionally identical
 * (e.g., user re-bound to the same canonical, or bound a canonical that has
 * no coverage rows in canonical_plan_services — both snapshots end up
 * `no_coverage` with no per-line data). Without this guard, the
 * CoverageDiffPanel renders a confusing $0 → $0 / "no coverage cited"
 * before-and-after card with a "still valid" verdict, despite literally
 * nothing having changed.
 *
 * Meaningful change means ANY of:
 *   - Plan identity differs (insurer / plan name / plan year)
 *   - At least one line changed (covered, copay, coinsurance, etc.)
 *   - Total discrepancy changed
 */
export function isMeaningfulCoverageDiff(diff: CoverageDiff): boolean {
  if (diff.before.planName !== diff.after.planName) return true;
  if (diff.before.planYear !== diff.after.planYear) return true;
  if (diff.before.insurerName !== diff.after.insurerName) return true;
  if (diff.before.source !== diff.after.source) return true;
  if (diff.lines.some((l) => l.change !== "unchanged")) return true;
  if (diff.totalBeforeDiscrepancy !== diff.totalAfterDiscrepancy) return true;
  return false;
}

export function diffCoverageSnapshots(
  before: CoverageSnapshot,
  after: CoverageSnapshot,
): CoverageDiff {
  const beforeByLine = new Map(before.lines.map((l) => [l.lineItemId, l]));
  const afterByLine = new Map(after.lines.map((l) => [l.lineItemId, l]));

  const allLineIds = new Set<string>([
    ...beforeByLine.keys(),
    ...afterByLine.keys(),
  ]);

  const lines: CoverageDiffLine[] = [];

  for (const lineId of allLineIds) {
    const b = beforeByLine.get(lineId);
    const a = afterByLine.get(lineId);
    const beforeHadCoverage = b?.covered === true;
    const afterHasCoverage = a?.covered === true;

    let change: CoverageDiffChange;
    if (!b && a) {
      change = afterHasCoverage ? "coverage_added" : "unchanged";
    } else if (b && !a) {
      change = beforeHadCoverage ? "coverage_removed" : "unchanged";
    } else if (b && a) {
      if (!beforeHadCoverage && afterHasCoverage) change = "coverage_added";
      else if (beforeHadCoverage && !afterHasCoverage) change = "coverage_removed";
      else {
        const changed =
          b.copay !== a.copay ||
          b.coinsurance !== a.coinsurance ||
          b.covered !== a.covered;
        change = changed ? "updated" : "unchanged";
      }
    } else {
      change = "unchanged";
    }

    lines.push({
      lineItemId: lineId,
      serviceName: a?.serviceName ?? b?.serviceName ?? "",
      billingCode: a?.billingCode ?? b?.billingCode ?? null,
      billingCodeType: a?.billingCodeType ?? b?.billingCodeType ?? null,
      change,
      before: b
        ? {
            covered: b.covered,
            copay: b.copay,
            coinsurance: b.coinsurance,
            sourceYear: b.sourceYear,
          }
        : null,
      after: a
        ? {
            covered: a.covered,
            copay: a.copay,
            coinsurance: a.coinsurance,
            sourceYear: a.sourceYear,
          }
        : null,
      beforeDiscrepancy: b?.discrepancy ?? null,
      afterDiscrepancy: a?.discrepancy ?? null,
    });
  }

  // Verdict classifier — simple aggregate over remaining discrepancy.
  const totalBefore = lines.reduce((s, l) => s + (l.beforeDiscrepancy ?? 0), 0);
  const totalAfter = lines.reduce((s, l) => s + (l.afterDiscrepancy ?? 0), 0);
  const linesWithCoverageBefore = lines.filter((l) => l.before?.covered === true);
  const linesWithCoverageAfter = lines.filter((l) => l.after?.covered === true);
  const allLostCoverage =
    linesWithCoverageBefore.length > 0 && linesWithCoverageAfter.length === 0;

  let verdict: CoverageDiffVerdict;
  let verdictReason: string;

  if (allLostCoverage) {
    verdict = "invalidated";
    verdictReason =
      "The new plan does not appear to cover the disputed services. Your dispute may not be supported by this plan.";
  } else if (totalBefore > 0 && totalAfter === 0) {
    verdict = "invalidated";
    verdictReason =
      "Under the new plan, the bill amount matches what you owe — no remaining discrepancy. Your dispute may no longer apply.";
  } else if (totalBefore > 0 && totalAfter < totalBefore * 0.5) {
    verdict = "weakened";
    verdictReason = `Expected discrepancy reduced from $${totalBefore.toFixed(2)} to $${totalAfter.toFixed(2)} under the new plan.`;
  } else {
    verdict = "still_valid";
    verdictReason =
      totalAfter > 0
        ? `Dispute still supported. Expected discrepancy: $${totalAfter.toFixed(2)}.`
        : "Coverage details updated; the dispute proceeds with the new plan terms.";
  }

  return {
    verdict,
    verdictReason,
    before: {
      insurerName: before.insurerName,
      planName: before.planName,
      planYear: before.planYear,
      source: before.source,
    },
    after: {
      insurerName: after.insurerName,
      planName: after.planName,
      planYear: after.planYear,
      source: after.source,
    },
    lines,
    totalBeforeDiscrepancy: totalBefore,
    totalAfterDiscrepancy: totalAfter,
  };
}
