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
  resolvePerLinePatientPaid,
  resolvePerLineInsuranceAdjusted,
  type EffectiveClaimTotals,
} from "./effective-totals";
import {
  resolveLineCoverage,
  resolveSecondaryCoverage,
  type CoveredSlugMeta,
  type BillSlugMeta,
  type SecondaryMatchGate,
} from "../audit/coverage-loader";
import type { AcaFallbackResult } from "../audit/aca-coverage-fallback";

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
  /**
   * S291 — `unverified_plan_honesty_gate_v1` (mig 216) resolved at the route.
   * Optional: absent → OFF → prior verdict behaviour exactly.
   */
  unverifiedPlanHonestyGate?: boolean;
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
    unverifiedPlanHonestyGate: ctx.unverifiedPlanHonestyGate,
  });
}

/**
 * Resolve every line of a claim → a `lineNumber → CostShareV2Result` map. The dispute path
 * (increment 2) maps each line's `shouldOwe` to its `lineItemId` for `resolveLetterRecovery`.
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

// ============================================================================
// §18.10 — the per-line PREP recipe (one level up from resolveCostShareForLine).
//
// `resolveCostShareForLine` (above) owns the engine assembly the routes shared
// VERBATIM. The PREP around it — coverage resolution (exact slug → secondary →
// ACA fallback), the writeoff proration + allowed, and patientPaid /
// patientResponsibility — was still inline + duplicated in the list route, the
// detail route, AND (newly) the dispute path. `resolveLineCostShare` extracts
// that prep so all three callers compute a line's recovery identically (the §18
// "card recovery == letter ask" guarantee, made structural). The ONLY route-
// divergent values are patientPaid + patientResponsibility — `strategy` selects
// list vs detail (parity-locked vs the prior inline by
// scripts/calibration/fixtures/cost-share-v2/prep-parity.ts).
//
// Pure: no DB, no flags. The caller loads the per-claim inputs its own way (the
// list route batches; the detail route + dispute path load per-claim) and
// passes the secondary_coverage_v2 flag value as `secondaryEnabled`.
// ============================================================================

export type CostSharePrepStrategy = "list" | "detail";

/** Per-CLAIM resolution inputs the per-line prep reads (loaded by the caller). */
export interface ClaimCostSharePrep {
  /** plan coverage by slug (incl. `.source` for attribution). Empty Map when no plan. */
  coverageMap: Map<string, PlanCoverageInput & { source?: string | null }>;
  /** covered-slug metadata for the secondary (category) match. */
  coveredMeta: CoveredSlugMeta[];
  /** bill-slug metadata (category + ACA-preventive eligibility) for the secondary match. */
  billSlugMeta: Map<string, BillSlugMeta>;
  planAcaCompliant: boolean | null;
  secondaryGate: SecondaryMatchGate;
  /** `secondary_coverage_v2` flag value — false ⇒ exact-slug coverage only. */
  secondaryEnabled: boolean;
  acaFallback: AcaFallbackResult;
  claimTotalBilled: number;
  claimStillOutstanding: number | null;
  effectiveTotals: EffectiveClaimTotals;
}

/** The resolved per-line PREP — coverage attribution + prorated money + provenance,
 *  WITHOUT the engine result. Shared by both card-route branches (the v2 engine when
 *  recovery_cost_share_v2 is ON, the legacy computeRecoveryV2 when OFF) + the display
 *  fields — so the prep is computed once regardless of which engine runs. */
export interface ResolvedLinePrep {
  coverage: PlanCoverageInput | null;
  coverageSource: string | null;
  secondaryMatchedSlug: string | null;
  secondaryConfidence: "confident" | "estimate" | null;
  acaOverride: ReturnType<typeof resolveLineCoverage>["acaOverride"];
  allowed: number;
  patientPaid: number;
  patientPaidSource: "per_line" | "header_prorated";
  insuranceAdjusted: number;
  insuranceAdjustedSource: "per_line" | "header_prorated";
  patientResponsibility: number;
  patientResponsibilitySource: "per_line" | "header_prorated";
}

/** The prep bundle + the v2 engine result (what the dispute path + the costShareV2-ON
 *  card branch use). */
export interface ResolvedLineCostShare extends ResolvedLinePrep {
  result: CostShareV2Result;
}

/**
 * Resolve ONE raw claim_line_items row → its cost-share PREP (no engine), reproducing
 * the inline prep the list + detail routes ran (byte-identical given the same inputs +
 * strategy). `raw` is the snake_case DB row. The caller runs the engine it wants
 * (resolveCostShareForLine when costShareV2 ON; computeRecoveryV2 when OFF) — or uses
 * `resolveLineCostShare` for the prep + v2 engine in one call.
 */
export function resolveLinePrep(
  raw: Record<string, unknown>,
  prep: ClaimCostSharePrep,
  strategy: CostSharePrepStrategy,
): ResolvedLinePrep {
  const slug = (raw.service_slug as string | null) ?? null;
  const billed = Number(raw.billed_amount || 0);
  const lineNumber = Number(raw.line_number ?? 0);

  // ── coverage: exact slug → secondary (category) → ACA fallback ──
  let rawPlanCoverage: PlanCoverageInput | null = slug
    ? prep.coverageMap.get(slug) ?? null
    : null;
  let secondaryMatchedSlug: string | null = null;
  let secondaryCoverageSource: "secondary_match" | "aca_preventive" | null = null;
  let secondaryConfidence: "confident" | "estimate" | null = null;
  if (prep.secondaryEnabled && !rawPlanCoverage && slug) {
    const meta = prep.billSlugMeta.get(slug);
    if (meta) {
      const sec = resolveSecondaryCoverage(
        slug,
        meta,
        prep.coveredMeta,
        prep.planAcaCompliant,
        prep.secondaryGate,
      );
      if (sec) {
        rawPlanCoverage = sec.coverage;
        secondaryMatchedSlug = sec.matchedSlug;
        secondaryCoverageSource = sec.source;
        secondaryConfidence = sec.confidence;
      }
    }
  }
  const acaCoverage: PlanCoverageInput | null =
    prep.acaFallback.byLineNumber.get(lineNumber) || null;
  const { coverage, acaOverride } = resolveLineCoverage(
    rawPlanCoverage,
    acaCoverage,
    prep.acaFallback.planMeta,
  );
  const coverageFromAca = coverage === acaCoverage && coverage != null;
  const coverageSource = coverageFromAca
    ? "aca_zero_cost_share"
    : secondaryCoverageSource
      ? secondaryCoverageSource
      : coverage && slug
        ? prep.coverageMap.get(slug)?.source ?? null
        : null;

  // ── writeoff proration + allowed (shared) ──
  const { value: insuranceAdjusted, source: insuranceAdjustedSource } =
    resolvePerLineInsuranceAdjusted({
      lineBilled: billed,
      lineInsuranceAdjusted:
        raw.insurance_adjusted_amount != null
          ? Number(raw.insurance_adjusted_amount)
          : null,
      claimTotalBilled: prep.claimTotalBilled,
      effectiveClaimInsuranceAdjusted: prep.effectiveTotals,
    });
  const allowed = Math.max(0, billed - insuranceAdjusted);

  // ── patientPaid (route-divergent: detail cite-grade/prorated vs list raw) ──
  let patientPaid: number;
  let patientPaidSource: "per_line" | "header_prorated";
  if (strategy === "detail") {
    const r = resolvePerLinePatientPaid({
      lineBilled: billed,
      linePatientPaid:
        raw.patient_paid_amount != null ? Number(raw.patient_paid_amount) : null,
      claimTotalBilled: prep.claimTotalBilled,
      effectiveClaimPatientPaid: prep.effectiveTotals,
    });
    patientPaid = r.value;
    patientPaidSource = r.source;
  } else {
    patientPaid = Number(raw.patient_paid_amount ?? 0);
    patientPaidSource = "per_line";
  }

  // ── patientResponsibility (route-divergent: detail `!=null` vs list `owed||`) ──
  let patientResponsibility: number;
  if (strategy === "detail") {
    patientResponsibility =
      raw.patient_owes != null
        ? Number(raw.patient_owes)
        : resolveStillOutstanding({
            lineBilled: billed,
            lineStillOutstanding:
              raw.amount_still_outstanding != null
                ? Number(raw.amount_still_outstanding)
                : null,
            linePatientOwes: null,
            claimTotalBilled: prep.claimTotalBilled,
            claimStillOutstanding: prep.claimStillOutstanding,
          });
  } else {
    const owed = Number(raw.patient_owes || 0);
    patientResponsibility =
      owed ||
      resolveStillOutstanding({
        lineBilled: billed,
        lineStillOutstanding:
          raw.amount_still_outstanding != null
            ? Number(raw.amount_still_outstanding)
            : null,
        linePatientOwes: owed,
        claimTotalBilled: prep.claimTotalBilled,
        claimStillOutstanding: prep.claimStillOutstanding,
      });
  }
  const patientResponsibilitySource: "per_line" | "header_prorated" =
    raw.patient_owes != null ? "per_line" : "header_prorated";

  return {
    coverage,
    coverageSource,
    secondaryMatchedSlug,
    secondaryConfidence,
    acaOverride,
    allowed,
    patientPaid,
    patientPaidSource,
    insuranceAdjusted,
    insuranceAdjustedSource,
    patientResponsibility,
    patientResponsibilitySource,
  };
}

/**
 * Resolve ONE raw row → prep + the v2 engine result (resolveLinePrep +
 * resolveCostShareForLine). The dispute path + the costShareV2-ON card branch use this;
 * the OFF branch uses resolveLinePrep + computeRecoveryV2 directly (no wasted v2 call).
 */
export function resolveLineCostShare(
  raw: Record<string, unknown>,
  prep: ClaimCostSharePrep,
  ctx: CostShareClaimCtx,
  strategy: CostSharePrepStrategy,
): ResolvedLineCostShare {
  const p = resolveLinePrep(raw, prep, strategy);
  const result = resolveCostShareForLine(
    {
      lineNumber: Number(raw.line_number ?? 0),
      billed: Number(raw.billed_amount || 0),
      allowed: p.allowed,
      insuranceAdjusted: p.insuranceAdjusted,
      patientPaid: p.patientPaid,
      patientResponsibility: p.patientResponsibility,
      coverage: p.coverage,
      networkStatus: (raw.network_status as string | null) ?? null,
      raw,
    },
    ctx,
  );
  return { result, ...p };
}
