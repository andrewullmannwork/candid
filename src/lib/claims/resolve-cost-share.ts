/**
 * §18.9 / §18.10 — the SHARED cost-share resolution layer.
 *
 * `computeCostShareV2` (the deductible-aware recovery engine, recovery-math.ts) needs
 * a fully-RESOLVED per-line input set: resolved coverage (ACA-fallback + secondary),
 * a resolved accumulator snapshot, the per-line insurance-adjusted proration, the
 * service + insurer builders, preventive membership, and the min-recovery gate. Today
 * that resolution lives INLINE in the card routes (`/api/claims` list at
 * route.ts:413-516, `/api/claims/[claimId]` detail). The dispute path loads the RAW
 * basis (`loadFingerprintInputForClaim` -> `loadCostShareBasis`) but only HASHES it —
 * it never resolves it or runs the engine, which is exactly why the dispute letter's
 * dollars are deductible-BLIND (`evidence-resolver.discrepancyAmount`).
 *
 * This module extracts that per-line resolution into ONE function both the card AND
 * the dispute path call (the §17.4 + §18.9 "load + resolve ONCE" unification). It is a
 * faithful, byte-for-byte mirror of the card's inline assembly — the regression-sensitive
 * crux is that swapping the card to call this MUST leave the card's numbers unchanged
 * (proven by a parity test before any swap; this module is ADDITIVE until then).
 *
 * Pure given its inputs: all DB / flag / batch loading happens in the caller and is
 * passed in via `CostShareClaimCtx`. No Supabase, no flags, no I/O here.
 */
import {
  computeCostShareV2,
  isFamilyTier,
  resolveStillOutstanding,
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
import {
  resolveEffectiveClaimTotals,
  resolvePerLineInsuranceAdjusted,
} from "./effective-totals";
import {
  resolveLineCoverage,
  resolveSecondaryCoverage,
  type PlanCoverageMeta,
  type BillSlugMeta,
} from "../audit/coverage-loader";

/** The ACA preventive-coverage fallback shape produced by `buildAcaCoverageFallback`. */
export interface AcaCoverageFallback {
  byLineNumber: Map<number, PlanCoverageInput | null>;
  planMeta: Parameters<typeof resolveLineCoverage>[2];
}

/** Secondary-coverage gate flags (read from feature flags by the caller). */
export interface SecondaryCoverageGate {
  enabled: boolean;
  meta: PlanCoverageMeta | null;
  billSlugMeta: Map<string, BillSlugMeta> | null;
  gate: Parameters<typeof resolveSecondaryCoverage>[4];
}

/**
 * The fully-loaded per-CLAIM context the engine needs. The caller assembles this ONCE
 * per claim from the batched/single loaders (the card does exactly this at
 * route.ts:300-374); the dispute path will via `loadDisputeGroundBasis` (increment 2).
 */
export interface CostShareClaimCtx {
  planParams: PlanCostShareParams | null;
  overrides: CostShareOverrides | null;
  accRows: RawAccumulator[];
  memberSums: { deductible: number; oop: number };
  /** the resolved effective-claim totals (drives per-line insurance-adjusted proration). */
  effectiveTotals: ReturnType<typeof resolveEffectiveClaimTotals> | null;
  preventiveLines: Set<number>;
  acaStatus: "confirmed" | "unknown" | "non_aca";
  claimInsurerPaidZero: boolean;
  gate: CostShareGate;
  networkClaim: ReturnType<typeof coerceNetworkTier>;
  /** exact-slug plan coverage map (service_slug -> coverage). */
  coverageMap: Map<string, PlanCoverageInput> | null;
  aca: AcaCoverageFallback;
  secondary: SecondaryCoverageGate;
  coverageTier: string | null;
  planYear: number | null;
  claimTotalBilled: number;
  claimStillOutstanding: number | null;
}

/** The raw per-line fields the resolution reads (a subset of a claim_line_items row). */
export interface CostShareLineInput {
  lineNumber: number | null;
  serviceSlug: string | null;
  billedAmount: number | null;
  insuranceAdjustedAmount: number | null;
  patientPaidAmount: number | null;
  patientOwes: number | null;
  amountStillOutstanding: number | null;
  networkStatus: string | null;
  /** passed through to `buildLineInsurer` (member_* + denied + insurance_paid fields). */
  raw: Record<string, unknown>;
}

export interface ResolvedLineCostShare {
  lineNumber: number | null;
  result: CostShareV2Result;
  /** the resolved coverage the engine consumed (for caller reuse + parity). */
  coverage: PlanCoverageInput | null;
  billed: number;
  patientResponsibility: number;
  lineInsAdj: number;
}

const EMPTY_OVERRIDES: CostShareOverrides = {
  deductibleMet: null,
  deductibleMetAsOf: null,
  oopMet: null,
  oopMetAsOf: null,
  userNetworkOverride: null,
};

/**
 * Resolve ONE line into its `computeCostShareV2` result. Faithful mirror of the card's
 * per-line assembly (route.ts:413-516, the costShareV2 branch). Pure given ctx.
 */
export function resolveCostShareForLine(
  line: CostShareLineInput,
  ctx: CostShareClaimCtx,
): ResolvedLineCostShare {
  const lineNumber = line.lineNumber;
  const billed = Number(line.billedAmount || 0);
  const owed = Number(line.patientOwes || 0);
  const patientPaid = Number(line.patientPaidAmount ?? 0);

  // Coverage: exact slug -> secondary (category) -> ACA fallback, resolved via the
  // 4-state matrix (ACA wins on conflict; plan wins on match). Mirrors route.ts:427-454.
  let rawPlanCoverage: PlanCoverageInput | null =
    (line.serviceSlug && ctx.coverageMap?.get(line.serviceSlug)) || null;
  if (ctx.secondary.enabled && !rawPlanCoverage && line.serviceSlug && ctx.secondary.billSlugMeta) {
    const meta = ctx.secondary.billSlugMeta.get(line.serviceSlug);
    if (meta) {
      const sec = resolveSecondaryCoverage(
        line.serviceSlug,
        meta,
        ctx.secondary.meta?.coveredMeta ?? [],
        ctx.secondary.meta?.acaCompliant ?? null,
        ctx.secondary.gate,
      );
      if (sec) rawPlanCoverage = sec.coverage;
    }
  }
  const acaCoverage: PlanCoverageInput | null =
    ctx.aca.byLineNumber.get(Number(lineNumber ?? 0)) || null;
  const { coverage } = resolveLineCoverage(rawPlanCoverage, acaCoverage, ctx.aca.planMeta);

  const patientResponsibility =
    owed ||
    resolveStillOutstanding({
      lineBilled: billed,
      lineStillOutstanding:
        line.amountStillOutstanding != null ? Number(line.amountStillOutstanding) : null,
      linePatientOwes: owed,
      claimTotalBilled: ctx.claimTotalBilled,
      claimStillOutstanding: ctx.claimStillOutstanding,
    });

  const lineNetwork = coerceNetworkTier(line.networkStatus);
  const { value: lineInsAdj } = resolvePerLineInsuranceAdjusted({
    lineBilled: billed,
    lineInsuranceAdjusted:
      line.insuranceAdjustedAmount != null ? Number(line.insuranceAdjustedAmount) : null,
    claimTotalBilled: ctx.claimTotalBilled,
    effectiveClaimInsuranceAdjusted: ctx.effectiveTotals!,
  });
  const accumulator = applyPreClaimAdjustment(
    resolveAccumulatorForLine(ctx.accRows, {
      benefitYear: ctx.planYear != null ? String(ctx.planYear) : null,
      networkTier: lineNetwork ?? "in_network",
      accumulatorType: "medical",
      isIndividual: !isFamilyTier(ctx.coverageTier),
    }),
    ctx.memberSums,
  );

  const result = computeCostShareV2({
    line: {
      billed,
      allowed: Math.max(0, billed - lineInsAdj),
      insuranceAdjusted: lineInsAdj,
      patientPaid,
      patientResponsibility,
    },
    service: buildServiceCostShare(coverage),
    insurer: buildLineInsurer(line.raw),
    plan: ctx.planParams ?? EMPTY_PLAN_COST_SHARE_PARAMS,
    accumulator,
    overrides: ctx.overrides ?? EMPTY_OVERRIDES,
    networkLine: lineNetwork,
    networkClaim: ctx.networkClaim,
    minRecovery: ctx.gate.minRecovery,
    preventive: {
      isPreventive: ctx.preventiveLines.has(Number(lineNumber ?? 0)),
      acaStatus: ctx.acaStatus,
    },
    claimInsurerPaidZero: ctx.claimInsurerPaidZero,
  });

  return { lineNumber, result, coverage, billed, patientResponsibility, lineInsAdj };
}

/**
 * Resolve every line of a claim. Returns a per-line result list IN INPUT ORDER plus a
 * `byLine` index keyed by line number (the dispute path keys `shouldOwePerLine` off this).
 */
export function resolveCostShareForLines(
  lines: CostShareLineInput[],
  ctx: CostShareClaimCtx,
): { lines: ResolvedLineCostShare[]; byLine: Map<number, ResolvedLineCostShare> } {
  const out: ResolvedLineCostShare[] = [];
  const byLine = new Map<number, ResolvedLineCostShare>();
  for (const line of lines) {
    const resolved = resolveCostShareForLine(line, ctx);
    out.push(resolved);
    if (resolved.lineNumber != null) byLine.set(resolved.lineNumber, resolved);
  }
  return { lines: out, byLine };
}
