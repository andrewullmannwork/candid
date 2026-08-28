/**
 * Cost-Share v2 (S214) — Step 2 data loaders.
 *
 * Builds the four DB-backed inputs `computeCostShareV2` needs beyond the
 * per-line columns: plan-level params, the per-claim accumulator snapshot, the
 * user's plan-year overrides, and the per-line ServiceCostShare (from the
 * already-resolved coverage cascade). Pure resolvers (accumulator match,
 * pre-claim adjustment, override date logic, ServiceCostShare mapping) are split
 * out so they're unit-tested without a DB; the async loaders are exercised at
 * Step-3 / gate E. Nothing here changes behavior until the route wires it under
 * the recovery_cost_share_v2 flag.
 *
 * NOTE: in USER-FACING routes, claim_accumulators must be read via
 * `selectOwnedChildren` (parent-join) per the B9 security layer —
 * `loadClaimAccumulators` here is the service-role audit/pipeline path; Step 3
 * passes the owned rows into `resolveAccumulatorForLine`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCoinsuranceForStorage } from "../billing/coinsurance";
import type {
  PlanCoverageInput,
  PlanCostShareParams,
  AccumulatorSnapshot,
  CostShareOverrides,
  ServiceCostShare,
  NetworkTier,
  InsurerAdjudication,
} from "./recovery-math";

// ── ServiceCostShare (from the resolved coverage cascade) ──────────────────

/**
 * Map a resolved PlanCoverageInput (exact / secondary / ACA — ACA already
 * carries deductibleApplies=false) into the engine's ServiceCostShare. null
 * coverage → null service (engine then runs its conservative path).
 *
 * S308 (tracker AU) — `exactMatch`: TRUE only when this coverage came from the
 * service's OWN pcs row (not the S153 borrowed category sibling, not ACA
 * synthesis). REQUIRED so the compiler completes the caller inventory.
 * `userStatedRate` composes here — the one place holding both facts — because
 * "the user stated THIS service's rate" needs the value's provenance AND the
 * match's directness; a borrowed sibling keeps its provenance for the honesty
 * gate but must never render as "You told us this."
 */
export function buildServiceCostShare(
  coverage: PlanCoverageInput | null,
  exactMatch: boolean,
): ServiceCostShare | null {
  if (!coverage) return null;
  return {
    userStatedRate: exactMatch && (coverage.costProvenance ?? "unknown") === "user",
    covered: coverage.covered ?? null,
    copay: coverage.copay ?? null,
    coinsurance: coverage.coinsurance ?? null,
    deductibleApplies: coverage.deductibleApplies ?? null,
    outCopay: coverage.outCopay ?? null,
    outCoinsurance: coverage.outCoinsurance ?? null,
    outDeductibleApplies: coverage.outDeductibleApplies ?? null,
    oonPaidAtInNetwork: coverage.oonPaidAtInNetwork ?? null,
    // S294 — provenance travels WITH the numbers into the engine. The honesty
    // gate used to read a flag on the PLAN ROW (`verification_status`), which
    // said only "this member hasn't uploaded a plan document" — so a
    // search-selected plan whose terms came from Candid's own SBC extraction
    // was degraded exactly like a fabricated card copay, permanently and
    // invisibly.
    costProvenance: coverage.costProvenance ?? "unknown",
  };
}

// ── Plan-level params (insurance_plans) ────────────────────────────────────

/** The 8 plan-level numeric term columns on insurance_plans, mapped to their
 *  canonical_plans counterparts. NOTE the asymmetry: canonical_plans kept the
 *  LEGACY names for in-network plan-level terms (deductible_individual etc.);
 *  only its OON columns carry the out_ prefix (mig 192). Selecting in_* from
 *  canonical_plans 42703s — which this map exists to prevent. */
const PLAN_TERM_NUMERIC_COLS = [
  "in_deductible_individual",
  "in_deductible_family",
  "out_deductible_individual",
  "out_deductible_family",
  "in_oop_max_individual",
  "in_oop_max_family",
  "out_oop_max_individual",
  "out_oop_max_family",
] as const;

const CANONICAL_TERM_COL: Record<(typeof PLAN_TERM_NUMERIC_COLS)[number], string> = {
  in_deductible_individual: "deductible_individual",
  in_deductible_family: "deductible_family",
  in_oop_max_individual: "oop_max_individual",
  in_oop_max_family: "oop_max_family",
  out_deductible_individual: "out_deductible_individual",
  out_deductible_family: "out_deductible_family",
  out_oop_max_individual: "out_oop_max_individual",
  out_oop_max_family: "out_oop_max_family",
};

export async function loadPlanCostShareParams(
  supabase: SupabaseClient,
  insurancePlanId: string | null | undefined,
): Promise<PlanCostShareParams | null> {
  if (!insurancePlanId) return null;
  const { data, error } = await supabase
    .from("insurance_plans")
    .select(
      "canonical_plan_id, source, verification_status, in_deductible_individual, in_deductible_family, out_deductible_individual, out_deductible_family, in_oop_max_individual, in_oop_max_family, out_oop_max_individual, out_oop_max_family, in_coinsurance_default, out_coinsurance_default, deductible_calc_method, combined_medical_rx_oop, coverage_tier",
    )
    .eq("id", insurancePlanId)
    .maybeSingle();
  if (error) {
    console.warn("[cost-share-loader] loadPlanCostShareParams failed", insurancePlanId, error);
    return null;
  }
  if (!data) return null;
  const d = data as Record<string, unknown>;

  // ── S288 canonical fallback ───────────────────────────────────────────────
  // A catalog-matched plan (search-select / "Change plan") is LINK-ONLY — its
  // user row carries identity + canonical_plan_id but no numeric terms, so
  // without this the cost-share engine ran deductible math blind ("your bill
  // has no issues"). When any core numeric is null and the row is canonical-
  // linked, fill the gaps from canonical_plans (aligned F.0 columns; read-time,
  // user values always win, no writes anywhere). Fail-open: on any error the
  // user-row values stand.
  const canonicalId = (d.canonical_plan_id as string | null) ?? null;
  if (canonicalId && PLAN_TERM_NUMERIC_COLS.some((k) => d[k] == null)) {
    try {
      const { data: canon, error: canonErr } = await supabase
        .from("canonical_plans")
        .select([...new Set(Object.values(CANONICAL_TERM_COL))].join(", "))
        .eq("id", canonicalId)
        .maybeSingle();
      if (canonErr) {
        console.warn("[cost-share-loader] canonical terms fallback failed", canonicalId, canonErr.message);
      } else if (canon) {
        // Dynamic select string → supabase-js can't type the row; safe by construction.
        const c = canon as unknown as Record<string, unknown>;
        for (const k of PLAN_TERM_NUMERIC_COLS) {
          if (d[k] == null && c[CANONICAL_TERM_COL[k]] != null) d[k] = c[CANONICAL_TERM_COL[k]];
        }
      }
    } catch (fallbackErr) {
      console.warn("[cost-share-loader] canonical terms fallback failed", canonicalId, fallbackErr);
    }
  }

  const n = (k: string) => (d[k] as number | null) ?? null;
  return {
    inDeductibleIndividual: n("in_deductible_individual"),
    inDeductibleFamily: n("in_deductible_family"),
    outDeductibleIndividual: n("out_deductible_individual"),
    outDeductibleFamily: n("out_deductible_family"),
    inOopMaxIndividual: n("in_oop_max_individual"),
    inOopMaxFamily: n("in_oop_max_family"),
    outOopMaxIndividual: n("out_oop_max_individual"),
    outOopMaxFamily: n("out_oop_max_family"),
    // plan-level coinsurance may be percent OR decimal → normalize to decimal 0-1.
    inCoinsuranceDefault: normalizeCoinsuranceForStorage(n("in_coinsurance_default")),
    outCoinsuranceDefault: normalizeCoinsuranceForStorage(n("out_coinsurance_default")),
    deductibleCalcMethod: (d.deductible_calc_method as "embedded" | "aggregate" | null) ?? null,
    combinedMedicalRxOop: (d.combined_medical_rx_oop as boolean | null) ?? null,
    coverageTier: (d.coverage_tier as string | null) ?? null,
    // S291 — provenance travels WITH the terms. A plan assembled from a photo
    // of an insurance card (or hand-typed) is the same tier the UI already
    // labels "unverified"; the honesty gate needs that fact to refuse a
    // confident "your bill is correct" built on it. Read from the USER row
    // only — a canonical-terms fallback fills numbers, never provenance.
    //
    // S294 — `verification_status === "unverified"` REMOVED as a trigger.
    // That column is stamped "document_verified" only by a document-parse path,
    // so it really means "this member has not uploaded a plan document" — NOT
    // "these numbers are untrustworthy". A plan chosen from SEARCH is
    // permanently "unverified" by that definition, even though its cost-share
    // comes from Candid's extraction of that plan's own SBC (quoted excerpt,
    // section-verified, 0.9 confidence). It was therefore degraded exactly like
    // a fabricated card copay, permanently, with nothing on screen to resolve
    // — the defect Andrew reported three times.
    //
    // What remains is the real signal and the S291 case this gate exists for:
    // a plan ASSEMBLED from a card photo or hand entry. Per-service trust is
    // now decided by the numbers' own provenance (`costProvenance`), in
    // computeCostShareV2.
    //
    // ⚠ S326 — DO NOT REVERT (Andrew ruling, third occurrence of this class):
    // a `manual` plan WITH a canonical link is a SEARCH-PICKED LIBRARY PLAN —
    // its terms are Candid's cite-grade extraction of that plan's own SBC (the
    // admin/cold-start regeneration pipeline; Stage C min cite 1.00), i.e. the
    // very same filing the member would have uploaded. It passes the honesty
    // gate with the SAME confidence as an uploaded document. The S288 fallback
    // in this function already treats link-only rows as first-class (fills
    // their terms FROM canonical); this veto must not distrust what that
    // machinery deliberately serves. History of the class: S291 keyed on
    // verification_status + source (search picks degraded) → S294 removed
    // verification_status but kept bare `source === "manual"` (search picks
    // STILL degraded — one link short) → S326 keys the veto on the link.
    // verification_status keeps its meaning ("this member's own document was
    // parsed") and the upgrade path stays: an upload still corroborates and
    // overrides. Locked by fixtures/claims/plan-provenance-gate.ts (CI) — a
    // change here that re-degrades linked library plans fails the build.
    provenanceUnverified: planProvenanceUnverified(
      d.source as string | null,
      canonicalId,
    ),
  };
}

/**
 * S326 — the plan-row provenance veto, extracted pure so the CI fixture can
 * pin it (the missing lock that let this class recur three times). True =
 * the honesty gate refuses confident verdicts built on this plan's terms.
 *   insurance_card            → true  (S291: a card scan can invent values)
 *   manual + NO canonical link → true  (unmatched hand entry; typed values
 *                                       still ground per-service via `user`)
 *   manual + canonical link   → FALSE (search-picked library plan — trusted
 *                                       like the member's own document; the
 *                                       S326 Andrew ruling)
 *   anything else             → false (document-parsed / legacy fails open)
 */
export function planProvenanceUnverified(
  source: string | null,
  canonicalPlanId: string | null,
): boolean {
  if (source === "insurance_card") return true;
  if (source === "manual") return canonicalPlanId == null;
  return false;
}

// ── Accumulators (claim_accumulators) ──────────────────────────────────────

export interface RawAccumulator {
  benefitYear: string;
  networkTier: string;
  accumulatorType: string;
  isIndividual: boolean;
  deductibleApplied: number | null;
  deductibleMax: number | null;
  oopApplied: number | null;
  oopMax: number | null;
}

export async function loadClaimAccumulators(
  supabase: SupabaseClient,
  claimId: string | null | undefined,
): Promise<RawAccumulator[]> {
  if (!claimId) return [];
  const { data, error } = await supabase
    .from("claim_accumulators")
    .select(
      "benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max",
    )
    .eq("claim_id", claimId);
  if (error) {
    console.warn("[cost-share-loader] loadClaimAccumulators failed", claimId, error);
    return [];
  }
  return (data ?? []).map(mapRawAccumulator);
}

export function mapRawAccumulator(row: unknown): RawAccumulator {
  const r = row as Record<string, unknown>;
  const n = (k: string) => (r[k] as number | null) ?? null;
  return {
    benefitYear: String(r.benefit_year ?? ""),
    networkTier: String(r.network_tier ?? "unknown"),
    accumulatorType: String(r.accumulator_type ?? "medical"),
    isIndividual: Boolean(r.is_individual),
    deductibleApplied: n("deductible_applied"),
    deductibleMax: n("deductible_max"),
    oopApplied: n("oop_applied"),
    oopMax: n("oop_max"),
  };
}

/**
 * Pick the accumulator row that best matches a line's (benefit_year, network,
 * type, individual/family) grain. Requires network alignment (in- vs
 * out-of-network deductibles differ); prefers exact type, then combined/medical.
 * No reasonable match → null (engine then runs conservative not-met).
 */
export function resolveAccumulatorForLine(
  rows: RawAccumulator[],
  key: { benefitYear: string | null; networkTier: NetworkTier; accumulatorType: string; isIndividual: boolean },
): AccumulatorSnapshot | null {
  if (!rows.length) return null;
  const candidates = rows.filter(
    (r) =>
      (key.benefitYear == null || r.benefitYear === key.benefitYear) &&
      (r.networkTier === key.networkTier || r.networkTier === "unknown"),
  );
  if (!candidates.length) return null;
  const score = (r: RawAccumulator) =>
    (r.networkTier === key.networkTier ? 4 : 0) +
    (r.isIndividual === key.isIndividual ? 2 : 0) +
    (r.accumulatorType === key.accumulatorType
      ? 2
      : r.accumulatorType === "combined" || r.accumulatorType === "medical"
        ? 1
        : 0);
  const best = candidates.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s)[0].r;
  return {
    deductibleApplied: best.deductibleApplied,
    deductibleMax: best.deductibleMax,
    oopApplied: best.oopApplied,
    oopMax: best.oopMax,
  };
}

/**
 * Subtract THIS claim's own consumption from a YTD accumulator to recover the
 * PRE-claim snapshot. EOB accumulators usually reflect state AFTER the claim;
 * feeding that as-is would make this claim's lines look post-deductible (a false
 * recovery). `consumed` comes from the claim's member_* sums (route, Step 3).
 */
export function applyPreClaimAdjustment(
  snapshot: AccumulatorSnapshot | null,
  consumed: { deductible: number; oop: number },
): AccumulatorSnapshot | null {
  if (!snapshot) return null;
  return {
    deductibleApplied:
      snapshot.deductibleApplied != null ? Math.max(0, snapshot.deductibleApplied - consumed.deductible) : null,
    deductibleMax: snapshot.deductibleMax,
    oopApplied: snapshot.oopApplied != null ? Math.max(0, snapshot.oopApplied - consumed.oop) : null,
    oopMax: snapshot.oopMax,
  };
}

// ── User overrides (user_plan_cost_share_overrides + claims.user_network_override) ──

export async function loadCostShareOverrides(
  supabase: SupabaseClient,
  userId: string | null | undefined,
  insurancePlanId: string | null | undefined,
  planYear: number | null | undefined,
  userNetworkOverride: "in_network" | "out_of_network" | null,
): Promise<CostShareOverrides> {
  const base: CostShareOverrides = {
    deductibleMet: null,
    deductibleMetAsOf: null,
    oopMet: null,
    oopMetAsOf: null,
    userNetworkOverride: userNetworkOverride ?? null,
  };
  if (!userId || !insurancePlanId || planYear == null) return base;
  const { data, error } = await supabase
    .from("user_plan_cost_share_overrides")
    .select("deductible_met, deductible_met_as_of, oop_met, oop_met_as_of")
    .eq("user_id", userId)
    .eq("insurance_plan_id", insurancePlanId)
    .eq("plan_year", planYear)
    .maybeSingle();
  if (error || !data) return base;
  const d = data as Record<string, unknown>;
  return {
    deductibleMet: (d.deductible_met as boolean | null) ?? null,
    deductibleMetAsOf: (d.deductible_met_as_of as string | null) ?? null,
    oopMet: (d.oop_met as boolean | null) ?? null,
    oopMetAsOf: (d.oop_met_as_of as string | null) ?? null,
    userNetworkOverride: userNetworkOverride ?? null,
  };
}

/**
 * Apply the "met as of {date}" semantics for a specific bill. A "met as of
 * March 1" override only marks met for bills on/after March 1; an earlier bill
 * was genuinely still pre-deductible → known-not-met (false, not null — the user
 * gave us authoritative information that it wasn't met yet). ISO dates compare
 * lexicographically.
 */
export function resolveOverridesForBill(
  raw: CostShareOverrides,
  billDate: string | null,
): CostShareOverrides {
  const onOrAfter = (asOf: string | null) => billDate == null || asOf == null || billDate >= asOf;
  return {
    ...raw,
    deductibleMet: raw.deductibleMet === true ? onOrAfter(raw.deductibleMetAsOf) : raw.deductibleMet,
    oopMet: raw.oopMet === true ? onOrAfter(raw.oopMetAsOf) : raw.oopMet,
  };
}

// ── Route-side helpers (Step 3 wiring; shared by the detail + list routes so
//    they assemble byte-identical engine inputs) ───────────────────────────

/**
 * The engine requires a non-null PlanCostShareParams. When a claim's
 * insurance_plan_id is null or has no row, the route passes this all-null set =
 * "unknown plan" (the engine then runs its conservative / insufficient path).
 */
export const EMPTY_PLAN_COST_SHARE_PARAMS: PlanCostShareParams = {
  inDeductibleIndividual: null,
  inDeductibleFamily: null,
  outDeductibleIndividual: null,
  outDeductibleFamily: null,
  inOopMaxIndividual: null,
  inOopMaxFamily: null,
  outOopMaxIndividual: null,
  outOopMaxFamily: null,
  inCoinsuranceDefault: null,
  outCoinsuranceDefault: null,
  deductibleCalcMethod: null,
  combinedMedicalRxOop: null,
  coverageTier: null,
};

/**
 * Map a claim_line_items row's insurer breakdown (`member_*`, `denied_amount`,
 * `insurance_paid`) into the engine's InsurerAdjudication. `insurance_paid` is
 * passed RAW (null-preserving): the engine distinguishes null ("no insurer
 * signal") from 0 in its no-defensible-basis + reconciliation logic, so a
 * header-prorated 0 must NOT be substituted here.
 */
export function buildLineInsurer(item: Record<string, unknown>): InsurerAdjudication {
  const n = (k: string) => (item[k] == null ? null : Number(item[k]));
  return {
    memberAppliedToDeductible: n("member_applied_to_deductible"),
    memberCoinsurance: n("member_coinsurance"),
    memberCopay: n("member_copay"),
    deniedAmount: n("denied_amount"),
    insurancePaid: n("insurance_paid"),
  };
}

/**
 * Coerce a stored network_status string to a NetworkTier; null when absent or
 * unrecognized (engine then assumes in-network + surfaces the assumption).
 */
export function coerceNetworkTier(v: unknown): NetworkTier | null {
  return v === "in_network" || v === "out_of_network" || v === "tiered" || v === "unknown"
    ? v
    : null;
}

/**
 * A user network override is only ever in/out-of-network (a deliberate
 * correction); tiered/unknown are not user-settable corrections → null.
 */
export function coerceNetworkOverride(v: unknown): "in_network" | "out_of_network" | null {
  return v === "in_network" || v === "out_of_network" ? v : null;
}

/** Cost-Share v2 dispute-assertion threshold — flag-config tunable (Ship Gate
 *  G6), mirroring loadSecondaryGate. */
export interface CostShareGate {
  minRecovery: number;
}
export const DEFAULT_COST_SHARE_GATE: CostShareGate = { minRecovery: 1 };
export async function loadCostShareGate(supabase: SupabaseClient): Promise<CostShareGate> {
  const { data } = await supabase
    .from("feature_flag_rules")
    .select("config")
    .eq("flag_key", "recovery_cost_share_v2")
    .maybeSingle();
  const cfg = (data?.config as Record<string, unknown> | null) ?? null;
  return {
    minRecovery:
      typeof cfg?.minRecovery === "number"
        ? (cfg.minRecovery as number)
        : DEFAULT_COST_SHARE_GATE.minRecovery,
  };
}
