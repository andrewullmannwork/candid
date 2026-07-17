/**
 * Deductible & OOP-Max Accumulator — cross-bill running tally (v1, Phase 1).
 *
 * Candid's OWN running deductible/OOP totals, computed from the plan terms + the
 * user's uploaded bills and threaded across claims in service-date order. This is the
 * cross-bill threading the per-claim engine deferred (recovery-math.ts:879-891 + the
 * unused `deductibleConsumed` hook): we drive `computeCostShareV2` DIRECTLY, feeding a
 * synthesized running-state AccumulatorSnapshot per line and reading back
 * `deductibleConsumed` (deductible) + deriving the OOP contribution from the result
 * (the ONE net-new bit of cost-share logic — fixture-locked; there is no `oopConsumed`
 * on the engine result). We do NOT call `resolveCostShareForLine`: that wrapper
 * re-resolves the accumulator from the claim's OWN EOB rows, the opposite of threading.
 *
 * The engine reads the accumulator's `deductibleMax`/`oopMax` as authoritative for
 * remaining/met (recovery-math.ts:610-622), so EMBEDDED family works by feeding a
 * synthetic effective max = min(member-individual-remaining, family-cap-remaining).
 *
 * Scope (driven by dependents + `deductible_calc_method`, §4b):
 *   - individual        — solo user; the account holder's D_ind / OOP_ind buckets.
 *   - family_aggregate  — dependents + aggregate plan; ALL bills pool into D_fam / OOP_fam.
 *   - family_embedded   — dependents + embedded plan; per-member D_ind/OOP_ind + a D_fam/OOP_fam cap.
 *
 * PURE: no I/O, no flags. The loader (loadAccumulatorLedger, later increment) gathers
 * claims via the B9 userScoped layer, attributes each claim to a member
 * (claims.metadata.patient.name → profile.dependents; else 'unassigned'), and builds
 * `service`/`insurer` via buildServiceCostShare / buildLineInsurer.
 *
 * Later increments: Rx bucket · claim dedup/supersession · user overrides + numeric
 * seed · insurer-reported capture + divergence (like-for-like accumulator_type).
 *
 * SoT: plans/deductible_oop_accumulator_v1.md (§2 model, §4b family, §18 refinements).
 */
import {
  computeCostShareV2,
  type PlanCostShareParams,
  type ServiceCostShare,
  type InsurerAdjudication,
  type AccumulatorSnapshot,
  type CostShareOverrides,
  type CostShareV2Result,
} from "./recovery-math";
import { coerceNetworkTier } from "./cost-share-loader";

const EMPTY_OVERRIDES: CostShareOverrides = {
  deductibleMet: null,
  deductibleMetAsOf: null,
  oopMet: null,
  oopMetAsOf: null,
  userNetworkOverride: null,
};

/** Sentinel member key for a claim whose patient couldn't be matched to a person. */
export const UNASSIGNED_MEMBER = "unassigned";

export interface AccumulatorLedgerLine {
  /** ISO service date (line-level; caller falls back to the claim's). */
  serviceDate: string;
  billed: number;
  allowed: number;
  insuranceAdjusted: number;
  patientPaid: number;
  patientResponsibility: number;
  networkStatus: string | null;
  /** pre-built via buildServiceCostShare(coverage) by the loader. */
  service: ServiceCostShare | null;
  /** pre-built via buildLineInsurer(rawLineItem) by the loader. */
  insurer: InsurerAdjudication;
  isPreventive: boolean;
  /** pharmacy-benefit (NDC) line → Rx bucket (Rx split is a later increment). */
  isRx: boolean;
}

export interface AccumulatorLedgerClaim {
  claimId: string;
  serviceDate: string;
  /** claims.total_insurance_paid === 0 — the pre-deductible corroboration signal. */
  claimInsurerPaidZero: boolean;
  /** attributed member (loader): the account holder key, a dependent key, or UNASSIGNED_MEMBER. */
  memberKey: string;
  lines: AccumulatorLedgerLine[];
}

export interface AccumulatorLedgerInput {
  plan: PlanCostShareParams;
  planYear: number;
  claims: AccumulatorLedgerClaim[];
  /** profile.dependents.length > 0 → family scope. */
  hasDependents: boolean;
  /** Rx deductible denominators (mig 211; in-network; omit/null when not on file). */
  rxDeductibleIndividual?: number | null;
  rxDeductibleFamily?: number | null;
}

export interface LedgerBucket {
  /** Candid's computed applied-to-date (from the plan terms + the bills). */
  candidApplied: number;
  /** the plan limit (denominator); null when the plan term is missing. */
  max: number | null;
  /** max − candidApplied, clamped ≥ 0; null when max is unknown. */
  remaining: number | null;
  /** true once candidApplied has reached the plan limit. */
  met: boolean;
}

export interface NetworkBuckets {
  deductible: LedgerBucket;
  oop: LedgerBucket;
}

export interface NetworkPair {
  in: NetworkBuckets;
  out: NetworkBuckets;
}

export interface LedgerMember {
  memberKey: string;
  buckets: NetworkPair;
}

export type LedgerScope = "individual" | "family_aggregate" | "family_embedded";

export interface AccumulatorLedger {
  planYear: number;
  billsCounted: number;
  scope: LedgerScope;
  /** scope === 'individual' — the account holder (D_ind / OOP_ind). */
  individual?: NetworkPair;
  /** scope === 'family_aggregate' — all bills pooled (D_fam / OOP_fam). */
  familyAggregate?: NetworkPair;
  /** scope === 'family_embedded' — per-member individuals under a family cap. */
  familyEmbedded?: { cap: NetworkPair; members: LedgerMember[] };
  /**
   * Rx (prescription) deductible — a SEPARATE in-network track; present when the plan
   * has an Rx deductible or the user has Rx spend. Rx cost-share still counts toward the
   * shared OOP above (§4c). null `max` → "add your Rx deductible" prompt.
   */
  rxDeductible?: LedgerBucket;
}

type NetKey = "in" | "out";
interface Applied {
  deductible: number;
  oop: number;
}
/** Rx deductible running state — a single in-network track (§4c). */
interface RxSink {
  applied: number;
  max: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function newApplied(): Record<NetKey, Applied> {
  return { in: { deductible: 0, oop: 0 }, out: { deductible: 0, oop: 0 } };
}

/**
 * OOP contribution of a scored line: the patient's covered cost-share counts toward
 * the OOP max; not-covered spend contributes $0 (§3 — non-covered never counts).
 * `shouldOwe` already respects the deductible phase AND the oop_met cap (we fed the
 * running OOP into the snapshot), and it INCLUDES the deductible payment (which nests
 * into OOP). This derivation is the one net-new cost-share bit (§2) — fixture-locked.
 */
function oopContribution(result: CostShareV2Result): number {
  if (result.coverageDecision.planStance === "not_covered") return 0;
  return result.shouldOwe;
}

function makeBucket(applied: number, max: number | null): LedgerBucket {
  const a = round2(applied);
  return {
    candidApplied: a,
    max,
    remaining: max == null ? null : Math.max(0, round2(max - a)),
    met: max != null && a >= max,
  };
}

/**
 * Score one line against a given running state (applied + effective max) and return
 * how much of it applies to the deductible and toward OOP — both capped at the
 * remaining headroom (the engine's `deductibleConsumed` already respects it; the OOP
 * cap guards an intra-line straddle across the OOP max).
 */
function scoreLine(
  line: AccumulatorLedgerLine,
  claim: AccumulatorLedgerClaim,
  net: ReturnType<typeof coerceNetworkTier>,
  dedApplied: number,
  dedMax: number | null,
  oopApplied: number,
  oopMax: number | null,
  plan: PlanCostShareParams,
): { ded: number; oop: number } {
  const snapshot: AccumulatorSnapshot = {
    deductibleApplied: dedApplied,
    deductibleMax: dedMax,
    oopApplied,
    oopMax,
  };
  const result = computeCostShareV2({
    line: {
      billed: line.billed,
      allowed: line.allowed,
      insuranceAdjusted: line.insuranceAdjusted,
      patientPaid: line.patientPaid,
      patientResponsibility: line.patientResponsibility,
    },
    service: line.service,
    insurer: line.insurer,
    plan,
    accumulator: snapshot,
    overrides: EMPTY_OVERRIDES,
    networkLine: net,
    networkClaim: null,
    preventive: { isPreventive: line.isPreventive, acaStatus: line.isPreventive ? "confirmed" : "non_aca" },
    claimInsurerPaidZero: claim.claimInsurerPaidZero,
  });
  const remDed = dedMax == null ? Infinity : Math.max(0, dedMax - dedApplied);
  const remOop = oopMax == null ? Infinity : Math.max(0, oopMax - oopApplied);
  return {
    ded: Math.min(result.deductibleConsumed, remDed),
    oop: Math.min(oopContribution(result), remOop),
  };
}

function netKey(line: AccumulatorLedgerLine): { net: ReturnType<typeof coerceNetworkTier>; key: NetKey } {
  const net = coerceNetworkTier(line.networkStatus) ?? "in_network";
  return { net, key: net === "out_of_network" ? "out" : "in" };
}

function orderClaims(claims: AccumulatorLedgerClaim[]): AccumulatorLedgerClaim[] {
  return [...claims].sort((a, b) => {
    const c = a.serviceDate.localeCompare(b.serviceDate);
    return c !== 0 ? c : a.claimId.localeCompare(b.claimId);
  });
}

/** individual OR family_aggregate: one accumulator; denominators differ (ind vs family). */
function computeSingle(
  plan: PlanCostShareParams,
  claims: AccumulatorLedgerClaim[],
  useFamily: boolean,
  rx: RxSink,
): NetworkPair {
  const maxes: Record<NetKey, Applied & { dedMax: number | null; oopMax: number | null }> = {
    in: {
      deductible: 0,
      oop: 0,
      dedMax: useFamily ? plan.inDeductibleFamily : plan.inDeductibleIndividual,
      oopMax: useFamily ? plan.inOopMaxFamily : plan.inOopMaxIndividual,
    },
    out: {
      deductible: 0,
      oop: 0,
      dedMax: useFamily ? plan.outDeductibleFamily : plan.outDeductibleIndividual,
      oopMax: useFamily ? plan.outOopMaxFamily : plan.outOopMaxIndividual,
    },
  };
  for (const claim of claims) {
    for (const line of claim.lines) {
      const { net, key } = netKey(line);
      if (line.isRx) {
        // Rx deductible → separate Rx track; Rx OOP → the in-network shared OOP (§4c).
        const c = scoreLine(line, claim, "in_network", rx.applied, rx.max, maxes.in.oop, maxes.in.oopMax, plan);
        rx.applied += c.ded;
        maxes.in.oop += c.oop;
        continue;
      }
      const b = maxes[key];
      const c = scoreLine(line, claim, net, b.deductible, b.dedMax, b.oop, b.oopMax, plan);
      b.deductible += c.ded;
      b.oop += c.oop;
    }
  }
  const pair = (k: NetKey): NetworkBuckets => ({
    deductible: makeBucket(maxes[k].deductible, maxes[k].dedMax),
    oop: makeBucket(maxes[k].oop, maxes[k].oopMax),
  });
  return { in: pair("in"), out: pair("out") };
}

/** family_embedded: per-member individual accumulators under a shared family cap. */
function computeEmbedded(
  plan: PlanCostShareParams,
  claims: AccumulatorLedgerClaim[],
  rx: RxSink,
): { cap: NetworkPair; members: LedgerMember[] } {
  const capMax: Record<NetKey, { ded: number | null; oop: number | null }> = {
    in: { ded: plan.inDeductibleFamily, oop: plan.inOopMaxFamily },
    out: { ded: plan.outDeductibleFamily, oop: plan.outOopMaxFamily },
  };
  const memMax: Record<NetKey, { ded: number | null; oop: number | null }> = {
    in: { ded: plan.inDeductibleIndividual, oop: plan.inOopMaxIndividual },
    out: { ded: plan.outDeductibleIndividual, oop: plan.outOopMaxIndividual },
  };
  const cap = newApplied();
  const members = new Map<string, Record<NetKey, Applied>>();
  const memberOrder: string[] = [];
  const memberState = (mk: string): Record<NetKey, Applied> => {
    let m = members.get(mk);
    if (!m) {
      m = newApplied();
      members.set(mk, m);
      memberOrder.push(mk);
    }
    return m;
  };
  const rem = (max: number | null, applied: number): number =>
    max == null ? Infinity : Math.max(0, max - applied);

  for (const claim of claims) {
    for (const line of claim.lines) {
      const { net, key } = netKey(line);
      if (line.isRx) {
        // Rx deductible → separate Rx track; Rx OOP → the family-cap in-network OOP (§4c).
        const c = scoreLine(line, claim, "in_network", rx.applied, rx.max, cap.in.oop, capMax.in.oop, plan);
        rx.applied += c.ded;
        cap.in.oop += c.oop;
        continue;
      }
      if (claim.memberKey === UNASSIGNED_MEMBER) {
        // counts toward the family cap only — advances no individual.
        const c = scoreLine(line, claim, net, cap[key].deductible, capMax[key].ded, cap[key].oop, capMax[key].oop, plan);
        cap[key].deductible += c.ded;
        cap[key].oop += c.oop;
        continue;
      }
      const m = memberState(claim.memberKey);
      // effective remaining = the binding of member-individual vs family-cap.
      const effDedRem = Math.min(rem(memMax[key].ded, m[key].deductible), rem(capMax[key].ded, cap[key].deductible));
      const effOopRem = Math.min(rem(memMax[key].oop, m[key].oop), rem(capMax[key].oop, cap[key].oop));
      const synDedMax = effDedRem === Infinity ? null : m[key].deductible + effDedRem;
      const synOopMax = effOopRem === Infinity ? null : m[key].oop + effOopRem;
      const c = scoreLine(line, claim, net, m[key].deductible, synDedMax, m[key].oop, synOopMax, plan);
      m[key].deductible += c.ded;
      m[key].oop += c.oop;
      cap[key].deductible += c.ded;
      cap[key].oop += c.oop;
    }
  }

  const capPair: NetworkPair = {
    in: { deductible: makeBucket(cap.in.deductible, capMax.in.ded), oop: makeBucket(cap.in.oop, capMax.in.oop) },
    out: { deductible: makeBucket(cap.out.deductible, capMax.out.ded), oop: makeBucket(cap.out.oop, capMax.out.oop) },
  };
  const memberList: LedgerMember[] = memberOrder.map((mk) => {
    const m = members.get(mk)!;
    return {
      memberKey: mk,
      buckets: {
        in: { deductible: makeBucket(m.in.deductible, memMax.in.ded), oop: makeBucket(m.in.oop, memMax.in.oop) },
        out: { deductible: makeBucket(m.out.deductible, memMax.out.ded), oop: makeBucket(m.out.oop, memMax.out.oop) },
      },
    };
  });
  return { cap: capPair, members: memberList };
}

/**
 * Thread the plan's cost-share rules across a user's bills in service-date order to
 * produce Candid's running deductible/OOP totals, at the grain the plan dictates.
 */
export function computeAccumulatorLedger(input: AccumulatorLedgerInput): AccumulatorLedger {
  const { plan, planYear, claims, hasDependents } = input;
  const scope: LedgerScope = !hasDependents
    ? "individual"
    : plan.deductibleCalcMethod === "embedded"
      ? "family_embedded"
      : "family_aggregate";
  const ordered = orderClaims(claims);
  const base = { planYear, billsCounted: claims.length, scope };

  // Rx deductible — a single in-network track (family denominator when there are
  // dependents; individual otherwise). Rx OOP folds into the shared OOP (§4c).
  const rx: RxSink = {
    applied: 0,
    max: (hasDependents ? input.rxDeductibleFamily : input.rxDeductibleIndividual) ?? null,
  };

  let core: AccumulatorLedger;
  if (scope === "family_embedded") {
    core = { ...base, familyEmbedded: computeEmbedded(plan, ordered, rx) };
  } else {
    const pair = computeSingle(plan, ordered, scope === "family_aggregate", rx);
    core = scope === "family_aggregate" ? { ...base, familyAggregate: pair } : { ...base, individual: pair };
  }
  // Include the Rx bucket when the plan has an Rx deductible or there is Rx spend.
  if (rx.max != null || rx.applied > 0) {
    core.rxDeductible = makeBucket(rx.applied, rx.max);
  }
  return core;
}
