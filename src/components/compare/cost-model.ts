/**
 * Compare v2 (S156) — pure cost + verdict helpers.
 *
 * Frontend-owned display/derivation math for the /compare redesign. Consumes the
 * existing `ComparePlanPayload` (from /api/plan/compare) — NO backend calls. All
 * scalar reads go through `asNumber`/`unwrapValue` because cost-share values are
 * `DecoratedValue` wrappers when `consumer_read_filter_v1` is ON (raw when OFF).
 *
 * Spec: plans/compare_v2_redesign.md §4.3 + §5. Coinsurance is stored decimal
 * [0,1]; normalized via src/lib/billing/coinsurance.ts.
 */
import { unwrapValue } from "@/components/display-state";
import { normalizeCoinsuranceDecimal } from "@/lib/billing/coinsurance";
import type { CompareBenefit } from "@/lib/plan/compare";
import { asNumber } from "./compare-aggregates";

export type NetworkTier = "inNetwork" | "outOfNetwork";

/** Normalized single-tier cost rule for one service under one plan. */
export interface CostRule {
  /** Flat copay in whole dollars, or null when none/unknown. */
  copay: number | null;
  /** Coinsurance as a decimal in [0,1] (0.2 = 20%), or null. */
  coinsurance: number | null;
  /** Whether the plan deductible applies before this benefit pays. */
  deductibleApplies: boolean;
  /** Tri-state covered flag from the payload (null = unknown). */
  covered: boolean | null;
}

/** Normalize one network tier of a CompareBenefit into a typed CostRule. */
export function toRule(benefit: CompareBenefit, tier: NetworkTier): CostRule {
  const side = benefit.costSharing?.[tier];
  const copay = side ? asNumber(side.copay) : null;
  const coinsRaw = side ? asNumber(side.coinsurance) : null;
  return {
    copay,
    coinsurance: coinsRaw == null ? null : normalizeCoinsuranceDecimal(coinsRaw),
    deductibleApplies: side?.deductibleApplies === true,
    covered: benefit.covered,
  };
}

export type CellState = "ok" | "na" | "nc" | "unk";

/**
 * Classify a benefit cell into one semantic empty-state (compare_v2 §4.3).
 *
 * Precision rule (data-trust): `na` fires ONLY on a positive structural signal —
 * an out-of-network tier on an HMO/EPO (which by design has no OON). Every other
 * missing value is `unk` ("not listed yet"), never `na`. `nc` = explicit exclusion.
 * (Conservative edge: covered===true with no copay/coins still reads `unk` — we
 * have no cost detail to show; the copay-mode description string covers display.)
 */
export function cellState(
  benefit: CompareBenefit,
  tier: NetworkTier,
  planType: string | null,
): CellState {
  if (benefit.covered === false) return "nc";
  const rule = toRule(benefit, tier);
  if (rule.copay != null || rule.coinsurance != null) return "ok";
  if (tier === "outOfNetwork") {
    const pt = (planType ?? "").toUpperCase();
    if (pt === "HMO" || pt === "EPO") return "na";
  }
  return "unk";
}

/** Read a (possibly decorated) plan_type into a plain string. */
export function planTypeOf(planSummaryPlanType: unknown): string | null {
  return unwrapValue<string | null>(planSummaryPlanType as never) ?? null;
}

export interface PlanCostBasis {
  /** In-network individual deductible (whole $); 0 when none/unknown. */
  deductible: number;
  /** In-network individual OOP max (whole $); null = no known ceiling. */
  oop: number | null;
}

export interface PayResult {
  /** Member's share in whole dollars, or null when not computable (unk/na). */
  pay: number | null;
  note: string | null;
}

/**
 * What the member pays for a single bill of `billed` under one rule (bill mode).
 * Mirrors the design prototype's payFor, typed to CostRule. Deliberate divergences
 * (compare_v2 §3, data-trust correctness):
 *   - No per-service coinsurance `cap` (our schema doesn't store one).
 *   - Not-covered is NOT OOP-capped (non-covered spend doesn't count toward OOP).
 */
export function payFor(
  rule: CostRule,
  plan: PlanCostBasis,
  billed: number,
  dedMet: boolean,
): PayResult {
  const B = Math.max(0, Number.isFinite(billed) ? billed : 0);
  if (rule.covered === false) {
    return { pay: Math.round(B), note: "not covered — you pay in full" };
  }
  if (rule.copay == null && rule.coinsurance == null) {
    return { pay: null, note: null }; // unknown structure → caller renders empty state
  }
  const D = dedMet ? 0 : Math.max(0, plan.deductible || 0);
  let pay = 0;
  let note: string | null = null;

  if (rule.deductibleApplies) {
    if (B <= D) {
      pay = B;
      note = "applied to deductible";
    } else {
      const rem = B - D;
      const coinsPart = rule.coinsurance != null ? rem * rule.coinsurance : 0;
      const copayPart = rule.copay != null ? rule.copay : 0;
      pay = D + coinsPart + copayPart;
      if (D > 0) note = `incl. $${Math.round(D).toLocaleString()} deductible`;
    }
  } else if (rule.copay != null && rule.coinsurance != null) {
    pay = rule.copay + Math.max(0, B - rule.copay) * rule.coinsurance;
  } else if (rule.copay != null) {
    pay = Math.min(rule.copay, B);
  } else {
    pay = B * (rule.coinsurance as number);
  }

  if (plan.oop != null && pay > plan.oop) {
    pay = plan.oop;
    note = "out-of-pocket max reached";
  }
  return { pay: Math.round(pay), note };
}

export type Badge = "best" | "worst" | null;

/**
 * Tie-aware Best/Priciest assignment (compare_v2 §5).
 * `vals`: comparable numbers, lower = better; non-finite (Infinity/NaN) excluded.
 *   2-plan      → Best on the lower only (no Priciest).
 *   3+ distinct → Best on min, Priciest on max.
 *   2 tie best  → no Best; Priciest on the single max.
 *   2 tie worst → no Priciest; Best on the single min.
 *   all equal   → no badges.
 */
export function rankBadges(vals: number[]): Badge[] {
  const res: Badge[] = vals.map(() => null);
  const live = vals.map((v, i) => ({ v, i })).filter((o) => Number.isFinite(o.v));
  if (live.length < 2) return res;
  const vs = live.map((o) => o.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  if (min === max) return res;
  if (vals.length < 3) {
    live.filter((o) => o.v === min).forEach((o) => (res[o.i] = "best"));
    return res;
  }
  if (vs.filter((v) => v === min).length === 1) res[live.find((o) => o.v === min)!.i] = "best";
  if (vs.filter((v) => v === max).length === 1) res[live.find((o) => o.v === max)!.i] = "worst";
  return res;
}
