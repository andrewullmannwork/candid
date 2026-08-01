/**
 * GET /api/claims/[claimId] — Fetch single claim with full line items + coverage status.
 * Auth: Firebase bearer token. Verifies user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import {
  computeRecoveryV2,
  rollupCostShareVerdict,
  type PlanCostShareParams,
  type CostShareOverrides,
  type RecoveryMetrics,
  type CostShareVerdict,
  type CostShareAssumption,
  type InsurerDiscrepancy,
} from "@/lib/claims/recovery-math";
import {
  loadPlanCostShareParams,
  mapRawAccumulator,
  loadCostShareOverrides,
  resolveOverridesForBill,
  loadCostShareGate,
  coerceNetworkTier,
  coerceNetworkOverride,
  type RawAccumulator,
  type CostShareGate,
} from "@/lib/claims/cost-share-loader";
import {
  resolveCostShareForLine,
  resolveLinePrep,
  type CostShareClaimCtx,
  type ClaimCostSharePrep,
} from "@/lib/claims/resolve-cost-share";
import {
  resolveEffectiveClaimTotals,
  resolvePerLineInsurancePaid,
  resolvePerLineBilledToYou,
  readUserPatientPaidOverride,
  applyUserPatientPaidOverride,
} from "@/lib/claims/effective-totals";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { loadCaseTimelinePayload } from "@/lib/case/load-case-timeline";
import {
  loadFingerprintInputForClaim,
  computeEvidenceFingerprint,
  isDisputeStale,
} from "@/lib/disputes/evidence-fingerprint";
import { maybeReauditClaim } from "@/lib/audit/reaudit";
import { buildAcaCoverageFallback, detectPreventiveMembership } from "@/lib/audit/aca-coverage-fallback";
import {
  loadSecondaryGate,
  loadPlanCoverageMeta,
  DEFAULT_SECONDARY_GATE,
  type BillSlugMeta,
} from "@/lib/audit/coverage-loader";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

/**
 * B9 B1.2 — selectOwnedChildren returns child rows unordered; re-apply the
 * original `.order("line_number", { ascending: true })` as a JS post-sort.
 * PostgREST sorts ASC NULLS LAST, so nulls sink here too; JS sort is stable
 * (matches PostgREST's order for equal keys in practice) → byte-identical order.
 * Unconstrained generic so the permissive row type from the layer flows through.
 */
function sortByLineNumberAsc<T>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const av = (a as { line_number?: unknown }).line_number;
    const bv = (b as { line_number?: unknown }).line_number;
    const an = av == null ? Infinity : Number(av);
    const bn = bv == null ? Infinity : Number(bv);
    return an - bn;
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { claimId } = await params;
  const supabase = createServerClient();

  // Resolve user_id
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Fetch claim and verify ownership (userScoped injects `.eq("user_id")`).
  const { data: claim, error: claimError } = await userScoped(supabase, user.id)
    .table("claims")
    .select("*")
    .eq("id", claimId)
    .single();

  if (claimError || !claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // S74.5 D11 — if this claim was soft-deleted as a merge loser, surface the
  // canonical (winner) claim_id so the client can redirect. If soft-deleted
  // for any other reason (compliance erasure, etc.), 404 — the data is gone.
  if (claim.deleted_at) {
    if (claim.merged_into_claim_id) {
      return NextResponse.json(
        {
          error: "Claim merged",
          mergedIntoClaimId: claim.merged_into_claim_id as string,
        },
        { status: 410 },
      );
    }
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // S74.5 D6 — read flywheel flag once per request; surfaces to client so it
  // knows whether to render category-correction UI on line items.
  const flywheelEnabled = await isFeatureEnabled(
    "s74_5_categorization_flywheel_v1",
  );
  // S154 — gate the secondary (category) coverage match. OFF = pre-S153
  // behavior (exact-slug + ACA fallback only) on BOTH detail + list, so the
  // flag is a clean kill-switch with no detail/list split.
  const secondaryV2 = await isFeatureEnabled("secondary_coverage_v2");
  const secondaryGate = secondaryV2
    ? await loadSecondaryGate(supabase)
    : DEFAULT_SECONDARY_GATE;
  // Cost-Share v2 (S214) — network/deductible/OOP-aware recovery. Server-side
  // flag read; OFF short-circuits before any new loader → byte-identical. The
  // client keys off the presence of the per-line `costShareVerdict` field, so
  // there is NO client flag read.
  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
  // S299 phase 1a — gates the caseTimeline projection payload (+ the widened
  // dispute select it needs). OFF = today's payload, byte-identical.
  const caseRailV1 = await isFeatureEnabled("case_rail_v1");
  // S291 (mig 216) — see /api/claims. Resolved once per request; engine stays pure.
  const csHonestyGate = costShareV2
    ? await isFeatureEnabled("unverified_plan_honesty_gate_v1")
    : false;

  // Fetch line items (SELECT * picks up the new mig 092 columns automatically).
  // B9 B1.2 — claim_line_items has no user_id; selectOwnedChildren verifies the
  // parent claim is owned (claimId proven owned above) then returns its lines;
  // re-apply the line_number sort in JS (the layer returns rows unordered).
  let lineItems = sortByLineNumberAsc(
    await selectOwnedChildren(supabase, user.id, "claim_line_items", [claimId], "*"),
  );

  // S74.5 D7 — view-fetch re-audit hook (1/min + 5/day throttle inside).
  // Runs only when flag is ON AND claim is marked stale. On success, the
  // claim metadata + line_items metadata are refreshed so the response
  // below reflects the new findings. We re-read after to pick them up.
  let reauditResult: Awaited<ReturnType<typeof maybeReauditClaim>> | null = null;
  if (flywheelEnabled && lineItems && lineItems.length > 0) {
    reauditResult = await maybeReauditClaim(supabase, claim, lineItems);
    if (reauditResult.reaudited) {
      // Re-read updated rows so the response reflects fresh findings.
      lineItems = sortByLineNumberAsc(
        await selectOwnedChildren(supabase, user.id, "claim_line_items", [claimId], "*"),
      );
      const refreshedClaim = await userScoped(supabase, user.id)
        .table("claims")
        .select("*")
        .eq("id", claimId)
        .single();
      if (refreshedClaim.data) Object.assign(claim, refreshedClaim.data);
    }
  }

  // S74.5 D6 — when the flywheel flag is ON and line items are linked to a
  // billing_code_identity row, fetch the community/admin-verified slug so the
  // client can render the G4 conflict-resolution modal when the community
  // value differs from the user's row. Bounded by distinct identity_ids per
  // claim (small fanout — typically <10).
  const identityMap = new Map<
    string,
    {
      service_slug: string | null;
      promotion_state: "proposed" | "corroborated" | "admin_verified";
      confidence: number;
    }
  >();
  if (flywheelEnabled && lineItems) {
    const identityIds = Array.from(
      new Set(
        lineItems
          .map((li) => li.billing_code_identity_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (identityIds.length > 0) {
      const { data: identities } = await supabase
        .from("billing_code_identity")
        .select("id, service_slug, promotion_state, confidence")
        .in("id", identityIds);
      for (const row of identities ?? []) {
        identityMap.set(row.id as string, {
          service_slug: row.service_slug as string | null,
          promotion_state: row.promotion_state as
            | "proposed"
            | "corroborated"
            | "admin_verified",
          confidence: Number(row.confidence ?? 0.5),
        });
      }
    }
  }

  // §18.10 Path 2 — coverage via loadPlanCoverageMeta (the canonical loader the LIST
  // route already uses) → RICH coverage: the plan's explicit in_deductible_applies
  // (96.8% populated) + OON terms. Replaces the prior LEAN inline build, which dropped
  // those and GUESSED in_deductible_applies (diverged from the explicit value ~45% of
  // the time; ~9.6k over-claim rows). B9: the claim read above is user-scoped (404 on a
  // foreign claim), so claim.insurance_plan_id is the user's own plan → this reads only
  // their coverage (same posture as the list route).
  const planMeta = claim.insurance_plan_id
    ? (await loadPlanCoverageMeta(supabase, [claim.insurance_plan_id as string])).get(
        claim.insurance_plan_id as string,
      )
    : undefined;
  const coverageMap = planMeta?.coverageMap ?? new Map();
  const coveredMeta = planMeta?.coveredMeta ?? [];
  const planAcaCompliant: boolean | null = planMeta?.acaCompliant ?? null;

  // S153 — bill-line slug metadata (category + ACA-preventive eligibility) +
  // the plan's ACA-compliance flag, for the secondary coverage match.
  const billSlugMeta = new Map<string, BillSlugMeta>();
  const distinctBillSlugs = Array.from(
    new Set((lineItems ?? []).map((li) => li.service_slug as string | null).filter((s): s is string => Boolean(s))),
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

  // S74.6 D2 — Demographic-aware ACA-gated coverage fallback. For lines where
  // plan_covered_services has no row AND plan is_aca_compliant=TRUE AND the
  // billing code hits zero_cost_share_codes AND demographic eligibility matches,
  // synthesize coverage `{covered:true, copay:0, coinsurance:0}` so the
  // Coverage column renders "Covered · $0" instead of "Unknown". Plan-covered
  // rows (even non-zero copay) always win over this fallback — registry
  // fallback only fires on plan miss.
  const acaFallback = await buildAcaCoverageFallback({
    supabase,
    planId: claim.insurance_plan_id as string | null | undefined,
    userId: claim.user_id as string,
    patientName: (claim.patient_name as string | null | undefined) ?? null,
    lineItems: (lineItems ?? []).map((li) => ({
      lineNumber: Number(li.line_number ?? 0),
      procedureCode: (li.billing_code as string | null) ?? null,
      procedureCodeType: (li.billing_code_type as string | null) ?? null,
      serviceSlug: (li.service_slug as string | null) ?? null,
    })),
    existingCoverageBySlug: new Set(coverageMap.keys()),
  });

  // Claim-level totals used as pro-rate fallback when individual line items
  // lack allocation (the common Haiku header-only case).
  const claimTotalBilled = Number(claim.total_billed || 0);
  const claimStillOutstanding =
    claim.amount_still_outstanding != null
      ? Number(claim.amount_still_outstanding)
      : claim.total_patient_responsibility != null
        ? Number(claim.total_patient_responsibility)
        : null;

  // S140 — Compute effective claim-level totals with per-field provenance.
  // When per-line numeric columns (patient_paid_amount, insurance_paid,
  // insurance_adjusted_amount, patient_owes) are sparse or inflated vs the
  // claim header, the helper falls back to header values and marks the
  // source. Powers per-line LineDrawer cite-grade gating + bill-level
  // FlaggedBody display + dispute pipeline citation framing.
  // Dispute Letters v2 (Z1.1d) — reflect the user's amount-paid override on the claim page
  // too (parity with the dispute-letter refund): overlay claims.metadata.userPatientPaid
  // onto the claim header + prorated per-line BEFORE effective totals + cost-share, so the
  // "You paid" column + recovery match the dispute page. No-op when unset → byte-identical.
  {
    const ov = readUserPatientPaidOverride((claim as { metadata?: unknown }).metadata);
    if (ov != null) {
      applyUserPatientPaidOverride(
        claim as { total_patient_paid?: number | null },
        (lineItems ?? []) as Array<{
          billed_amount?: number | null;
          patient_paid_amount?: number | null;
        }>,
        ov,
      );
    }
  }
  const effectiveTotals = resolveEffectiveClaimTotals({
    claim,
    lineItems: lineItems || [],
  });

  // Cost-Share v2 — load the per-claim engine context ONCE (plan params, the
  // owned accumulator snapshot, the user's plan-year overrides, the dispute
  // threshold), only when the flag is ON. claim_accumulators is read via
  // selectOwnedChildren (parent-join; user-facing) per the B9 layer.
  let csPlanParams: PlanCostShareParams | null = null;
  let csAccumulatorRows: RawAccumulator[] = [];
  let csOverrides: CostShareOverrides | null = null;
  let csGate: CostShareGate = { minRecovery: 1 };
  let csPlanYear: number | null = null;
  const csMemberSums = { deductible: 0, oop: 0 };
  // W1 — preventive (zero_cost_share_codes membership, plan-ACA-independent) + the plan's ACA
  // status (the $0 mandate gate) + the claim-level insurer-$0 pre-deductible corroboration.
  let csPreventiveLines = new Set<number>();
  const csAcaStatus: "confirmed" | "unknown" | "non_aca" =
    planAcaCompliant === true ? "confirmed" : planAcaCompliant === false ? "non_aca" : "unknown";
  const csClaimInsurerPaidZero =
    claim.total_insurance_paid != null && Number(claim.total_insurance_paid) === 0;
  if (costShareV2) {
    csGate = await loadCostShareGate(supabase);
    csPlanParams = await loadPlanCostShareParams(
      supabase,
      claim.insurance_plan_id as string | null,
    );
    csAccumulatorRows = (
      await selectOwnedChildren(
        supabase,
        user.id,
        "claim_accumulators",
        [claimId],
        "claim_id, benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max",
      )
    ).map(mapRawAccumulator);
    csPlanYear = claim.date_of_service
      ? new Date(claim.date_of_service as string).getUTCFullYear()
      : null;
    const rawOverrides = await loadCostShareOverrides(
      supabase,
      user.id,
      claim.insurance_plan_id as string | null,
      csPlanYear,
      coerceNetworkOverride(claim.user_network_override),
    );
    csOverrides = resolveOverridesForBill(
      rawOverrides,
      (claim.date_of_service as string | null) ?? null,
    );
    // Pre-claim accumulator adjustment needs THIS claim's own member consumption
    // (a YTD accumulator reflects state AFTER the claim; subtract to recover the
    // pre-claim snapshot). All-null on legacy/launch rows → no-op.
    for (const it of lineItems || []) {
      const r = it as Record<string, unknown>;
      csMemberSums.deductible += Number(r.member_applied_to_deductible ?? 0);
      csMemberSums.oop += Number(r.member_coinsurance ?? 0) + Number(r.member_copay ?? 0);
    }
    csPreventiveLines = await detectPreventiveMembership({
      supabase,
      userId: claim.user_id as string,
      patientName: (claim.patient_name as string | null | undefined) ?? null,
      lineItems: (lineItems ?? []).map((li) => ({
        lineNumber: Number(li.line_number ?? 0),
        procedureCode: (li.billing_code as string | null) ?? null,
        procedureCodeType: (li.billing_code_type as string | null) ?? null,
        serviceSlug: (li.service_slug as string | null) ?? null,
      })),
    });
  }

  // §18.9 — assemble the shared cost-share engine context ONCE per claim (the
  // per-line accumulator-resolve + computeCostShareV2 call now live in
  // resolveCostShareForLine, parity-locked vs the prior inline assembly). Inert
  // when costShareV2 is OFF (csCtx is only read in the ON branch below).
  const csCtx: CostShareClaimCtx = {
    planParams: csPlanParams,
    overrides: csOverrides,
    accRows: csAccumulatorRows,
    memberSums: csMemberSums,
    preventiveLines: csPreventiveLines,
    acaStatus: csAcaStatus,
    claimInsurerPaidZero: csClaimInsurerPaidZero,
    gate: csGate,
    networkClaim: coerceNetworkTier(claim.network_status),
    coverageTier: csPlanParams?.coverageTier ?? null,
    planYear: csPlanYear,
    unverifiedPlanHonestyGate: csHonestyGate,
  };

  // §18.10 Path 2 — per-line PREP inputs (coverage + secondary + ACA-fallback +
  // proration context), assembled once per claim, fed to resolveLinePrep per line.
  const csPrepInputs: ClaimCostSharePrep = {
    coverageMap,
    coveredMeta,
    billSlugMeta,
    planAcaCompliant,
    secondaryGate,
    secondaryEnabled: secondaryV2,
    acaFallback,
    claimTotalBilled,
    claimStillOutstanding,
    effectiveTotals,
  };

  // Enrich line items with coverage status + recovery metrics
  const enrichedLineItems = (lineItems || []).map((item) => {
    // S135 — 4-state ACA matrix via shared helper. Plan wins on match; ACA wins
    // on conflict (non-$0 plan vs $0 ACA mandate OR plan-excludes vs ACA-covers);
    // ACA-only when plan missing slug. Override info preserved for UI inline
    // render + dispute pipeline citation.
    // §18.10 Path 2 — per-line cost-share PREP via the shared recipe (coverage:
    // exact → secondary → ACA fallback; writeoff proration + allowed; patientPaid +
    // patientResponsibility). Byte-identical to the prior inline given the same inputs
    // (scripts/calibration/fixtures/cost-share-v2/prep-parity.ts, strategy "detail");
    // coverageMap is now RICH (loadPlanCoverageMeta).
    const lp = resolveLinePrep(item as Record<string, unknown>, csPrepInputs, "detail");
    const coverage = lp.coverage;
    const acaOverride = lp.acaOverride;
    const coverageSource = lp.coverageSource;
    const secondaryMatchedSlug = lp.secondaryMatchedSlug;
    const secondaryConfidence = lp.secondaryConfidence;
    const billed = Number(item.billed_amount || 0);
    const patientPaid = lp.patientPaid;
    const patientPaidSource = lp.patientPaidSource;
    const lineInsuranceAdjusted = lp.insuranceAdjusted;
    const insuranceAdjustedSource = lp.insuranceAdjustedSource;
    const adjustedBilled = lp.allowed;
    const patientResponsibility = lp.patientResponsibility;
    // S140 fix-pass H5 — per-line insurer payment (DISPLAY only; not consumed by
    // recovery math). Pro-rated when sparse; raw when cite-grade match.
    const lineInsurancePaidRaw =
      item.insurance_paid != null ? Number(item.insurance_paid) : null;
    const { value: insurancePaidResolved, source: insurancePaidSource } =
      resolvePerLineInsurancePaid({
        lineBilled: billed,
        lineInsurancePaid: lineInsurancePaidRaw,
        claimTotalBilled,
        effectiveClaimInsurancePaid: effectiveTotals,
      });
    // S292 (#4) — "BILLED TO YOU" display value (DISPLAY ONLY; feeds no
    // recovery/verdict math): what this line actually asked the patient to
    // pay after the insurer's negotiated adjustment + payment. Honesty
    // fallback lives inside the resolver — bills with no insurer data at all
    // (or inconsistent data going negative) surface the gross, no sub-line.
    const billedToYou = resolvePerLineBilledToYou({
      lineBilled: billed,
      lineInsuranceAdjusted:
        item.insurance_adjusted_amount != null
          ? Number(item.insurance_adjusted_amount)
          : null,
      lineInsurancePaid: lineInsurancePaidRaw,
      claimTotalBilled,
      effectiveTotals,
    });
    // Cost-Share v2 — when ON, the plan-derived phase engine replaces the
    // deductible-blind computeShouldOwe path. The engine result is a
    // RecoveryMetrics superset, so the claim-level rollup below consumes it
    // unchanged. OFF = the exact computeRecoveryV2 call (byte-identical).
    let recovery: RecoveryMetrics;
    let lineCostShareVerdict: CostShareVerdict | null = null;
    let lineCostShareAssumptions: CostShareAssumption[] | null = null;
    let lineInsurerDiscrepancy: InsurerDiscrepancy | null = null;
    if (costShareV2) {
      // §18.9 — shared resolution layer (parity-locked vs the prior inline assembly,
      // scripts/calibration/fixtures/cost-share-v2/resolve-parity.ts). allowed is the
      // header-prorated value (adjustedBilled — the real allowed, e.g. cf91a49e
      // $163.27, not the sparse $0 raw line); divergent prep stays at the call site.
      const cs = resolveCostShareForLine(
        {
          lineNumber: Number(item.line_number ?? 0),
          billed,
          allowed: adjustedBilled,
          insuranceAdjusted: lineInsuranceAdjusted,
          patientPaid,
          patientResponsibility,
          coverage,
          networkStatus: (item as Record<string, unknown>).network_status as string | null,
          raw: item as Record<string, unknown>,
        },
        csCtx,
      );
      recovery = cs;
      lineCostShareVerdict = cs.verdict;
      lineCostShareAssumptions = cs.assumptions;
      lineInsurerDiscrepancy = cs.insurerDiscrepancy;
      // G7 (Ship Gate) — server-side recall-loss telemetry. The OLD deductible-
      // blind synthesis fired a "mystery gap" when billed>0 & insurer $0 &
      // owed $0; log when that shape holds but the engine cleared the line
      // (verdict ≠ 'recovery'), so the suppression rate is measured, not blind.
      const oldPathWouldFire =
        billed > 0 &&
        Number((item as Record<string, unknown>).insurance_paid ?? 0) === 0 &&
        Number((item as Record<string, unknown>).patient_owes ?? 0) === 0;
      if (oldPathWouldFire && cs.verdict !== "recovery") {
        console.info("[cost-share-v2] mystery-gap suppressed", {
          claimId,
          lineId: item.id,
          verdict: cs.verdict,
          phase: cs.phase,
        });
      }
    } else {
      recovery = computeRecoveryV2({
        billed,
        patientResponsibility,
        patientPaid,
        // S120 — apply coinsurance to ADJUSTED billed (post-writeoff), not gross.
        // S140 fix-pass H1 — insuranceAdjusted now reflects pro-rated per-line
        // writeoff when the per-line column is sparse. Restores coinsurance
        // math correctness (Dec 12 L2 10% coinsurance: shouldOwe $4 from
        // $41.10 adjusted, vs old buggy $9 from $89 gross).
        insuranceAdjusted: lineInsuranceAdjusted,
        planCoverage: coverage,
      });
    }
    // S140 — attach provenance so downstream consumers (LineDrawer recovery
    // strip + dispute letter per-line cites) can gate on cite-grade.
    // isCitablePerLine now requires ALL three numeric fields (patientPaid +
    // patientResponsibility + insuranceAdjusted) to be per-line raw —
    // otherwise the line's recovery math has at least one derived input
    // and shouldn't be cited verbatim per-line.
    const recoveryWithProvenance = {
      ...recovery,
      provenance: {
        patientPaidSource,
        patientResponsibilitySource: (item.patient_owes != null
          ? "per_line"
          : "header_prorated") as "per_line" | "header_prorated",
        insuranceAdjustedSource,
        insurancePaidSource,
        isCitablePerLine:
          patientPaidSource === "per_line" &&
          item.patient_owes != null &&
          insuranceAdjustedSource === "per_line" &&
          insurancePaidSource === "per_line",
      },
    };

    // S74.5 D6 — enrich with code-identity state for the correction pill +
    // G4 conflict modal trigger. Only populated when flywheel flag is ON.
    const identityId = item.billing_code_identity_id as string | null;
    const identity = identityId ? identityMap.get(identityId) ?? null : null;
    const communitySlug = identity?.service_slug ?? null;
    // S74.5c §1.3 — conflict modal trigger is "snapshot present" not
    // "slug mismatch". After backfillCorroboratedMapping runs, the user's
    // service_slug has already been replaced with the community value, so a
    // mismatch check would NEVER fire for the case the modal was designed
    // for. Instead, fire when the backfill snapshot exists in metadata
    // (semantic: "user has a pending acknowledgment of a community
    // auto-switch"). resolve-conflict endpoint clears the snapshot keys on
    // either action ("revert" or "accept"), so the modal stops surfacing
    // once consumed.
    const itemMetadata = (item.metadata as Record<string, unknown> | null) ?? null;
    const conflictsWithCommunity =
      flywheelEnabled &&
      !item.user_correction_locked_at &&
      itemMetadata?.user_correction_pre_backfill_slug != null;

    return {
      ...item,
      // Coverage cascade (4 tokens):
      //   - billed === 0: no badge ($0 lines are informational receipts)
      //   - plan_covered_services row exists: use it (covered / not_covered)
      //   - no plan row (whether slug present or not): 'unknown' — user
      //     resolves via CategoryCorrectionModal picker
      coverageStatus: billed === 0
        ? null
        : coverage
          ? coverage.covered === false
            ? "not_covered"
            : "covered"
          : "unknown",
      planCoverage: coverage || null,
      // S74.6 D2 — surface which path produced the coverage so the UI can render
      // "Covered (ACA)" vs "Covered (plan)" tooltip distinction.
      coverageSource,
      // S153 — when coverage came from a secondary (category) match, the covered
      // sibling slug we matched to (e.g. annual_physical → preventive_care), so
      // the UI can show "Covered — via Preventive Care" rather than a direct hit.
      coverageSecondaryMatchedSlug: secondaryMatchedSlug,
      // S154 — secondary-match gate outcome. `estimate` = identified but the
      // borrowed cost-share is ambiguous → the UI shows a "Verify coverage"
      // affordance and the dispute pipeline demotes it below cite-grade until
      // confirmed. `coverageNeedsConfirmation` folds in whether the user has
      // already confirmed this line (one-time; cleared by the confirm endpoint).
      coverageConfidence: secondaryConfidence,
      coverageNeedsConfirmation:
        secondaryConfidence === "estimate" &&
        itemMetadata?.coverage_user_confirmed !== true &&
        itemMetadata?.coverage_user_rejected !== true,
      // S135 — plan-vs-ACA override info (non-null in States 2 / 2b). UI green
      // plan-says box renders an inline "Plan says $X, federal law $0" line
      // when present. Dispute pipeline uses for federal-law citation.
      acaOverride,
      // S140 fix-pass H1 — per-line adjusted billed (raw - resolved writeoff).
      // Drives UI BILLED column + LineDrawer Bill card + OVERCHARGE pill calc.
      adjustedBilled,
      // S140 fix-pass H5 — per-line insurer payment (pro-rated when sparse;
      // raw when cite-grade match). Drives LineDrawer Bill card "Insurer
      // paid $X" + desktop/mobile YOU PAID column derivation.
      insurancePaidResolved,
      // S292 (#4) — per-line "BILLED TO YOU" (billed − insurer adjustment −
      // insurer payment, ≥ 0) + gross + sub-line visibility. Drives the bill
      // table's BILLED TO YOU column (desktop + mobile). Display only.
      billedToYou,
      recovery: recoveryWithProvenance,
      // Cost-Share v2 — attached ONLY when the flag is ON (the client keys off
      // the presence of `costShareVerdict`). Absent → today's verdict-blind UI.
      ...(costShareV2
        ? {
            costShareVerdict: lineCostShareVerdict,
            costShareAssumptions: lineCostShareAssumptions,
            insurerDiscrepancy: lineInsurerDiscrepancy,
          }
        : {}),
      codeIdentity: flywheelEnabled
        ? {
            identityId,
            communitySlug,
            promotionState: identity?.promotion_state ?? null,
            confidence: identity?.confidence ?? null,
            conflictsWithCommunity,
            userCorrectedAt: (item.user_corrected_at as string | null) ?? null,
            userCorrectionLockedAt:
              (item.user_correction_locked_at as string | null) ?? null,
          }
        : null,
    };
  });

  // Claim-level recovery totals — sum per-line components so the UI hero
  // and BillCard surface accurate amounts without re-deriving.
  const lineSummedRecovery = enrichedLineItems.reduce(
    (acc, li) => ({
      billed: acc.billed + li.recovery.billed,
      alreadyPaid: acc.alreadyPaid + li.recovery.alreadyPaid,
      stillOutstanding: acc.stillOutstanding + li.recovery.stillOutstanding,
      shouldOwe: acc.shouldOwe + li.recovery.shouldOwe,
      potentialRecovery: acc.potentialRecovery + li.recovery.potentialRecovery,
      refundComponent: acc.refundComponent + li.recovery.refundComponent,
      forgivenessComponent: acc.forgivenessComponent + li.recovery.forgivenessComponent,
    }),
    {
      billed: 0,
      alreadyPaid: 0,
      stillOutstanding: 0,
      shouldOwe: 0,
      potentialRecovery: 0,
      refundComponent: 0,
      forgivenessComponent: 0,
    },
  );

  // S140 — claim-level recovery branches on cite-grade provenance:
  // - Empty line items + header signal → existing header-only fallback IIFE
  // - Any per-line synthesized → recompute refund/forgive from CLAIM HEADER
  //   directly (exact math, no rounding drift from pro-rated per-line sum)
  // - All per-line cite-grade → use lineSummedRecovery (today's behavior)
  // Math mirrors computeRecoveryV2:184-190 (effectiveBurden = max(paid,
  // assigned); refund = max(0, paid - shouldOwe); forgive = potential - refund).
  const anyLinePerLineCiteGradeMissing = enrichedLineItems.some(
    (li) => li.recovery.provenance && !li.recovery.provenance.isCitablePerLine,
  );

  type ClaimRecovery = typeof lineSummedRecovery & {
    provenance?: { citationSource: "per_line_sum" | "claim_header" };
  };

  let claimRecovery: ClaimRecovery;
  if (enrichedLineItems.length === 0 && claimTotalBilled > 0) {
    // Header-only fallback: when line items weren't extracted (common for EOBs
    // where Haiku captured the header totals but no per-line allocation),
    // derive recovery directly from the claim header so the UI still surfaces
    // a meaningful Potential Recovery number instead of $0.
    const stillOutstanding = claimStillOutstanding ?? 0;
    const alreadyPaid = Math.max(0, claimTotalBilled - stillOutstanding);
    // Without line-level service_slug we can't resolve a plan copay; assume
    // $0 should-owe for header-only claims (the dispute is "you shouldn't
    // owe any of this"). Session 36 reconciler will fix by synthesizing
    // line items from the header before this branch ever fires.
    const shouldOwe = 0;
    const potentialRecovery = Math.max(0, claimTotalBilled - shouldOwe);
    claimRecovery = {
      billed: claimTotalBilled,
      alreadyPaid,
      stillOutstanding,
      shouldOwe,
      potentialRecovery,
      refundComponent: Math.max(0, alreadyPaid - shouldOwe),
      forgivenessComponent: Math.max(0, stillOutstanding - shouldOwe),
      provenance: { citationSource: "claim_header" },
    };
  } else if (anyLinePerLineCiteGradeMissing) {
    // S140 — synthesized (pro-rated) per-line values → stamp claim_header
    // citation provenance so dispute-strength gating stays honest.
    //
    // S290 — the ARITHMETIC is the per-line sum, no longer a claim-header
    // netting. The old recompute did `max(0, header_paid − Σ shouldOwe)`,
    // which let ONE unknown-cost line's CONSERVATIVE full-allowed shouldOwe
    // (an upper bound, not evidence the patient owes it) swallow every other
    // line's real refund — the S290 E2E defect: rows showed +$97.96 of
    // line-level refunds while the banner read $0.00. Pro-rated per-line
    // patient_paid sums exactly to the header total by construction, so the
    // per-line sum keeps the "exact math" property; each line's refund is
    // max(0, paid_i − shouldOwe_i), and a conservative unknown on line A can
    // never absorb a known overpayment on line B. Rows, banner, and the
    // claims-LIST chip now agree by construction (one spine).
    claimRecovery = {
      ...lineSummedRecovery,
      provenance: { citationSource: "claim_header" },
    };
  } else {
    claimRecovery = {
      ...lineSummedRecovery,
      provenance: { citationSource: "per_line_sum" },
    };
  }

  // Cost-Share v2 (D1) — bill-level verdict for the §5 assumptions banner
  // ("one banner per bill"). Rolled up from the per-line verdicts through the
  // SAME shared precedence helper computeClaimCostShareV2 uses, so the bill
  // headline can never drift from the engine. Attached ONLY when the flag is ON
  // (absent → today's verdict-blind UI). The banner reads recovery $ from the
  // `recovery` field above, so the verdict is the only new field needed.
  const costShareBill = costShareV2
    ? (() => {
        const verdicts = enrichedLineItems
          .map(
            (li) =>
              (li as { costShareVerdict?: CostShareVerdict | null })
                .costShareVerdict,
          )
          .filter((v): v is CostShareVerdict => v != null);
        return verdicts.length > 0
          ? { verdict: rollupCostShareVerdict(verdicts) }
          : null;
      })()
    : null;

  // Fetch linked disputes (userScoped adds `.eq("user_id")`; +DiD — these are
  // the owner's disputes on the owned claim).
  // Cost-Share v2 (§17.4) — when the flag is ON, also pull the fields the
  // dispute card needs to render `isStale` + `chargeCount` WITHOUT the heavy
  // per-dispute GET (~4.5s). OFF → the original narrow shape (byte-identical).
  const disputeSelectBase = costShareV2
    ? "id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date, evidence_fingerprint, sent_at, claim_line_item_id, metadata"
    : "id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date";
  // S299 phase 1a — the projector needs the full ProjectorDisputeRow column
  // set; appended ADDITIVELY when the rail flag is ON (OFF keeps today's
  // select strings exactly). The raw rows stay server-side — enrichedDisputes
  // below still drops metadata/fingerprint before the payload.
  const disputeSelect = caseRailV1
    ? `${disputeSelectBase}, claim_id, created_at, governing_deadline_date, deadline_type, insurance_plan_id${costShareV2 ? "" : ", sent_at, metadata"}`
    : disputeSelectBase;
  const { data: disputes } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select(disputeSelect)
    .eq("claim_id", claimId);

  // Cost-Share v2 (§17.4) — fold `isStale` + `chargeCount` into the claim GET so
  // the redesigned dispute card renders them instantly, instead of each card firing
  // the heavy /api/disputes/[id] GET on mount (~4.5s) just for these two fields.
  // The claim-level evidence fingerprint is computed ONCE (shared across every
  // dispute on this claim) via the CANONICAL loadFingerprintInputForClaim, so the
  // card's staleness verdict matches the letter page's exactly (same shared
  // isDisputeStale rule). The duplicate basis-load (~0.3-0.5s) folds into the §18
  // single-load unification.
  let enrichedDisputes: Array<Record<string, unknown>> = disputes ?? [];
  if (costShareV2 && enrichedDisputes.length > 0) {
    let currentFp: string | null = null;
    try {
      const fpInput = await loadFingerprintInputForClaim(supabase, claimId, user.id);
      currentFp = fpInput ? computeEvidenceFingerprint(fpInput) : null;
    } catch (err) {
      // A fingerprint-load failure must NOT take down the whole claim page; degrade
      // to not-stale (chargeCount needs no fingerprint, so it still renders).
      console.error(
        "[claims GET] cost-share staleness load failed; disputes render not-stale:",
        err,
      );
      currentFp = null;
    }
    enrichedDisputes = enrichedDisputes.map((d) => {
      const extraIds =
        ((d.metadata as Record<string, unknown> | null)?.claimLineItemIds as
          | string[]
          | undefined) ?? [];
      const chargeCount = new Set(
        [d.claim_line_item_id, ...extraIds].filter(Boolean) as string[],
      ).size;
      const isStale = isDisputeStale({
        currentFingerprint: currentFp,
        storedFingerprint: (d.evidence_fingerprint as string | null) ?? null,
        sentAt: (d.sent_at as string | null) ?? null,
      });
      // Drop the helper-only fields (fingerprint / sent_at / metadata / line id)
      // from the response — the raw fingerprint never reaches the client.
      return {
        id: d.id,
        dispute_type: d.dispute_type,
        status: d.status,
        amount_disputed: d.amount_disputed,
        amount_recovered: d.amount_recovered,
        filed_date: d.filed_date,
        resolution_date: d.resolution_date,
        isStale,
        chargeCount,
      };
    });
  }

  // S299 phase 2a — the shared projection loader (load-case-timeline.ts; the
  // dispute GET consumes the identical load — agenda §1 one derivation). The
  // raw rows fetched above are passed through so nothing double-fetches.
  // Attached ONLY when case_rail_v1 is ON; OFF = byte-identical payload.
  let caseTimeline: Record<string, unknown> | null = null;
  if (caseRailV1 && disputes && disputes.length > 0) {
    caseTimeline = await loadCaseTimelinePayload(supabase, user.id, claimId, {
      claimRow: {
        id: claim.id as string,
        created_at: claim.created_at as string,
        metadata: (claim.metadata as Record<string, unknown> | null) ?? null,
      },
      disputeRows: disputes as Array<Record<string, unknown>>,
    });
  }

  // Fetch related claims in same group. S139 (B4.2 multi-line) — lift
  // provider_name from claim metadata so BundleSuggestion + MiniBillRow can
  // render peer rows with the source provider, not just an ID. Matches the
  // metadata.provider.name path used by claim-matching.ts (S?? when group
  // matching first landed).
  let relatedClaims: Array<{
    id: string;
    date_of_service: string;
    status: string;
    total_billed: number;
    provider_name: string | null;
  }> = [];
  if (claim.claim_group_id) {
    // B9 B1.2 (L1) — was scoped only by claim_group_id; userScoped adds
    // `.eq("user_id")`. claim_group_id is a per-user random UUID (claim-matching
    // crypto.randomUUID), so this is defense-in-depth (op-equivalent for the
    // owner — all grouped claims are theirs), closing a latent cross-tenant read.
    const { data: grouped } = await userScoped(supabase, user.id)
      .table("claims")
      .select("id, date_of_service, status, total_billed, metadata")
      .eq("claim_group_id", claim.claim_group_id)
      .neq("id", claimId);
    relatedClaims = (grouped || []).map((g) => {
      const meta = (g.metadata as Record<string, unknown>) || {};
      const provider = (meta.provider as Record<string, unknown> | undefined) || {};
      const provider_name = (provider.name as string | undefined) ?? null;
      return {
        id: g.id as string,
        date_of_service: g.date_of_service as string,
        status: g.status as string,
        total_billed: g.total_billed as number,
        provider_name,
      };
    });
  }

  // S132 iter-6 Phase 1 (cross-workstream §R.2): expose the user's plan
  // coverage as a flat array so CategoryCorrectionModal can (a) filter the
  // catalog to slugs the user's plan actually lists, (b) render an inline
  // coverage badge per row, and (c) gate the "Use this" best-guess button
  // when the current slug isn't in plan. Backend already builds coverageMap
  // above; this is a zero-extra-query exposure.
  const userPlanCoverage = Array.from(coverageMap.entries()).map(([slug, c]) => ({
    slug,
    covered: c.covered,
    copay: c.copay,
    coinsurance: c.coinsurance,
  }));

  return NextResponse.json({
    claim,
    lineItems: enrichedLineItems,
    disputes: enrichedDisputes,
    // S299 phase 1a — projector-derived case timeline (absent when
    // case_rail_v1 is OFF → byte-identical payload).
    ...(caseTimeline ? { caseTimeline } : {}),
    relatedClaims,
    recovery: claimRecovery,
    // Cost-Share v2 (D1) — bill-level verdict for the §5 banner; flag-gated
    // (absent when OFF → byte-identical to today).
    ...(costShareBill ? { costShareBill } : {}),
    // Cost-Share v2 (W3) — the user's resolved cost-share overrides (deductible/
    // OOP met-status + as-of dates + per-claim network override), so the §5
    // banner can render the confirmed "you set this · Undo" chips + the correct
    // toggle direction. Flag-gated; the route already resolved csOverrides above.
    ...(costShareV2 && csOverrides ? { costShareOverrides: csOverrides } : {}),
    // S140 — surface effective claim totals + per-field provenance so the
    // frontend FlaggedBody can read claim-header values directly (vs the
    // sum-of-nulls bug that produced $0 displays for Dec 12-style bills).
    effectiveTotals,
    flags: {
      categorizationFlywheelV1: flywheelEnabled,
    },
    userPlanCoverage,
    // S74.5 D7 — surface re-audit outcome for telemetry + client toasts.
    // null when flag off or claim wasn't stale.
    reaudit: reauditResult,
    // S74.6 D1 §A.2 — plan-level ACA basis + excerpt for Coverage badge
    // tooltip copy. ClaimDetail.tsx consumes this when rendering tooltips on
    // lines where coverageSource === 'aca_zero_cost_share'. null when plan
    // is not ACA-compliant.
    acaCompliance: acaFallback.planMeta,
  });
}
