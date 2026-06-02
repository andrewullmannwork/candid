/**
 * Compare v2 (S156) — yearly-cost basket model.
 *
 * Replaces the prototype's blended-rate estimate (which ignored copays). Runs a
 * utilization basket through each plan's ACTUAL per-service rules, accumulating
 * ONE shared deductible + OOP, applying copay as flat $ and coinsurance as %,
 * $0 for ACA-preventive, capped at OOP. Missing services fall back to the plan's
 * avg coinsurance and are reported via `dataCoverage` so a mostly-fallback
 * estimate never looks confident.
 *
 * Two entry points share one engine (`runEngine`):
 *   - `estimateYearlyV2`     — low-level: a slug-keyed basket + reference prices.
 *   - `estimateYearlyFromUnits` — production path (design v2): the member's
 *     intuitive-unit counts (visits / therapy / rx / imaging / events) + a
 *     household ("Who's covered"); each unit maps to a representative service
 *     slug for the real rule, and household >1 applies a family deductible/OOP.
 *
 * Spec: plans/compare_v2_redesign.md §4.2 + §5 + §11. Constants are tunable
 * (later mirrored into the compare_v2_redesign flag config). Reference / per-unit
 * prices are ILLUSTRATIVE (curated MVP; fast-follow = claims-derived medians,
 * k-anon ≥5).
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
 * Tunable slug-keyed baskets (real service_catalog slugs from mig 010).
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
 * Illustrative reference prices — member-relevant billed $ per unit. Same prices
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

/** One unit's member share, threading running deductible + OOP. */
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

// ── Shared accumulation engine ──────────────────────────────────────────────
interface EngineItem {
  rule: CostRule;
  billed: number;
  qty: number;
  preventive: boolean;
  hasData: boolean;
}

function runEngine(
  items: EngineItem[],
  deductible: number,
  oop: number | null,
): { care: number; withData: number; total: number } {
  let dedRem = deductible;
  let oopRem: number = oop ?? Infinity;
  let care = 0;
  let withData = 0;
  let total = 0;
  for (const it of items) {
    total += 1;
    if (it.hasData) withData += 1;
    for (let i = 0; i < it.qty; i += 1) {
      if (it.preventive) continue; // ACA preventive — $0 to member
      const { amount, dedUsed, countsTowardOop } = memberShareUnit(it.rule, it.billed, dedRem, oopRem);
      care += amount;
      dedRem = Math.max(0, dedRem - dedUsed);
      if (countsTowardOop && Number.isFinite(oopRem)) oopRem = Math.max(0, oopRem - amount);
    }
  }
  return { care, withData, total };
}

function fallbackRule(coinsurance: number): CostRule {
  return { copay: null, coinsurance, deductibleApplies: true, covered: true };
}

export interface YearlyEstimate {
  /** Member's estimated annual cost-share for care (whole $). */
  care: number;
  /** Annual premium (whole $) when supplied, else null. */
  premiumAnnual: number | null;
  /** care + premiumAnnual when premium known, else null (drives verdict guardrail). */
  total: number | null;
  /** Fraction of basket items backed by real plan data [0,1]. */
  dataCoverage: number;
  /** The plan's avg coinsurance used for fallback (no-data) items. */
  coinsuranceUsed: number;
}

/**
 * Low-level: estimate a plan's yearly member cost for a slug-keyed basket.
 * Premium is passed in and kept SEPARATE from care; `total` is null when premium
 * is unknown so the UI suppresses the total verdict.
 */
export function estimateYearlyV2(
  plan: ComparePlanPayload,
  basket: BasketItem[],
  refPrices: Record<string, number>,
  premiumMonthly: number | null,
): YearlyEstimate {
  const fallbackCoins = avgCoinsurance(plan);
  const rules = indexInNetworkRules(plan);
  const items: EngineItem[] = basket.map(({ slug, qty }) => {
    const found = rules.get(slug);
    const hasData = !!(found && found.hasData);
    return {
      rule: hasData && found ? found.rule : fallbackRule(fallbackCoins),
      billed: refPrices[slug] ?? 0,
      qty,
      preventive: PREVENTIVE_SLUGS.has(slug),
      hasData,
    };
  });
  const { care, withData, total } = runEngine(
    items,
    asNumber(plan.planSummary.inDeductible) ?? 0,
    asNumber(plan.planSummary.inOopMax),
  );
  const premiumAnnual = premiumMonthly != null ? Math.round(premiumMonthly * 12) : null;
  return {
    care: Math.round(care),
    premiumAnnual,
    total: premiumAnnual != null ? Math.round(care) + premiumAnnual : null,
    dataCoverage: total > 0 ? withData / total : 0,
    coinsuranceUsed: fallbackCoins,
  };
}

// ── Production path: intuitive-unit inputs + household (design v2) ───────────

export interface UnitDef {
  key: string;
  label: string;
  unit: string;
  /** Illustrative billed $ per unit. */
  per: number;
  /** When true, the count is per-month (×12 for the year). */
  monthly: boolean;
  /** Representative service_catalog slug for the per-service rule lookup. */
  slug: string;
  defaults: Record<UsageLevel, number>;
}

/**
 * Intuitive care units the member adjusts (design v2 "Adjust my care"). People
 * know visits, not dollars. Each maps to a representative real slug so the basket
 * engine applies the plan's actual copay-vs-coinsurance rule.
 */
export const YEARLY_UNITS: UnitDef[] = [
  { key: "visits", label: "Doctor visits", unit: "visits/yr", per: 180, monthly: false, slug: "pcp_visit", defaults: { healthy: 3, average: 6, heavy: 12 } },
  { key: "therapy", label: "Therapy / mental health", unit: "sessions/yr", per: 150, monthly: false, slug: "mental_health_outpatient", defaults: { healthy: 0, average: 6, heavy: 24 } },
  { key: "rx", label: "Regular prescriptions", unit: "per month", per: 45, monthly: true, slug: "generic_rx_tier1", defaults: { healthy: 0, average: 2, heavy: 4 } },
  { key: "imaging", label: "Imaging & scans", unit: "scans/yr", per: 900, monthly: false, slug: "advanced_imaging", defaults: { healthy: 0, average: 1, heavy: 3 } },
  { key: "events", label: "Major events (ER, surgery)", unit: "per year", per: 12000, monthly: false, slug: "inpatient_facility", defaults: { healthy: 0, average: 0, heavy: 1 } },
];

export interface Household {
  spouse: boolean;
  kids: number;
}

export function householdPeople(hh: Household): number {
  return 1 + (hh.spouse ? 1 : 0) + Math.max(0, hh.kids || 0);
}

/** Care scales up for dependents (kids ~0.5×, a spouse ~0.8× more utilization). */
export function householdCareFactor(hh: Household): number {
  return 1 + 0.8 * (hh.spouse ? 1 : 0) + 0.5 * Math.max(0, hh.kids || 0);
}

export function defaultUnitCounts(usage: UsageLevel, hh: Household): Record<string, number> {
  const f = householdCareFactor(hh);
  const out: Record<string, number> = {};
  for (const u of YEARLY_UNITS) out[u.key] = Math.round((u.defaults[usage] || 0) * f);
  return out;
}

export function unitCountsFor(
  usage: UsageLevel,
  hh: Household,
  overrides?: Record<string, number> | null,
): Record<string, number> {
  const base = defaultUnitCounts(usage, hh);
  return overrides ? { ...base, ...overrides } : base;
}

/** Total expected annual billed care for the "adds up to $X/yr" display. */
export function billedFromUnits(counts: Record<string, number>): number {
  return YEARLY_UNITS.reduce(
    (s, u) => s + Math.max(0, counts[u.key] || 0) * u.per * (u.monthly ? 12 : 1),
    0,
  );
}

export interface YearlyFromUnitsOpts {
  usage: UsageLevel;
  household: Household;
  /** Per-unit count overrides (null = use usage+household defaults). */
  unitOverrides?: Record<string, number> | null;
  premiumMonthly?: number | null;
  /** Real family ceilings when available (backend payload ext); else ~2× individual for >1 person. */
  familyDeductible?: number | null;
  familyOop?: number | null;
}

/**
 * Production estimate: drive the basket engine from the member's intuitive-unit
 * counts + household. Only units with a non-zero count enter the estimate (and
 * the data-coverage denominator), so "based on N of M services" reflects the care
 * they actually expect. Household >1 applies a family deductible/OOP (real values
 * when supplied, else ~2× individual).
 */
export function estimateYearlyFromUnits(
  plan: ComparePlanPayload,
  opts: YearlyFromUnitsOpts,
): YearlyEstimate {
  const counts = unitCountsFor(opts.usage, opts.household, opts.unitOverrides);
  const fallbackCoins = avgCoinsurance(plan);
  const rules = indexInNetworkRules(plan);

  const items: EngineItem[] = [];
  for (const u of YEARLY_UNITS) {
    const count = Math.max(0, counts[u.key] || 0);
    if (count <= 0) continue; // only used units enter the estimate + coverage denominator
    const found = rules.get(u.slug);
    const hasData = !!(found && found.hasData);
    items.push({
      rule: hasData && found ? found.rule : fallbackRule(fallbackCoins),
      billed: u.per,
      qty: u.monthly ? count * 12 : count,
      preventive: false,
      hasData,
    });
  }

  const people = householdPeople(opts.household);
  const famFactor = people > 1 ? 2 : 1;
  const indDed = asNumber(plan.planSummary.inDeductible) ?? 0;
  const indOop = asNumber(plan.planSummary.inOopMax);
  const deductible =
    opts.familyDeductible != null && people > 1 ? opts.familyDeductible : indDed * famFactor;
  const oop =
    opts.familyOop != null && people > 1
      ? opts.familyOop
      : indOop != null
        ? indOop * famFactor
        : null;

  const { care, withData, total } = runEngine(items, deductible, oop);
  const premiumAnnual = opts.premiumMonthly != null ? Math.round(opts.premiumMonthly * 12) : null;
  return {
    care: Math.round(care),
    premiumAnnual,
    total: premiumAnnual != null ? Math.round(care) + premiumAnnual : null,
    dataCoverage: total > 0 ? withData / total : 1, // no care expected → no uncertainty
    coinsuranceUsed: fallbackCoins,
  };
}
