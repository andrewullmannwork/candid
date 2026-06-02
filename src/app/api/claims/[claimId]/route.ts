/**
 * GET /api/claims/[claimId] — Fetch single claim with full line items + coverage status.
 * Auth: Firebase bearer token. Verifies user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  computeRecoveryV2,
  resolveStillOutstanding,
  type PlanCoverageInput,
} from "@/lib/claims/recovery-math";
import {
  resolveEffectiveClaimTotals,
  resolvePerLinePatientPaid,
  resolvePerLineInsuranceAdjusted,
  resolvePerLineInsurancePaid,
} from "@/lib/claims/effective-totals";
import { normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { maybeReauditClaim } from "@/lib/audit/reaudit";
import { buildAcaCoverageFallback } from "@/lib/audit/aca-coverage-fallback";
import {
  resolveLineCoverage,
  resolveSecondaryCoverage,
  loadSecondaryGate,
  DEFAULT_SECONDARY_GATE,
  type CoveredSlugMeta,
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

  // Fetch claim and verify ownership
  const { data: claim, error: claimError } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .eq("user_id", user.id)
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

  // Fetch line items (SELECT * picks up the new mig 092 columns automatically).
  let { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("*")
    .eq("claim_id", claimId)
    .order("line_number", { ascending: true });

  // S74.5 D7 — view-fetch re-audit hook (1/min + 5/day throttle inside).
  // Runs only when flag is ON AND claim is marked stale. On success, the
  // claim metadata + line_items metadata are refreshed so the response
  // below reflects the new findings. We re-read after to pick them up.
  let reauditResult: Awaited<ReturnType<typeof maybeReauditClaim>> | null = null;
  if (flywheelEnabled && lineItems && lineItems.length > 0) {
    reauditResult = await maybeReauditClaim(supabase, claim, lineItems);
    if (reauditResult.reaudited) {
      // Re-read updated rows so the response reflects fresh findings.
      const refresh = await supabase
        .from("claim_line_items")
        .select("*")
        .eq("claim_id", claimId)
        .order("line_number", { ascending: true });
      lineItems = refresh.data ?? lineItems;
      const refreshedClaim = await supabase
        .from("claims")
        .select("*")
        .eq("id", claimId)
        .eq("user_id", user.id)
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

  // Fetch coverage status for each line item's service_slug
  const coverageMap = new Map<string, { covered: boolean | null; copay: number | null; coinsurance: number | null; source: string | null }>();
  // S153 — covered-slug metadata (incl. category) for the secondary (category)
  // coverage match when a bill line's exact slug has no plan row.
  const coveredMeta: CoveredSlugMeta[] = [];

  if (claim.insurance_plan_id) {
    const { data: coveredServices } = await supabase
      .from("plan_covered_services")
      .select("covered, in_copay, in_coinsurance, source, service_catalog!inner(slug, category)")
      .eq("insurance_plan_id", claim.insurance_plan_id);

    if (coveredServices) {
      for (const svc of coveredServices) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sc = svc.service_catalog as any;
        const slug = sc?.slug as string | undefined;
        if (slug) {
          const coverage = {
            covered: svc.covered as boolean | null,
            copay: svc.in_copay as number | null,
            // S132 iter-11 — plan_covered_services.in_coinsurance holds either
            // integer percent (30) OR already-decimal (0.3); both mean 30% in
            // plan-document language. normalizeCoinsuranceForStorage detects
            // both forms and returns decimal 0-1 uniformly.
            coinsurance: normalizeCoinsuranceForStorage(svc.in_coinsurance as number | null),
          };
          coverageMap.set(slug, { ...coverage, source: svc.source as string | null });
          coveredMeta.push({ slug, category: (sc?.category as string | null) ?? null, coverage });
        }
      }
    }
  }

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
  let planAcaCompliant: boolean | null = null;
  if (claim.insurance_plan_id) {
    const { data: planRow } = await supabase
      .from("insurance_plans")
      .select("is_aca_compliant")
      .eq("id", claim.insurance_plan_id)
      .maybeSingle();
    planAcaCompliant = (planRow?.is_aca_compliant as boolean | null) ?? null;
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
  const effectiveTotals = resolveEffectiveClaimTotals({
    claim,
    lineItems: lineItems || [],
  });

  // Enrich line items with coverage status + recovery metrics
  const enrichedLineItems = (lineItems || []).map((item) => {
    // S135 — 4-state ACA matrix via shared helper. Plan wins on match; ACA wins
    // on conflict (non-$0 plan vs $0 ACA mandate OR plan-excludes vs ACA-covers);
    // ACA-only when plan missing slug. Override info preserved for UI inline
    // render + dispute pipeline citation.
    let rawPlanCoverage: PlanCoverageInput | null = item.service_slug
      ? coverageMap.get(item.service_slug) || null
      : null;
    // S153 — secondary (category) coverage match when the exact slug has no
    // plan row (e.g. annual_physical → covered preventive_care, or an ACA
    // preventive $0 backstop). Marked so the UI shows it as an inferred match,
    // never a direct plan hit.
    let secondaryMatchedSlug: string | null = null;
    let secondaryCoverageSource: "secondary_match" | "aca_preventive" | null = null;
    let secondaryConfidence: "confident" | "estimate" | null = null;
    if (secondaryV2 && !rawPlanCoverage && item.service_slug) {
      const meta = billSlugMeta.get(item.service_slug as string);
      if (meta) {
        const sec = resolveSecondaryCoverage(
          item.service_slug as string,
          meta,
          coveredMeta,
          planAcaCompliant,
          secondaryGate,
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
      acaFallback.byLineNumber.get(Number(item.line_number ?? 0)) || null;
    const resolved = resolveLineCoverage(
      rawPlanCoverage,
      acaCoverage,
      acaFallback.planMeta,
    );
    const coverage = resolved.coverage;
    const acaOverride = resolved.acaOverride;
    // Coverage source attribution for tooltip + telemetry. ACA wins → 'aca_*';
    // secondary match → 'secondary_match'/'aca_preventive'; plan → its source.
    const coverageFromAca = coverage === acaCoverage && coverage != null;
    const coverageSource = coverageFromAca
      ? "aca_zero_cost_share"
      : secondaryCoverageSource
        ? secondaryCoverageSource
        : coverage && item.service_slug
          ? coverageMap.get(item.service_slug as string)?.source ?? null
          : null;

    const billed = Number(item.billed_amount || 0);
    // F-1 / mig 092 — patient_paid_amount column drives refund/forgiveness split.
    // S140 — resolvePerLinePatientPaid returns per-line raw when cite-grade
    // (sum matches header) AND value is non-null; otherwise pro-rates from
    // the effective claim-header patientPaid. Gates per-line LineDrawer
    // recovery strip rendering downstream.
    const linePatientPaidRaw =
      item.patient_paid_amount != null ? Number(item.patient_paid_amount) : null;
    const { value: patientPaid, source: patientPaidSource } =
      resolvePerLinePatientPaid({
        lineBilled: billed,
        linePatientPaid: linePatientPaidRaw,
        claimTotalBilled,
        effectiveClaimPatientPaid: effectiveTotals,
      });
    // S140 fix-pass H1 — pro-rate per-line writeoff when sparse so that
    // computeShouldOwe applies coinsurance to ADJUSTED billed (correct
    // insurance math: coinsurance % is contractually applied to allowed
    // amount, not gross billed). Reverses the earlier "keep raw" trade-off
    // — the trade-off was avoiding shouldOwe shift, but the prior math was
    // applying coinsurance to gross which over-counts cost-share. Fixing.
    const lineInsuranceAdjustedRaw =
      item.insurance_adjusted_amount != null
        ? Number(item.insurance_adjusted_amount)
        : null;
    const {
      value: lineInsuranceAdjusted,
      source: insuranceAdjustedSource,
    } = resolvePerLineInsuranceAdjusted({
      lineBilled: billed,
      lineInsuranceAdjusted: lineInsuranceAdjustedRaw,
      claimTotalBilled,
      effectiveClaimInsuranceAdjusted: effectiveTotals,
    });
    const adjustedBilled = Math.max(0, billed - lineInsuranceAdjusted);
    // S140 fix-pass H5 — pro-rate per-line insurance_paid (display only;
    // not consumed by recovery math). Without this, LineDrawer Bill card
    // + desktop YOU PAID column show "Insurer paid $0" on every line for
    // header-only EOBs while bill-level FlaggedBody shows the real total.
    const lineInsurancePaidRaw =
      item.insurance_paid != null ? Number(item.insurance_paid) : null;
    const {
      value: insurancePaidResolved,
      source: insurancePaidSource,
    } = resolvePerLineInsurancePaid({
      lineBilled: billed,
      lineInsurancePaid: lineInsurancePaidRaw,
      claimTotalBilled,
      effectiveClaimInsurancePaid: effectiveTotals,
    });
    const patientResponsibility = item.patient_owes != null
      ? Number(item.patient_owes)
      : resolveStillOutstanding({
          lineBilled: billed,
          lineStillOutstanding: item.amount_still_outstanding != null ? Number(item.amount_still_outstanding) : null,
          linePatientOwes: null,
          claimTotalBilled,
          claimStillOutstanding,
        });
    const recovery = computeRecoveryV2({
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
      recovery: recoveryWithProvenance,
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
    // S140 — recompute claim-level refund/forgive from CLAIM HEADER values
    // (exact, no pro-rate drift). shouldOwe stays as the per-line sum since
    // each line's shouldOwe is computed from plan coverage rules on raw
    // billed (independent of patient_paid sparsity).
    const claimLevelShouldOwe = lineSummedRecovery.shouldOwe;
    const headerPatientPaid = effectiveTotals.patientPaid;
    const headerPatientResp = effectiveTotals.patientResponsibility;
    const effectiveBurden = Math.max(headerPatientPaid, headerPatientResp);
    const potentialRecovery = Math.max(0, effectiveBurden - claimLevelShouldOwe);
    const refundComponent = Math.max(0, headerPatientPaid - claimLevelShouldOwe);
    const forgivenessComponent = Math.max(0, potentialRecovery - refundComponent);
    claimRecovery = {
      billed: claimTotalBilled,
      alreadyPaid: Math.max(0, claimTotalBilled - headerPatientResp),
      stillOutstanding: Math.max(0, headerPatientResp - headerPatientPaid),
      shouldOwe: claimLevelShouldOwe,
      potentialRecovery,
      refundComponent,
      forgivenessComponent,
      provenance: { citationSource: "claim_header" },
    };
  } else {
    claimRecovery = {
      ...lineSummedRecovery,
      provenance: { citationSource: "per_line_sum" },
    };
  }

  // Fetch linked disputes
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date")
    .eq("claim_id", claimId);

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
    const { data: grouped } = await supabase
      .from("claims")
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
    disputes: disputes || [],
    relatedClaims,
    recovery: claimRecovery,
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
