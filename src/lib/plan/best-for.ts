/**
 * S70.A — "Best for…" plan personality scoring.
 *
 * Pure functions that score a `ComparePlanPayload` along 8 dimensions and
 * return the top-N tags for display in the comparison header. Scoring is
 * deterministic + relative (a tag's score depends on the cohort being compared
 * — "Low monthly cost" only fires for the cheapest plan in the comparison set).
 *
 * No Haiku call, no external service. Runs server-side inside the compare
 * resolver and is folded into the `bestForTags` field on the payload.
 */

import { unwrapValue } from "@/components/display-state";
import {
  pickRepresentativeVariant,
  type ComparePlanPayload,
  type CompareBenefit,
} from "@/lib/plan/compare";

export type BestForTagKey =
  | "low_everyday_costs"
  | "comprehensive_coverage"
  | "families"
  | "ongoing_prescriptions"
  | "emergencies"
  | "out_of_network_flexibility"
  | "low_monthly_cost"
  | "low_risk_ceiling";

export interface BestForTag {
  key: BestForTagKey;
  label: string;
  /** 0-100; higher = stronger fit. Used for ranking; not displayed. */
  score: number;
  /** Short rationale shown as tooltip on the badge. */
  why: string;
}

interface ScoringContext {
  /** All plans in the current comparison — lets us do relative scoring. */
  cohort: ComparePlanPayload[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function num(value: unknown): number | null {
  const v = unwrapValue<number | null>(value as never);
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function findBenefit(plan: ComparePlanPayload, slugs: string[]): CompareBenefit | null {
  // S289 review F5 — representative variant, not first-in-array: "Good for
  // preventative care — $X primary care copay" must quote the service's
  // default variant, not whichever variant happened to sort first.
  for (const slug of slugs) {
    const hits = plan.benefits.filter((b) => b.serviceSlug === slug);
    const rep = pickRepresentativeVariant(hits);
    if (rep) return rep;
  }
  return null;
}

function inCopay(b: CompareBenefit | null): number | null {
  if (!b || b.covered === false) return null;
  return num(b.costSharing.inNetwork.copay);
}

function isCovered(b: CompareBenefit | null): boolean {
  if (!b) return false;
  return b.covered !== false;
}

// ── Per-dimension scoring ──────────────────────────────────────────────────

function scoreLowEverydayCosts(plan: ComparePlanPayload): { score: number; why: string } {
  // Low PCP copay + low generic Rx copay = good for routine care.
  const pcp = inCopay(findBenefit(plan, ["pcp_visit", "preventive_care", "office_visit_pcp"]));
  const rxGeneric = inCopay(findBenefit(plan, ["rx_generic", "prescription_generic", "tier_1_rx"]));

  let score = 0;
  const reasons: string[] = [];

  if (pcp != null) {
    if (pcp <= 25) {
      score += 50;
      reasons.push(`$${pcp} primary care copay`);
    } else if (pcp <= 40) {
      score += 30;
      reasons.push(`$${pcp} primary care copay`);
    } else if (pcp <= 60) {
      score += 10;
    }
  }

  if (rxGeneric != null) {
    if (rxGeneric <= 10) {
      score += 50;
      reasons.push(`$${rxGeneric} generic Rx copay`);
    } else if (rxGeneric <= 20) {
      score += 30;
    }
  }

  return {
    score,
    why: reasons.length > 0 ? `Strong for routine visits — ${reasons.join(", ")}.` : "Good for routine care.",
  };
}

function scoreComprehensiveCoverage(plan: ComparePlanPayload): { score: number; why: string } {
  // Plan covers all major care categories at any cost-sharing.
  // S94 B1: canonical slugs added; legacy aliases retained for pre-S94 data still rendering.
  const requiredCategories = [
    { name: "ER", slugs: ["er_visit", "emergency_room", "emergency_services"] },
    { name: "Hospitalization", slugs: ["inpatient_facility", "inpatient_hospitalization", "hospitalization"] },
    { name: "Maternity", slugs: ["delivery_facility", "delivery_professional", "prenatal_visit", "maternity_delivery", "maternity_prenatal", "maternity"] },
    { name: "Mental health", slugs: ["mental_health_outpatient", "mental_health", "behavioral_health"] },
    { name: "Specialist", slugs: ["specialist_visit", "specialist", "specialty_care"] },
    { name: "Prescriptions", slugs: ["generic_rx_tier1", "rx_generic", "prescription_generic", "tier_1_rx"] },
  ];
  const covered = requiredCategories.filter((c) => isCovered(findBenefit(plan, c.slugs)));
  const ratio = covered.length / requiredCategories.length;
  const score = Math.round(ratio * 100);
  return {
    score,
    why: `Covers ${covered.length} of ${requiredCategories.length} major care categories${
      covered.length === requiredCategories.length ? " — no gaps." : "."
    }`,
  };
}

function scoreFamilies(plan: ComparePlanPayload): { score: number; why: string } {
  // Maternity covered + reasonable family deductible vs individual.
  const maternity = findBenefit(plan, ["maternity_delivery", "maternity_prenatal", "maternity"]);
  const wellChild = findBenefit(plan, ["well_child_care", "preventive_care_child", "pediatric_preventive"]);

  let score = 0;
  const reasons: string[] = [];

  if (isCovered(maternity)) {
    score += 40;
    reasons.push("maternity covered");
  }
  if (isCovered(wellChild)) {
    score += 30;
    reasons.push("well-child care included");
  }
  // Family-tier deductible scoring is tricky without family premium data; skip
  // the relative component — only positive when both maternity + well-child are real.
  if (score >= 70) {
    score += 20; // bonus for combined fit
  }
  return {
    score,
    why: reasons.length > 0 ? `Family fit — ${reasons.join(" + ")}.` : "Limited family-care fit.",
  };
}

function scoreOngoingPrescriptions(plan: ComparePlanPayload): { score: number; why: string } {
  // S94 B1: canonical tiered slugs added; legacy aliases retained defensively.
  const tier1 = inCopay(findBenefit(plan, ["generic_rx_tier1", "rx_generic", "prescription_generic", "tier_1_rx"]));
  const tier2 = inCopay(findBenefit(plan, ["preferred_brand_rx_tier2", "rx_preferred_brand", "prescription_preferred", "tier_2_rx"]));
  const specialty = findBenefit(plan, ["specialty_rx_tier4", "rx_specialty", "tier_4_rx", "tier_5_rx"]);

  let score = 0;
  const reasons: string[] = [];

  if (tier1 != null && tier1 <= 15) {
    score += 35;
    reasons.push(`$${tier1} generic`);
  }
  if (tier2 != null && tier2 <= 40) {
    score += 25;
    reasons.push(`$${tier2} preferred brand`);
  }
  if (isCovered(specialty)) {
    score += 30;
    reasons.push("specialty Rx covered");
  }
  return {
    score,
    why: reasons.length > 0 ? `Strong Rx coverage — ${reasons.join(", ")}.` : "Limited Rx coverage.",
  };
}

function scoreEmergencies(plan: ComparePlanPayload): { score: number; why: string } {
  const er = findBenefit(plan, ["emergency_room", "er_visit", "emergency_services"]);
  const ambulance = findBenefit(plan, ["ambulance", "emergency_transport"]);
  const erCopay = inCopay(er);

  let score = 0;
  const reasons: string[] = [];

  if (isCovered(er)) {
    score += 40;
    if (erCopay != null && erCopay <= 250) {
      score += 30;
      reasons.push(`$${erCopay} ER copay`);
    } else if (erCopay != null) {
      reasons.push(`$${erCopay} ER copay`);
    } else {
      reasons.push("ER covered");
    }
  }
  if (isCovered(ambulance)) {
    score += 20;
    reasons.push("ambulance included");
  }
  return {
    score,
    why: reasons.length > 0 ? `Emergency-ready — ${reasons.join(", ")}.` : "Limited ER coverage.",
  };
}

function scoreOutOfNetworkFlexibility(plan: ComparePlanPayload): { score: number; why: string } {
  // OON benefits exist if any benefit row has a non-empty OON cost description
  // OR plan-level OON OOP max is set.
  const oonOopMax = num(plan.planSummary.outOopMax);
  const oonDeductible = num(plan.planSummary.outDeductible);
  const oonBenefitsExist = plan.benefits.some(
    (b) => b.covered !== false && b.costOutOfNetworkDescription && b.costOutOfNetworkDescription !== "Not covered" && b.costOutOfNetworkDescription !== "—",
  );

  let score = 0;
  const reasons: string[] = [];

  if (oonBenefitsExist) {
    score += 40;
    reasons.push("out-of-network covered");
  }
  if (oonOopMax != null && oonOopMax > 0) {
    score += 30;
    reasons.push(`$${oonOopMax.toLocaleString()} OON OOP max`);
  }
  if (oonDeductible != null && oonDeductible > 0) {
    score += 20;
  }
  return {
    score,
    why: reasons.length > 0 ? `Flexible network — ${reasons.join(", ")}.` : "In-network only.",
  };
}

function scoreLowMonthlyCost(plan: ComparePlanPayload, ctx: ScoringContext): { score: number; why: string } {
  const myPremium = num(plan.planSummary.premiumMonthly);
  if (myPremium == null) return { score: 0, why: "" };
  const cohortPremiums = ctx.cohort
    .map((p) => num(p.planSummary.premiumMonthly))
    .filter((v): v is number => v != null);
  if (cohortPremiums.length < 2) return { score: 0, why: "" };
  const min = Math.min(...cohortPremiums);
  const max = Math.max(...cohortPremiums);
  if (max === min) return { score: 0, why: "" };
  // Linear inverse — lowest premium gets 100, highest gets 0.
  const score = Math.round(((max - myPremium) / (max - min)) * 100);
  const isLowest = myPremium === min;
  return {
    score,
    why: isLowest
      ? `Lowest monthly premium in this comparison — $${myPremium}/mo.`
      : `Below-average monthly premium — $${myPremium}/mo.`,
  };
}

function scoreLowRiskCeiling(plan: ComparePlanPayload, ctx: ScoringContext): { score: number; why: string } {
  const myOop = num(plan.planSummary.inOopMax);
  if (myOop == null || myOop === 0) return { score: 0, why: "" };
  const cohortOop = ctx.cohort
    .map((p) => num(p.planSummary.inOopMax))
    .filter((v): v is number => v != null && v > 0);
  if (cohortOop.length < 2) return { score: 0, why: "" };
  const min = Math.min(...cohortOop);
  const max = Math.max(...cohortOop);
  if (max === min) return { score: 0, why: "" };
  const score = Math.round(((max - myOop) / (max - min)) * 100);
  return {
    score,
    why: `Caps your out-of-pocket exposure at $${myOop.toLocaleString()} per year.`,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

// "Good for" instead of "Best for" — softer claim, less legally fraught (no
// implicit superiority assertion), and clearer to users that the tag is a
// directional fit not an absolute ranking. Same logic for "Lower" instead
// of "Lowest" — implies relative direction, not an absolute superlative
// claim against the universe of plans.
const TAG_LABELS: Record<BestForTagKey, string> = {
  low_everyday_costs: "Good for preventative care",
  comprehensive_coverage: "Good for full coverage",
  families: "Good for families",
  ongoing_prescriptions: "Good for prescriptions",
  emergencies: "Good for emergencies",
  out_of_network_flexibility: "Good for flexibility",
  low_monthly_cost: "Lower monthly cost",
  low_risk_ceiling: "Lower risk ceiling",
};

const SCORE_THRESHOLD = 50; // Tags below this don't get surfaced even if top-N.

/**
 * Score a single plan against all 8 dimensions in the context of its cohort
 * (relative dimensions like "low monthly cost" depend on the comparison set).
 * Returns top-2 tags above SCORE_THRESHOLD, ranked by score descending.
 */
export function computeBestForTags(
  plan: ComparePlanPayload,
  cohort: ComparePlanPayload[],
  topN = 2,
): BestForTag[] {
  const ctx: ScoringContext = { cohort };
  const dimensions: Array<{ key: BestForTagKey; result: { score: number; why: string } }> = [
    { key: "low_everyday_costs", result: scoreLowEverydayCosts(plan) },
    { key: "comprehensive_coverage", result: scoreComprehensiveCoverage(plan) },
    { key: "families", result: scoreFamilies(plan) },
    { key: "ongoing_prescriptions", result: scoreOngoingPrescriptions(plan) },
    { key: "emergencies", result: scoreEmergencies(plan) },
    { key: "out_of_network_flexibility", result: scoreOutOfNetworkFlexibility(plan) },
    { key: "low_monthly_cost", result: scoreLowMonthlyCost(plan, ctx) },
    { key: "low_risk_ceiling", result: scoreLowRiskCeiling(plan, ctx) },
  ];

  return dimensions
    .filter((d) => d.result.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, topN)
    .map((d) => ({
      key: d.key,
      label: TAG_LABELS[d.key],
      score: d.result.score,
      why: d.result.why,
    }));
}

/**
 * Apply best-for tags across an entire comparison set in one pass.
 * Mutates each payload's `bestForTags` field.
 */
export function attachBestForTags(plans: ComparePlanPayload[]): void {
  for (const plan of plans) {
    plan.bestForTags = computeBestForTags(plan, plans);
  }
}
