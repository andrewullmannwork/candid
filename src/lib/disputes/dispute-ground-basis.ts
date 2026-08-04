/**
 * §18.10 incr-2 — loadDisputeGroundBasis: the deductible-AWARE per-line shouldOwe
 * for a dispute's claims, computed through the SAME shared recipe the card detail
 * route uses (resolveLineCostShare, strategy "detail") so the dispute letter's
 * dollar matches the card the user sees (the §18 "card recovery == letter ask"
 * guarantee). Feeds resolveLetterRecovery (increment 4) — `shouldOwe` bounds the
 * cap; the rich CostShareV2Result also carries verdict + assumptions for §18.10.D
 * (omit-the-precise-dollar-when-unconfirmed, increment 5).
 *
 * STRATEGY = "detail": the dispute is initiated from /claims/[claimId] (the cite-
 * grade single-claim surface), so it mirrors that route's prep — NOT the list
 * route's (which uses the richer loadPlanCoverageMeta coverage shape; a pre-existing
 * list/detail divergence, out of scope here).
 *
 * ADDITIVE / DORMANT this increment: nothing wires this into generate/rerender yet
 * (increment 4 does, behind dispute_grounds_v1). Returns an EMPTY map when
 * recovery_cost_share_v2 is OFF → resolveLetterRecovery stays inert (today's
 * behavior). Conservative-when-blind is the ENGINE's job (recovery-math.ts:279):
 * a line with no plan/coverage data resolves to shouldOwe = full allowed → the cap
 * binds to ~$0, NOT the deductible-blind raw sum. So every resolvable line carries
 * a number; only genuinely-absent lines (flag OFF / foreign claim) stay out of the
 * map. NEVER omit a resolvable line — an omitted line reverts to the raw,
 * deductible-blind over-claim this whole arc exists to kill.
 *
 * Loads mirror /api/claims/[claimId] line-for-line. The §18.5 "load + resolve ONCE"
 * unification (feed BOTH this engine AND the fingerprint from one raw load) is an
 * increment-4 wire-time optimization; this increment loads independently for
 * obvious correctness against the proven route.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped, selectOwnedChildren } from "../security/user-scoped";
import { isFeatureEnabled } from "../config/product-flags";
import {
  loadPlanCostShareParams,
  mapRawAccumulator,
  loadCostShareOverrides,
  resolveOverridesForBill,
  loadCostShareGate,
  coerceNetworkTier,
  coerceNetworkOverride,
} from "../claims/cost-share-loader";
import {
  resolveEffectiveClaimTotals,
  readUserTotalsSource,
  readUserPatientPaidOverride,
  applyUserPatientPaidOverride,
} from "../claims/effective-totals";
import {
  buildAcaCoverageFallback,
  detectPreventiveMembership,
} from "../audit/aca-coverage-fallback";
import {
  loadSecondaryGate,
  loadPlanCoverageMeta,
  DEFAULT_SECONDARY_GATE,
  type CoveredSlugMeta,
  type BillSlugMeta,
} from "../audit/coverage-loader";
import {
  resolveLineCostShare,
  type ClaimCostSharePrep,
  type CostShareClaimCtx,
  type ResolvedLineCostShare,
} from "../claims/resolve-cost-share";
import type {
  CostShareV2Result,
  PlanCoverageInput,
} from "../claims/recovery-math";

/** A fully-loaded per-claim bundle ready for the shared recipe. */
export interface ClaimBasisBundle {
  /** raw claim_line_items rows — MUST include `id` (the lineItemId key) + line_number + the cost-share columns. */
  rawLines: Array<Record<string, unknown>>;
  prep: ClaimCostSharePrep;
  ctx: CostShareClaimCtx;
}

/**
 * PURE core — resolve loaded claim bundles → `lineItemId → CostShareV2Result`.
 * Keys by `claim_line_items.id` (what resolveLetterRecovery + LineItemEvidence use;
 * the recipe keys per lineNumber internally — this is the id bridge). Merges across
 * every claim in the dispute (ids are globally unique). No DB, no flags.
 */
export function resolveDisputeShouldOwe(
  bundles: ClaimBasisBundle[],
): Map<string, CostShareV2Result> {
  const out = new Map<string, CostShareV2Result>();
  for (const bundle of bundles) {
    for (const raw of bundle.rawLines) {
      const id = raw.id;
      if (id == null) continue;
      out.set(String(id), resolveLineCostShare(raw, bundle.prep, bundle.ctx, "detail").result);
    }
  }
  return out;
}

const LINE_COLUMNS =
  // S292 (#7) — `description` + `metadata` added so loadDisputeLineResolutions can
  // label the needs-panel row and read the coverage_user_confirmed/rejected marks.
  // Additive: resolveLineCostShare reads named fields off the raw row; extras are inert.
  "id, line_number, service_slug, description, billed_amount, insurance_adjusted_amount, insurance_paid, patient_paid_amount, patient_owes, amount_still_outstanding, member_applied_to_deductible, member_coinsurance, member_copay, denied_amount, network_status, billing_code, billing_code_type, metadata";

/**
 * S292 (#7) — ONE disputed line's cost-share resolution as the CLAIM PAGE resolves it,
 * surfaced for the dispute needs-panel so it never re-asks a plan cost the platform
 * already knows. Derived from the SAME shared recipe (`resolveLineCostShare`, strategy
 * "detail") that /api/claims/[claimId] runs — NOT a parallel resolver (§18 hard ban on
 * divergent cost-share paths). `coverage` is the resolved PlanCoverageInput (coinsurance
 * already decimal 0-1); `coverageSource` attributes it (manual / sbc_parsed /
 * secondary_match / aca_preventive / aca_zero_cost_share / …) so the panel can split
 * human-entered (DONE) from parser-extracted (prefill + one aggregate confirm).
 */
export interface DisputeLineResolution {
  lineItemId: string;
  lineNumber: number | null;
  serviceSlug: string | null;
  description: string | null;
  coverage: PlanCoverageInput | null;
  coverageSource: string | null;
  secondaryMatchedSlug: string | null;
  secondaryConfidence: "confident" | "estimate" | null;
  /** the user's existing per-line coverage verification marks (confirm-coverage endpoint). */
  coverageUserConfirmed: boolean;
  coverageUserRejected: boolean;
  result: CostShareV2Result;
}

/**
 * Load + resolve every disputed line's FULL claim-page cost-share resolution
 * (prep + engine result), keyed by lineItemId. Same loader + recipe as
 * `loadDisputeGroundBasis` — this is the panel-facing projection of it, not a
 * second resolution path. Empty map when `recovery_cost_share_v2` is OFF
 * (callers degrade to the legacy evidence-derived panel rows).
 */
export async function loadDisputeLineResolutions(
  supabase: SupabaseClient,
  userId: string,
  claimIds: string[],
): Promise<Map<string, DisputeLineResolution>> {
  const out = new Map<string, DisputeLineResolution>();
  if (!(await isFeatureEnabled("recovery_cost_share_v2"))) return out;

  const secondaryEnabled = await isFeatureEnabled("secondary_coverage_v2");
  const secondaryGate = secondaryEnabled
    ? await loadSecondaryGate(supabase)
    : DEFAULT_SECONDARY_GATE;
  const gate = await loadCostShareGate(supabase);

  for (const claimId of Array.from(new Set(claimIds))) {
    const bundle = await loadClaimBasisBundle(
      supabase,
      userId,
      claimId,
      secondaryEnabled,
      secondaryGate,
      gate,
    );
    if (!bundle) continue;
    for (const raw of bundle.rawLines) {
      if (raw.id == null) continue;
      const resolved: ResolvedLineCostShare = resolveLineCostShare(
        raw,
        bundle.prep,
        bundle.ctx,
        "detail",
      );
      const meta = (raw.metadata as Record<string, unknown> | null) ?? {};
      out.set(String(raw.id), {
        lineItemId: String(raw.id),
        lineNumber: raw.line_number != null ? Number(raw.line_number) : null,
        serviceSlug: (raw.service_slug as string | null) ?? null,
        description: (raw.description as string | null) ?? null,
        coverage: resolved.coverage,
        coverageSource: resolved.coverageSource,
        secondaryMatchedSlug: resolved.secondaryMatchedSlug,
        secondaryConfidence: resolved.secondaryConfidence,
        coverageUserConfirmed: meta.coverage_user_confirmed === true,
        coverageUserRejected: meta.coverage_user_rejected === true,
        result: resolved.result,
      });
    }
  }
  return out;
}

/**
 * Load + resolve the deductible-aware shouldOwe for every line of the dispute's
 * claims. Returns the rich result map (keyed by lineItemId) that `resolveLetterRecovery`
 * consumes (behind `dispute_grounds_v1`).
 */
export async function loadDisputeGroundBasis(
  supabase: SupabaseClient,
  userId: string,
  claimIds: string[],
): Promise<Map<string, CostShareV2Result>> {
  // Precondition: the deductible-aware engine is the recovery_cost_share_v2 path.
  // OFF → empty map → resolveLetterRecovery inert (today's deductible-blind behavior).
  if (!(await isFeatureEnabled("recovery_cost_share_v2"))) return new Map();

  const secondaryEnabled = await isFeatureEnabled("secondary_coverage_v2");
  const secondaryGate = secondaryEnabled
    ? await loadSecondaryGate(supabase)
    : DEFAULT_SECONDARY_GATE;
  const gate = await loadCostShareGate(supabase);

  const bundles: ClaimBasisBundle[] = [];
  for (const claimId of Array.from(new Set(claimIds))) {
    const bundle = await loadClaimBasisBundle(
      supabase,
      userId,
      claimId,
      secondaryEnabled,
      secondaryGate,
      gate,
    );
    if (bundle) bundles.push(bundle);
  }
  return resolveDisputeShouldOwe(bundles);
}

async function loadClaimBasisBundle(
  supabase: SupabaseClient,
  userId: string,
  claimId: string,
  secondaryEnabled: boolean,
  secondaryGate: ClaimCostSharePrep["secondaryGate"],
  gate: CostShareClaimCtx["gate"],
): Promise<ClaimBasisBundle | null> {
  // B9 — scope every read to the authenticated user (foreign claimId → null).
  // select("*") matches the detail route (claims/[claimId]/route.ts:114) — its column
  // set is the source of truth for resolveEffectiveClaimTotals + patient_name (which is
  // NOT a claims column today → undefined → null, same as the detail route; future-proof
  // if added). An explicit column list risks selecting a non-existent column (PostgREST errors
  // the whole query → claim null → silently dropped).
  const { data: claim } = await userScoped(supabase, userId)
    .table("claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return null;

  const planId = (claim.insurance_plan_id as string | null) ?? null;
  const rawLines = (
    await selectOwnedChildren(supabase, userId, "claim_line_items", [claimId], LINE_COLUMNS)
  ).sort((a, b) => (Number(a.line_number ?? 0)) - (Number(b.line_number ?? 0)));

  // Dispute Letters v2 (Z1.1b) — user-confirmed amount-paid override. A claim-level figure
  // the user supplied via the cost-share banner (claims.metadata.userPatientPaid, Rule #9).
  // Overlaid here (claim header total_patient_paid + prorated per-line patient_paid_amount
  // kept in sync so header == line-sum) so the letter's refund reflects it via the
  // effective-totals path with no list/detail divergence. No-op when unset → byte-identical.
  const userPatientPaid = readUserPatientPaidOverride(claim.metadata);
  if (userPatientPaid != null) {
    applyUserPatientPaidOverride(
      claim as { total_patient_paid?: number | null },
      rawLines as Array<{
        billed_amount?: number | null;
        patient_paid_amount?: number | null;
      }>,
      userPatientPaid,
    );
  }

  const acaLineItems = rawLines.map((li) => ({
    lineNumber: Number(li.line_number ?? 0),
    procedureCode: (li.billing_code as string | null) ?? null,
    procedureCodeType: (li.billing_code_type as string | null) ?? null,
    serviceSlug: (li.service_slug as string | null) ?? null,
  }));
  const patientName = (claim.patient_name as string | null | undefined) ?? null;

  // ── coverage (RICH) via the canonical loader the list page already uses (Path 2).
  //    Uses the plan's explicit in_deductible_applies (96.8% populated) + OON terms,
  //    which the detail route's prior LEAN inline build dropped (→ a guess that diverged
  //    from the explicit value ~45% of the time). planId comes from an owned claim (the
  //    claim read above is user-scoped), so loadPlanCoverageMeta reads only this user's
  //    plan's coverage. Gives coverageMap + coveredMeta + acaCompliant in one call. ──
  const planMeta = planId
    ? (await loadPlanCoverageMeta(supabase, [planId])).get(planId)
    : undefined;
  const coverageMap: Map<string, PlanCoverageInput & { source?: string | null }> =
    planMeta?.coverageMap ?? new Map();
  const coveredMeta: CoveredSlugMeta[] = planMeta?.coveredMeta ?? [];
  const planAcaCompliant: boolean | null = planMeta?.acaCompliant ?? null;

  // ── billSlugMeta (category + ACA-preventive eligibility) for the secondary match. ──
  const billSlugMeta = new Map<string, BillSlugMeta>();
  const distinctBillSlugs = Array.from(
    new Set(rawLines.map((li) => li.service_slug as string | null).filter((s): s is string => Boolean(s))),
  );
  if (distinctBillSlugs.length > 0) {
    const { data: scMeta } = await supabase
      .from("service_catalog")
      .select("slug, category, is_preventive_eligible")
      .in("slug", distinctBillSlugs);
    for (const r of scMeta ?? []) {
      billSlugMeta.set(r.slug as string, {
        category: (r.category as string | null) ?? null,
        isPreventiveEligible: Boolean(r.is_preventive_eligible),
      });
    }
  }

  const acaFallback = await buildAcaCoverageFallback({
    supabase,
    planId,
    userId,
    patientName,
    lineItems: acaLineItems,
    existingCoverageBySlug: new Set(coverageMap.keys()),
  });

  const claimTotalBilled = Number(claim.total_billed || 0);
  const claimStillOutstanding =
    claim.amount_still_outstanding != null
      ? Number(claim.amount_still_outstanding)
      : claim.total_patient_responsibility != null
        ? Number(claim.total_patient_responsibility)
        : null;
  const effectiveTotals = resolveEffectiveClaimTotals({
    claim,
    lineItems: rawLines,
    userTotalsSource: readUserTotalsSource(claim.metadata),
  });

  const prep: ClaimCostSharePrep = {
    coverageMap,
    coveredMeta,
    billSlugMeta,
    planAcaCompliant,
    secondaryGate,
    secondaryEnabled,
    acaFallback,
    claimTotalBilled,
    claimStillOutstanding,
    effectiveTotals,
  };

  // ── per-claim engine context (mirrors claims/[claimId]/route.ts:335-418). ──
  const planParams = await loadPlanCostShareParams(supabase, planId);
  const planYear = claim.date_of_service
    ? new Date(claim.date_of_service as string).getUTCFullYear()
    : null;
  const accRows = (
    await selectOwnedChildren(
      supabase,
      userId,
      "claim_accumulators",
      [claimId],
      "claim_id, benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max",
    )
  ).map(mapRawAccumulator);
  const overrides = resolveOverridesForBill(
    await loadCostShareOverrides(
      supabase,
      userId,
      planId,
      planYear,
      coerceNetworkOverride(claim.user_network_override),
    ),
    (claim.date_of_service as string | null) ?? null,
  );
  const memberSums = { deductible: 0, oop: 0 };
  for (const r of rawLines) {
    memberSums.deductible += Number(r.member_applied_to_deductible ?? 0);
    memberSums.oop += Number(r.member_coinsurance ?? 0) + Number(r.member_copay ?? 0);
  }
  const preventiveLines = await detectPreventiveMembership({
    supabase,
    userId,
    patientName,
    lineItems: acaLineItems,
  });
  const acaStatus: "confirmed" | "unknown" | "non_aca" =
    planAcaCompliant === true ? "confirmed" : planAcaCompliant === false ? "non_aca" : "unknown";
  const claimInsurerPaidZero =
    claim.total_insurance_paid != null && Number(claim.total_insurance_paid) === 0;

  const ctx: CostShareClaimCtx = {
    planParams,
    overrides,
    accRows,
    memberSums,
    preventiveLines,
    acaStatus,
    claimInsurerPaidZero,
    gate,
    networkClaim: coerceNetworkTier(claim.network_status),
    coverageTier: planParams?.coverageTier ?? null,
    planYear,
  };

  return { rawLines, prep, ctx };
}
