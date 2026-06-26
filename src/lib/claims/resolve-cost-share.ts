/**
 * §18.9 / §18.10 — the SHARED cost-share resolution layer.
 *
 * `computeCostShareV2` (the deductible-aware recovery engine, recovery-math.ts) is invoked
 * inline in BOTH card routes (`/api/claims` list at route.ts:488, `/api/claims/[claimId]`
 * detail at route.ts:539) and — once wired — the dispute path. This module extracts the
 * part of that per-line assembly the routes share VERBATIM into one function, so the card
 * and the dispute letter can never drift on how a resolved line becomes an engine call.
 *
 * BOUNDARY (parity-critical): the list and detail routes genuinely DIVERGE on a few
 * per-line PREP values — `patientResponsibility` (list `owed || resolveStillOutstanding`
 * vs detail `patient_owes != null ? … : resolveStillOutstanding` — different when
 * patient_owes is 0/null) and the coverage resolution. So those divergent values are
 * CALLER-SUPPLIED inputs, NOT computed here. This module owns ONLY the verbatim-shared
 * assembly: network coercion, the accumulator resolution (identical in both routes), the
 * service/insurer builders, and the `computeCostShareV2` call. That makes it byte-identical
 * to BOTH routes by construction (each passes its own prep), which the parity fixture
 * (`scripts/calibration/fixtures/cost-share-v2/route-inputs.ts`) locks before any swap.
 *
 * Pure given its inputs: all DB / flag / batch loading + the divergent prep happen in the
 * caller and arrive via `CostShareClaimCtx` + `CostShareLineInput`. No Supabase, no flags.
 */
import {
  computeCostShareV2,
  isFamilyTier,
  type PlanCoverageInput,
  type PlanCostShareParams,
  type CostShareOverrides,
  type CostShareV2Result,
} from "./recovery-math";
import {
  buildServiceCostShare,
  resolveAccumulatorForLine,
  applyPreClaimAdjustment,
  buildLineInsurer,
  coerceNetworkTier,
  EMPTY_PLAN_COST_SHARE_PARAMS,
  type RawAccumulator,
  type CostShareGate,
} from "./cost-share-loader";

/**
 * The fully-loaded per-CLAIM context (the verbatim-shared engine inputs). The caller
 * assembles this ONCE per claim from the loaders (the card does so at route.ts:300-374;
 * the dispute path will via `loadDisputeGroundBasis`, increment 2). All values are
 * identical between the list + detail routes.
 */
export interface CostShareClaimCtx {
  planParams: PlanCostShareParams | null;
  overrides: CostShareOverrides | null;
  accRows: RawAccumulator[];
  memberSums: { deductible: number; oop: number };
  preventiveLines: Set<number>;
  acaStatus: "confirmed" | "unknown" | "non_aca";
  claimInsurerPaidZero: boolean;
  gate: CostShareGate;
  networkClaim: ReturnType<typeof coerceNetworkTier>;
  /** plan coverage tier — drives the accumulator individual/family param pick. */
  coverageTier: string | null;
  /** benefit year for the accumulator lookup (claim date-of-service UTC year). */
  planYear: number | null;
}

/**
 * The per-line inputs. `allowed` / `insuranceAdjusted` / `patientResponsibility` / `coverage`
 * are CALLER-RESOLVED (the routes prepare them their own way — see BOUNDARY above), so this
 * function stays byte-identical to whichever caller invokes it.
 */
export interface CostShareLineInput {
  lineNumber: number | null;
  billed: number;
  /** caller-prorated allowed (= Math.max(0, billed − insuranceAdjusted)). */
  allowed: number;
  /** caller-prorated per-line insurance writeoff (`resolvePerLineInsuranceAdjusted`). */
  insuranceAdjusted: number;
  patientPaid: number;
  /** caller-resolved (list vs detail differ on patient_owes 0/null). */
  patientResponsibility: number;
  /** caller-resolved coverage (exact-slug → secondary → ACA-fallback matrix). */
  coverage: PlanCoverageInput | null;
  networkStatus: string | null;
  /** the raw claim_line_items row, for `buildLineInsurer` (member_* + denied + insurance_paid). */
  raw: Record<string, unknown>;
}

const EMPTY_OVERRIDES: CostShareOverrides = {
  deductibleMet: null,
  deductibleMetAsOf: null,
  oopMet: null,
  oopMetAsOf: null,
  userNetworkOverride: null,
};

/**
 * Resolve ONE line into its `computeCostShareV2` result. Byte-identical to the inline card
 * assembly given the same (line, ctx) — it reproduces exactly the network-coerce +
 * accumulator-resolve + service/insurer-build + engine-call the routes do verbatim.
 */
export function resolveCostShareForLine(
  line: CostShareLineInput,
  ctx: CostShareClaimCtx,
): CostShareV2Result {
  const lineNetwork = coerceNetworkTier(line.networkStatus);
  const accumulator = applyPreClaimAdjustment(
    resolveAccumulatorForLine(ctx.accRows, {
      benefitYear: ctx.planYear != null ? String(ctx.planYear) : null,
      networkTier: lineNetwork ?? "in_network",
      accumulatorType: "medical",
      isIndividual: !isFamilyTier(ctx.coverageTier),
    }),
    ctx.memberSums,
  );
  return computeCostShareV2({
    line: {
      billed: line.billed,
      allowed: line.allowed,
      insuranceAdjusted: line.insuranceAdjusted,
      patientPaid: line.patientPaid,
      patientResponsibility: line.patientResponsibility,
    },
    service: buildServiceCostShare(line.coverage),
    insurer: buildLineInsurer(line.raw),
    plan: ctx.planParams ?? EMPTY_PLAN_COST_SHARE_PARAMS,
    accumulator,
    overrides: ctx.overrides ?? EMPTY_OVERRIDES,
    networkLine: lineNetwork,
    networkClaim: ctx.networkClaim,
    minRecovery: ctx.gate.minRecovery,
    preventive: {
      isPreventive: ctx.preventiveLines.has(Number(line.lineNumber ?? 0)),
      acaStatus: ctx.acaStatus,
    },
    claimInsurerPaidZero: ctx.claimInsurerPaidZero,
  });
}

/**
 * Resolve every line of a claim → a `lineNumber → CostShareV2Result` map. The dispute path
 * (increment 2) maps each line's `shouldOwe` to its `lineItemId` for `computeCappedRecovery`.
 */
export function resolveCostShareForLines(
  lines: CostShareLineInput[],
  ctx: CostShareClaimCtx,
): Map<number, CostShareV2Result> {
  const byLine = new Map<number, CostShareV2Result>();
  for (const line of lines) {
    if (line.lineNumber == null) continue;
    byLine.set(line.lineNumber, resolveCostShareForLine(line, ctx));
  }
  return byLine;
}
