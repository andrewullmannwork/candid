/**
 * R3 step 2 — DETECTOR_REGISTRY: the audit detectors as ONE ORDERED PIPELINE.
 *
 * Before this, `runAudit` ran detectors as two ad-hoc groups: a loop over the 5 sync `ALL_RULES`
 * (rules.ts) + 4 hand-written inline async calls, with the `insurance_underpayment`→`zero_cost_share`
 * skip threaded by a manually-built line-number Set. This registry unifies all 9 into a single
 * ordered list that `runAudit` walks in one loop. Each detector sees the findings accumulated by
 * EARLIER detectors via `ctx.priorFindings`, so cross-detector ordering deps (today: F-14 skipping
 * lines D13 already fired on) are first-class instead of hand-wired.
 *
 * BYTE-IDENTICAL to the pre-refactor `runAudit`: same 9 detector FUNCTIONS, same ORDER, same args.
 * `linesFiredBy(priorFindings, ["zero_cost_share_overcharge"])` reproduces the old
 * `d13FiredLineNumbers` exactly (only D13 emits that type among the detectors that run before F-14).
 * Behavior changes (e.g. broadening the skip to "any prior detector" — which would WRONGLY suppress
 * insurance_underpayment on overcharged lines) are deliberate, separately-gated, and NOT here.
 *
 * NOTE: `auditContext` is intentionally NOT in `DetectorContext` — no detector reads it; the cohort
 * accuracy adjustment that uses it runs AFTER the loop (index.ts). Keeping it out means this module
 * never imports from `./index` → no import cycle.
 *
 * See [[unified_dispute_claim_engine_plan]] §2 R3.
 */
import type { AuditFinding, CMSPPLRate, FindingType, ParsedBill } from "../billing/types";
import type { AcaFallbackLineCoverageMap, PlanCoverageMap } from "./coverage-loader";
import {
  checkOvercharges,
  checkDuplicates,
  checkBalanceBilling,
  checkUnbundling,
  checkMissingAdjustments,
} from "./rules";
import { runZeroCostShareCheck } from "./zero-cost-share";
import { runClaimHeaderArithmeticCheck } from "./claim-header-arithmetic";
import { runInsuranceUnderpaymentCheck } from "./insurance-underpayment";
import { runDescriptionMatchCheck } from "./description-service-match";

export interface DetectorContext {
  bill: ParsedBill;
  benchmarks: Map<string, CMSPPLRate>;
  planCoverage: PlanCoverageMap | null;
  acaFallback: AcaFallbackLineCoverageMap | null;
  /** Findings accumulated by EARLIER detectors in the pipeline — the only cross-detector state. */
  priorFindings: readonly AuditFinding[];
}

export interface Detector {
  /** Stable id (named by finding/function domain, e.g. "overcharge", not the dispute-ground name). */
  key: string;
  /** The finding type(s) this detector can emit. */
  emits: FindingType[];
  /**
   * Finding types this detector READS from `priorFindings` (its ordering dependency). Asserted at
   * module load to be emitted by an EARLIER detector — so a future reorder that breaks the dep
   * fails loud instead of silently changing behavior.
   */
  consumesFindingTypes?: FindingType[];
  run: (ctx: DetectorContext) => AuditFinding[] | Promise<AuditFinding[]>;
}

/**
 * Line numbers that findings of the given type(s) fired on — the cross-detector skip-set. Mirrors
 * the pre-refactor `new Set(zeroCostFindings.flatMap(f => Array.isArray(f.lineItems) ? f.lineItems : []))`
 * (same `Array.isArray` guard) so the F-14 skip is byte-identical.
 */
export function linesFiredBy(
  prior: readonly AuditFinding[],
  types: readonly FindingType[],
): Set<number> {
  const want = new Set(types);
  const out = new Set<number>();
  for (const f of prior) {
    if (!want.has(f.type)) continue;
    if (Array.isArray(f.lineItems)) {
      for (const n of f.lineItems) out.add(n);
    }
  }
  return out;
}

/** The single source of skip-set type(s) for F-14 — used by BOTH its declaration and its run. */
const F14_CONSUMES: FindingType[] = ["zero_cost_share_overcharge"];

/**
 * The ordered pipeline. ORDER IS LOAD-BEARING (it reproduces the pre-refactor sequence exactly +
 * satisfies the F-14→D13 dependency). The 5 sync rules are called with the full 4-arg shape exactly
 * as the old `ALL_RULES` loop did (rules that ignore later args are unaffected).
 */
export const DETECTOR_REGISTRY: Detector[] = [
  {
    key: "overcharge",
    emits: ["overcharge"],
    run: (ctx) => checkOvercharges(ctx.bill, ctx.benchmarks, ctx.planCoverage, ctx.acaFallback),
  },
  {
    key: "duplicate",
    emits: ["duplicate"],
    run: (ctx) => checkDuplicates(ctx.bill, ctx.benchmarks, ctx.planCoverage, ctx.acaFallback),
  },
  {
    key: "balance_billing",
    emits: ["balance_billing"],
    run: (ctx) => checkBalanceBilling(ctx.bill, ctx.benchmarks, ctx.planCoverage, ctx.acaFallback),
  },
  {
    key: "unbundling",
    emits: ["unbundling"],
    run: (ctx) => checkUnbundling(ctx.bill, ctx.benchmarks, ctx.planCoverage, ctx.acaFallback),
  },
  {
    key: "missing_adjustment",
    emits: ["missing_adjustment"],
    run: (ctx) => checkMissingAdjustments(ctx.bill, ctx.benchmarks, ctx.planCoverage, ctx.acaFallback),
  },
  {
    key: "zero_cost_share",
    emits: ["zero_cost_share_overcharge"],
    run: (ctx) => runZeroCostShareCheck(ctx.bill, ctx.planCoverage),
  },
  {
    key: "unallocated_balance",
    emits: ["unallocated_balance"],
    run: (ctx) => runClaimHeaderArithmeticCheck(ctx.bill),
  },
  {
    key: "insurance_underpayment",
    emits: ["insurance_underpayment"],
    consumesFindingTypes: F14_CONSUMES, // skip lines D13 (zero_cost_share) already fired on
    run: (ctx) =>
      runInsuranceUnderpaymentCheck(
        ctx.bill,
        ctx.planCoverage,
        ctx.acaFallback,
        linesFiredBy(ctx.priorFindings, F14_CONSUMES),
      ),
  },
  {
    key: "description_match",
    emits: ["code_uncategorized_description_match", "uncategorized_service"],
    run: (ctx) => runDescriptionMatchCheck(ctx.bill),
  },
];

/**
 * Load-time invariant: every `consumesFindingTypes` entry must be emitted by an EARLIER detector.
 * Catches a future reorder that would silently break a cross-detector skip (e.g. moving F-14 before D13).
 */
(function assertDetectorOrdering() {
  const emittedSoFar = new Set<FindingType>();
  for (const d of DETECTOR_REGISTRY) {
    for (const consumed of d.consumesFindingTypes ?? []) {
      if (!emittedSoFar.has(consumed)) {
        throw new Error(
          `DETECTOR_REGISTRY ordering violation: "${d.key}" consumes "${consumed}" but no earlier detector emits it`,
        );
      }
    }
    for (const e of d.emits) emittedSoFar.add(e);
  }
})();
