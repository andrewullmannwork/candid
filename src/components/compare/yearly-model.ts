/**
 * Compare v2 (S156) — yearly-cost basket model.
 *
 * Replaces the prototype's blended-rate estimate (which ignored copays). Runs a
 * utilization basket of real service_catalog slugs through each plan's ACTUAL
 * per-service rules, accumulating ONE shared deductible + OOP, applying copay as
 * flat $ and coinsurance as %, $0 for ACA-preventive, capped at OOP. Missing
 * services fall back to the plan's avg coinsurance and are reported via
 * `dataCoverage` so a mostly-fallback estimate never looks confident.
 *
 * Spec: plans/compare_v2_redesign.md §4.2 + §5. Constants are tunable (later
 * mirrored into the compare_v2_redesign flag config). Reference prices are
 * ILLUSTRATIVE (curated MVP; fast-follow = claims-derived medians, k-anon ≥5).
 */
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { asNumber } from "./compare-aggregates";
import { toRule, type CostRule } from "./cost-model";

export type UsageLevel = "healthy" | "average" | "heavy";
export interface BasketItem {
  slug: string;
  qty: number;
}

/**
 * Tunable utilization baskets (real service_catalog slugs from mig 010).
 * Calibrated so total reference-priced spend ≈ $950 / $6k / $45k.
 */
export const USAGE_BASKETS: Record<UsageLevel, BasketItem[]> = {
  healthy: [
    { slug: "annual_physical", qty: 1 },
    { slug: "immunizations", qty: 1 },
    { slug: "pcp_visit", qty: 1 },
    { slug: "diagnostic_test", qty: 1 },
    { slug: "lab_pcp_office", qty: 1 },
    { slug: "generic_rx_tier1", qty: 4 },
  ],
  average: [
    { slug: "annual_physical", qty: 1 },
    { slug: "cancer_screening", qty: 1 },
    { slug: "pcp_visit", qty: 3 },
    { slug: "specialist_visit", qty: 2 },
    { slug: "urgent_care", qty: 1 },
    { slug: "advanced_imaging", qty: 1 },
    { slug: "diagnostic_test", qty: 2 },
    { slug: "lab_pcp_office", qty: 2 },
    { slug: "generic_rx_tier1", qty: 6 },
    { slug: "preferred_brand_rx_tier2", qty: 3 },
    { slug: "pt_rehab", qty: 6 },
    { slug: "mental_health_outpatient", qty: 4 },
  ],
  heavy: [
    { slug: "inpatient_facility", qty: 1 },
    { slug: "inpatient_physician", qty: 1 },
    { slug: "outpatient_surgery_facility", qty: 1 },
    { slug: "outpatient_surgery_physician", qty: 1 },
    { slug: "er_visit", qty: 1 },
    { slug: "advanced_imaging", qty: 2 },
    { slug: "specialist_visit", qty: 6 },
    { slug: "pcp_visit", qty: 4 },
    { slug: "diagnostic_test", qty: 4 },
    { slug: "lab_independent", qty: 4 },
    { slug: "specialty_rx_tier4", qty: 3 },
    { slug: "pt_rehab", qty: 12 },
    { slug: "mental_health_outpatient", qty: 6 },
  ],
};

/**
 * Illustrative reference prices — member-relevant billed $ per unit. MVP curated
 * (national-ish); fast-follow = claims-derived medians (k-anon ≥5). Same prices
 * apply to all compared plans, so the RANKING is robust to absolute price error
 * even though absolute totals are illustrative.
 */
export const REFERENCE_PRICES: Record<string, number> = {
  pcp_visit: 150,
  specialist_visit: 300,
  telehealth_pcp: 60,
  annual_physical: 250,
  preventive_care: 250,
  immunizations: 100,
  cancer_screening: 400,
  well_child_visit: 200,
  er_visit: 2000,
  urgent_care: 200,
  emergency_transport_ground: 1200,
  inpatient_facility: 15000,
  inpatient_physician: 3000,
  outpatient_surgery_facility: 6000,
  outpatient_surgery_physician: 1500,
  diagnostic_test: 250,
  advanced_imaging: 1200,
  radiology_basic: 200,
  lab_pcp_office: 120,
  lab_specialist_office: 120,
  lab_outpatient_facility: 200,
  lab_independent: 120,
  generic_rx_tier1: 20,
  preferred_brand_rx_tier2: 120,
  non_preferred_rx_tier3: 300,
  specialty_rx_tier4: 3000,
  pt_rehab: 150,
  ot_rehab: 150,
  speech_therapy: 150,
  mental_health_outpatient: 200,
  durable_medical_equipment: 500,
};

/** ACA preventive-eligible slugs (mig 010 is_preventive_eligible=true): $0 member. */
export const PREVENTIVE_SLUGS = new Set<string>([
  "preventive_care",
  "annual_physical",
  "immunizations",
  "cancer_screening",
  "well_child_visit",
  "womens_sterilization",
  "preventive_rx",
]);

const FALLBACK_COINSURANCE = 0.2;

/** Plan's own average in-network coinsurance (decimal), fallback 0.20. */
export function avgCoinsurance(plan: ComparePlanPayload): number {
  let sum = 0;
  let count = 0;
  for (const b of plan.benefits) {
    if (b.covered === false) continue;
    const r = toRule(b, "inNetwork");
    if (r.coinsurance != null && r.coinsurance > 0) {
      sum += r.coinsurance;
      count += 1;
    }
  }
  return count > 0 ? sum / count : FALLBACK_COINSURANCE;
}

interface IndexedRule {
  rule: CostRule;
  hasData: boolean;
}

function indexInNetworkRules(plan: ComparePlanPayload): Map<string, IndexedRule> {
  const map = new Map<string, IndexedRule>();
  for (const b of plan.benefits) {
    if (!b.serviceSlug) continue;
    const rule = toRule(b, "inNetwork");
    // An explicit exclusion (covered===false) counts as KNOWN data, not a gap.
    const hasData = b.covered === false || rule.copay != null || rule.coinsurance != null;
    map.set(b.serviceSlug, { rule, hasData });
  }
  return map;
}

/** One basket unit's member share, threading running deductible + OOP. */
function memberShareUnit(
  rule: CostRule,
  billed: number,
  dedRemaining: number,
  oopRemaining: number,
): { amount: number; dedUsed: number; countsTowardOop: boolean } {
  if (rule.covered === false) {
    // Not covered → member pays full; does NOT count toward OOP (so uncapped).
    return { amount: billed, dedUsed: 0, countsTowardOop: false };
  }
  let amount = 0;
  let dedUsed = 0;
  if (rule.deductibleApplies && dedRemaining > 0) {
    dedUsed = Math.min(billed, dedRemaining);
    const rem = billed - dedUsed;
    const coinsPart = rule.coinsurance != null ? rem * rule.coinsurance : 0;
    const copayPart = rule.copay != null ? rule.copay : 0;
    amount = dedUsed + coinsPart + copayPart;
  } else if (rule.copay != null && rule.coinsurance != null) {
    amount = rule.copay + Math.max(0, billed - rule.copay) * rule.coinsurance;
  } else if (rule.copay != null) {
    amount = Math.min(rule.copay, billed);
  } else if (rule.coinsurance != null) {
    amount = billed * rule.coinsurance;
  }
  const capped = Number.isFinite(oopRemaining) ? Math.min(amount, oopRemaining) : amount;
  return { amount: capped, dedUsed, countsTowardOop: true };
}

export interface YearlyEstimate {
  /** Member's estimated annual cost-share for care (whole $). */
  care: number;
  /** Annual premium (whole $) when supplied, else null. */
  premiumAnnual: number | null;
  /** care + premiumAnnual when premium known, else null (drives verdict guardrail). */
  total: number | null;
  /** Fraction of basket services backed by real plan data [0,1]. */
  dataCoverage: number;
  /** The plan's avg coinsurance used for fallback (no-data) services. */
  coinsuranceUsed: number;
}

/**
 * Estimate a plan's yearly member cost for a usage basket.
 * Premium is passed in (resolved by premium-model) and kept SEPARATE from care;
 * `total` is null when premium is unknown so the UI suppresses the total verdict.
 */
export function estimateYearlyV2(
  plan: ComparePlanPayload,
  basket: BasketItem[],
  refPrices: Record<string, number>,
  premiumMonthly: number | null,
): YearlyEstimate {
  let dedRem = asNumber(plan.planSummary.inDeductible) ?? 0;
  const oopMax = asNumber(plan.planSummary.inOopMax);
  let oopRem: number = oopMax ?? Infinity;
  const fallbackCoins = avgCoinsurance(plan);
  const rules = indexInNetworkRules(plan);

  let care = 0;
  let withData = 0;
  let total = 0;
  for (const { slug, qty } of basket) {
    total += 1;
    const billed = refPrices[slug] ?? 0;
    const isPreventive = PREVENTIVE_SLUGS.has(slug);
    const found = rules.get(slug);
    let rule: CostRule;
    if (found && found.hasData) {
      rule = found.rule;
      withData += 1;
    } else {
      // Fallback estimate: plan's avg coinsurance, deductible-applies.
      rule = { copay: null, coinsurance: fallbackCoins, deductibleApplies: true, covered: true };
    }

    for (let i = 0; i < qty; i += 1) {
      if (isPreventive) continue; // ACA preventive — $0 to member
      const { amount, dedUsed, countsTowardOop } = memberShareUnit(rule, billed, dedRem, oopRem);
      care += amount;
      dedRem = Math.max(0, dedRem - dedUsed);
      if (countsTowardOop && Number.isFinite(oopRem)) {
        oopRem = Math.max(0, oopRem - amount);
      }
    }
  }

  const premiumAnnual = premiumMonthly != null ? Math.round(premiumMonthly * 12) : null;
  return {
    care: Math.round(care),
    premiumAnnual,
    total: premiumAnnual != null ? Math.round(care) + premiumAnnual : null,
    dataCoverage: total > 0 ? withData / total : 0,
    coinsuranceUsed: fallbackCoins,
  };
}
