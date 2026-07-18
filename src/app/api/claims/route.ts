/**
 * GET /api/claims — Fetch user's claims with summary stats.
 * Returns paginated claims with line item counts, totals, and finding counts.
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import {
  computeRecoveryV2,
  type PlanCostShareParams,
  type CostShareOverrides,
  type CostShareVerdict,
  type RecoveryMetrics,
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
  readUserPatientPaidOverride,
  applyUserPatientPaidOverride,
} from "@/lib/claims/effective-totals";
import { buildAcaCoverageFallback, detectPreventiveMembership } from "@/lib/audit/aca-coverage-fallback";
import {
  loadPlanCoverageMeta,
  loadBillSlugMeta,
  loadSecondaryGate,
  DEFAULT_SECONDARY_GATE,
  type PlanCoverageMeta,
  type BillSlugMeta,
} from "@/lib/audit/coverage-loader";
import { isFeatureEnabled } from "@/lib/config/product-flags";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

interface RawClaim {
  id: string;
  source_document_id: string | null;
  date_of_service: string | null;
  total_billed: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  insurance_plan_id: string | null;
  amount_still_outstanding: number | null;
  total_patient_responsibility: number | null;
  status: string | null;
  [key: string]: unknown;
}

/**
 * S74 hotfix #3+#4 — collapse duplicate bill uploads at the display layer.
 *
 * Until the ingestion-layer dedup ships (file-hash check on /api/documents/upload),
 * a user re-uploading the same PDF creates multiple `claims` rows AND multiple
 * `documents` rows with DIFFERENT source_document_ids but identical provider +
 * date + total. The earlier hotfix preferred source_document_id when present →
 * distinct doc-ids meant no dedup. Reversed: composite is primary, doc_id is
 * fallback only when the composite can't be computed.
 *
 * Composite key: `(date_of_service, total_billed_cents, normalized_provider)`.
 * Edge case: two genuinely different bills with identical (date, total, provider)
 * from the same user collapse incorrectly — accepted tradeoff (real-world rare,
 * vs. visible duplicates on every test re-upload). The categorization flywheel
 * sprint will replace this with ingestion-layer file-hash dedup.
 *
 * Caller pre-sorts rawClaims DESC by created_at; the first occurrence wins.
 */
function dedupBillsByFingerprint(rawClaims: RawClaim[]): RawClaim[] {
  const seen = new Set<string>();
  const out: RawClaim[] = [];
  for (const c of rawClaims) {
    const provider =
      (c.metadata as { provider?: { name?: string } } | null)?.provider?.name?.trim().toLowerCase() ||
      "";
    // Round total to whole cents so floating-point noise from re-parses
    // (e.g., $1,297.00 vs $1297.0000001) doesn't break the fingerprint.
    const totalCents = Math.round(Number(c.total_billed ?? 0) * 100);
    const date = c.date_of_service ?? "";

    // Composite fingerprint is primary; collapses re-uploads of the same bill
    // even when each upload creates a different documents row.
    const composable = !!(provider && date && totalCents > 0);
    const fingerprint = composable
      ? `fp:${date}|${totalCents}|${provider}`
      : c.source_document_id
        ? `doc:${c.source_document_id}`
        : `id:${c.id}`; // last resort: each row is unique (no dedup happens)

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(c);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Resolve user_id from firebase_uid
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10), 50);
  const offset = (page - 1) * limit;
  // Simplified onboarding (S285): optional filter to the claim(s) born from a
  // specific uploaded document — powers the in-step bill-audit result on
  // /onboarding step 2. Additive; absent param = existing behavior.
  const documentId = req.nextUrl.searchParams.get("documentId");

  // Fetch claims. We deliberately over-fetch (no `.range()` cap on raw rows)
  // so the dedup pass below can collapse re-uploads of the same bill before
  // the paginated slice is taken. Without this, paginating raw rows would
  // surface duplicates as separate cards on /claim. Display-layer dedup; the
  // duplicate dispute_outcomes rows in the DB are untouched (a proper fix
  // lives at the ingestion layer + needs migration to merge existing dupes).
  // S74.5 D11 — exclude soft-deleted claims (merge losers + future
  // user-requested erasures). Filter is partial-index-backed (idx_claims_user_live).
  let claimsQuery = userScoped(supabase, user.id)
    .table("claims")
    .select("*")
    .is("deleted_at", null);
  if (documentId) {
    claimsQuery = claimsQuery.eq("source_document_id", documentId);
  }
  const { data: rawClaims, error } = await claimsQuery.order("created_at", {
    ascending: false,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const dedupedClaims = dedupBillsByFingerprint(rawClaims || []);
  // Apply pagination AFTER dedup so counts line up.
  const count = dedupedClaims.length;
  const claims = dedupedClaims.slice(offset, offset + limit);

  // Collect coverage maps per insurance_plan_id so we can derive "should owe"
  // and potential recovery per line without running N+1 queries.
  const planIds = Array.from(
    new Set(
      (claims || [])
        .map((c) => c.insurance_plan_id as string | null)
        .filter((id): id is string => !!id),
    ),
  );
  // S154 — shared secondary-match context (per-plan coverage incl. category +
  // ACA flag), so the LIST resolves coverage identically to the DETAIL GET.
  // Gated by secondary_coverage_v2 (OFF = pre-S153: exact-slug + ACA fallback
  // only). billSlugMeta is loaded in ONE pre-pass across every line on the page
  // so the per-claim loop below stays query-free for the match.
  const secondaryV2 = await isFeatureEnabled("secondary_coverage_v2");
  const planMetaByPlan: Map<string, PlanCoverageMeta> = await loadPlanCoverageMeta(
    supabase,
    planIds,
  );
  let billSlugMeta = new Map<string, BillSlugMeta>();
  if (secondaryV2) {
    const claimIdsForSlugs = (claims || []).map((c) => c.id as string);
    if (claimIdsForSlugs.length > 0) {
      // B9 B1.2 — claimIdsForSlugs are owned (from the user-scoped claims fetch);
      // selectOwnedChildren re-verifies + returns their lines.
      const slugRows = await selectOwnedChildren(
        supabase,
        user.id,
        "claim_line_items",
        claimIdsForSlugs,
        "service_slug",
      );
      billSlugMeta = await loadBillSlugMeta(
        supabase,
        (slugRows ?? []).map((r) => r.service_slug as string | null),
      );
    }
  }
  // S154 — gate thresholds (Ship Gate G6, tunable via flag config JSONB).
  const secondaryGate = secondaryV2
    ? await loadSecondaryGate(supabase)
    : DEFAULT_SECONDARY_GATE;

  // Cost-Share v2 (S214) — same server-side flag + engine as the detail GET.
  // OFF short-circuits before any new loader → byte-identical. Context is loaded
  // ONCE per request and BATCHED (never per-claim): plan params per distinct
  // plan, plan-year overrides per distinct (plan, year), and ALL accumulators in
  // a single selectOwnedChildren grouped by claim_id. ON adds ~(#plans +
  // #plan-years + 1) queries, never +3×N.
  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
  const csGate: CostShareGate = costShareV2
    ? await loadCostShareGate(supabase)
    : { minRecovery: 1 };
  const csPlanParamsByPlan = new Map<string, PlanCostShareParams | null>();
  const csOverridesByPlanYear = new Map<string, CostShareOverrides>();
  const csAccumulatorsByClaim = new Map<string, RawAccumulator[]>();
  if (costShareV2) {
    await Promise.all(
      planIds.map(async (pid) => {
        csPlanParamsByPlan.set(pid, await loadPlanCostShareParams(supabase, pid));
      }),
    );
    // distinct (plan, year) → plan-year deductible/OOP overrides (the per-claim
    // network override is folded in the loop, so cache with override=null).
    const planYearPairs = new Map<string, { planId: string; year: number }>();
    for (const c of claims || []) {
      const pid = c.insurance_plan_id as string | null;
      if (!pid || !c.date_of_service) continue;
      const year = new Date(c.date_of_service as string).getUTCFullYear();
      planYearPairs.set(`${pid}:${year}`, { planId: pid, year });
    }
    await Promise.all(
      [...planYearPairs.entries()].map(async ([key, { planId, year }]) => {
        csOverridesByPlanYear.set(
          key,
          await loadCostShareOverrides(supabase, user.id, planId, year, null),
        );
      }),
    );
    const allClaimIds = (claims || []).map((c) => c.id as string);
    if (allClaimIds.length > 0) {
      const accRows = await selectOwnedChildren(
        supabase,
        user.id,
        "claim_accumulators",
        allClaimIds,
        "claim_id, benefit_year, network_tier, accumulator_type, is_individual, deductible_applied, deductible_max, oop_applied, oop_max",
      );
      for (const row of accRows) {
        const cid = (row as Record<string, unknown>).claim_id as string;
        const arr = csAccumulatorsByClaim.get(cid) ?? [];
        arr.push(mapRawAccumulator(row));
        csAccumulatorsByClaim.set(cid, arr);
      }
    }
  }

  // For each claim, get line item summary + top findings + potential savings + recovery
  const claimsWithSummary = await Promise.all(
    (claims || []).map(async (claim) => {
      // B9 B1.2 — claim.id is already an owned claim (from the user-scoped claims
      // fetch above); selectOwnedChildren re-verifies ownership + returns its
      // lines. Per-claim call (minimal diff; runs inside Promise.all so the extra
      // ownership round-trip is parallel). cols byte-identical to the prior select.
      const lineItems = await selectOwnedChildren(
        supabase,
        user.id,
        "claim_line_items",
        [claim.id as string],
        "id, line_number, service_slug, billing_code, billing_code_type, metadata, billed_amount, patient_owes, insurance_paid, description, amount_still_outstanding, patient_paid_amount, insurance_adjusted_amount, member_applied_to_deductible, member_coinsurance, member_copay, denied_amount, network_status",
      );

      const items = lineItems || [];
      // Dispute Letters v2 (Z1.1d) — reflect the user's amount-paid override on the list
      // recovery summary too (parity with the dispute page). No-op when unset → byte-identical.
      {
        const ov = readUserPatientPaidOverride((claim as { metadata?: unknown }).metadata);
        if (ov != null) {
          applyUserPatientPaidOverride(
            claim as { total_patient_paid?: number | null },
            items as Array<{
              billed_amount?: number | null;
              patient_paid_amount?: number | null;
            }>,
            ov,
          );
        }
      }
      const planMeta = claim.insurance_plan_id
        ? planMetaByPlan.get(claim.insurance_plan_id)
        : undefined;
      const coverageMap = planMeta?.coverageMap;
      const claimTotalBilled = Number(claim.total_billed || 0);
      const claimStillOutstanding =
        claim.amount_still_outstanding != null
          ? Number(claim.amount_still_outstanding)
          : claim.total_patient_responsibility != null
            ? Number(claim.total_patient_responsibility)
            : null;

      // S135 — ACA fallback per claim. Mirrors detail endpoint's logic so the
      // list endpoint's bill-state decision honors ACA-mandated coverage on
      // lines whose slug isn't in plan_covered_services. Without this, ACA-
      // covered lines (e.g., 99385 Annual Physical on a plan that doesn't
      // enumerate preventive_visit_adult) count toward reviewNeededCount even
      // though the detail UI shows them as "Covered" via federal mandate.
      const acaFallback = await buildAcaCoverageFallback({
        supabase,
        planId: claim.insurance_plan_id as string | null,
        userId: claim.user_id as string,
        patientName: (claim.patient_name as string | null | undefined) ?? null,
        lineItems: items.map((li) => ({
          lineNumber: Number(li.line_number ?? 0),
          procedureCode: (li.billing_code as string | null) ?? null,
          procedureCodeType: (li.billing_code_type as string | null) ?? null,
          serviceSlug: (li.service_slug as string | null) ?? null,
        })),
        existingCoverageBySlug: new Set(coverageMap?.keys() ?? []),
      });

      // Cost-Share v2 — per-claim engine context, drawn from the batched caches
      // (no per-claim queries). All inert when the flag is OFF.
      const csPlanParams = costShareV2
        ? csPlanParamsByPlan.get(claim.insurance_plan_id as string) ?? null
        : null;
      const csPlanYear =
        costShareV2 && claim.date_of_service
          ? new Date(claim.date_of_service as string).getUTCFullYear()
          : null;
      const csOverrides: CostShareOverrides | null = costShareV2
        ? resolveOverridesForBill(
            {
              ...(csOverridesByPlanYear.get(`${claim.insurance_plan_id}:${csPlanYear}`) ?? {
                deductibleMet: null,
                deductibleMetAsOf: null,
                oopMet: null,
                oopMetAsOf: null,
                userNetworkOverride: null,
              }),
              userNetworkOverride: coerceNetworkOverride(claim.user_network_override),
            },
            (claim.date_of_service as string | null) ?? null,
          )
        : null;
      const csAccRows = costShareV2 ? csAccumulatorsByClaim.get(claim.id as string) ?? [] : [];
      // §18.10 list-swap — effectiveTotals is now UNCONDITIONAL (was costShareV2-gated):
      // resolveLinePrep (below) always header-prorates insuranceAdjusted from it, so it
      // cannot be null. Mirrors the detail route. Output-neutral when the flag is OFF —
      // that branch ignores lp.insuranceAdjusted (uses the raw per-line value).
      const csEffectiveTotals = resolveEffectiveClaimTotals({ claim, lineItems: items });
      const csMemberSums = { deductible: 0, oop: 0 };
      if (costShareV2) {
        for (const it of items) {
          const r = it as Record<string, unknown>;
          csMemberSums.deductible += Number(r.member_applied_to_deductible ?? 0);
          csMemberSums.oop += Number(r.member_coinsurance ?? 0) + Number(r.member_copay ?? 0);
        }
      }
      // W1 — preventive membership (plan-ACA-independent) + plan ACA status + claim-level
      // insurer-$0 corroboration. Per-claim (mirrors the acaFallback above); inert when OFF.
      const csPreventiveLines = costShareV2
        ? await detectPreventiveMembership({
            supabase,
            userId: claim.user_id as string,
            patientName: (claim.patient_name as string | null | undefined) ?? null,
            lineItems: items.map((li) => ({
              lineNumber: Number(li.line_number ?? 0),
              procedureCode: (li.billing_code as string | null) ?? null,
              procedureCodeType: (li.billing_code_type as string | null) ?? null,
              serviceSlug: (li.service_slug as string | null) ?? null,
            })),
          })
        : new Set<number>();
      const csAcaStatus: "confirmed" | "unknown" | "non_aca" =
        planMeta?.acaCompliant === true
          ? "confirmed"
          : planMeta?.acaCompliant === false
            ? "non_aca"
            : "unknown";
      const csClaimInsurerPaidZero =
        claim.total_insurance_paid != null && Number(claim.total_insurance_paid) === 0;

      // §18.9 — assemble the shared cost-share engine context ONCE per claim; the
      // per-line accumulator-resolve + computeCostShareV2 call now live in
      // resolveCostShareForLine (parity-locked vs the prior inline assembly). The
      // values are inert when costShareV2 is OFF (csCtx is only read in the ON branch).
      const csCtx: CostShareClaimCtx = {
        planParams: csPlanParams,
        overrides: csOverrides,
        accRows: csAccRows,
        memberSums: csMemberSums,
        preventiveLines: csPreventiveLines,
        acaStatus: csAcaStatus,
        claimInsurerPaidZero: csClaimInsurerPaidZero,
        gate: csGate,
        networkClaim: coerceNetworkTier(claim.network_status),
        coverageTier: csPlanParams?.coverageTier ?? null,
        planYear: csPlanYear,
      };

      // §18.10 list-swap — per-line PREP inputs (coverage + secondary + ACA-fallback +
      // proration context), assembled once per claim, fed to resolveLinePrep per line.
      // Mirrors the detail route; the per-line prep is byte-identical to the prior inline
      // given the same inputs (scripts/calibration/fixtures/cost-share-v2/prep-parity.ts,
      // strategy "list"). coverageMap is RICH (loadPlanCoverageMeta, line 183).
      const csPrepInputs: ClaimCostSharePrep = {
        coverageMap: coverageMap ?? new Map(),
        coveredMeta: planMeta?.coveredMeta ?? [],
        billSlugMeta,
        planAcaCompliant: planMeta?.acaCompliant ?? null,
        secondaryGate,
        secondaryEnabled: secondaryV2,
        acaFallback,
        claimTotalBilled,
        claimStillOutstanding,
        effectiveTotals: csEffectiveTotals,
      };

      let findingCount = 0;
      let potentialSavings = 0;
      let reviewNeededCount = 0;
      let lineItemPatientOwedSum = 0;
      let claimPotentialRecovery = 0;
      let claimAlreadyPaid = 0;
      let claimShouldOwe = 0;
      let claimRefund = 0;
      let claimForgiveness = 0;
      const topFindings: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }> = [];
      const reviewLineItems: Array<{
        id: string;
        description: string | null;
        billing_code: string | null;
        service_slug: string | null;
        billed_amount: number | null;
      }> = [];

      for (const item of items) {
        // F-5 — exclude dismissed findings from count/topFindings/potentialSavings
        // so summary cards match the detail-page state. Dismissed entries are
        // preserved in metadata for flywheel telemetry; not surfaced to the user.
        const findings = (item.metadata as Record<string, unknown>)?.auditFindings;
        if (Array.isArray(findings)) {
          const live = (findings as Array<Record<string, unknown>>).filter((f) => !f.dismissed);
          findingCount += live.length;
          for (const f of live) {
            const overcharge = Number(f.estimatedOvercharge || 0);
            potentialSavings += overcharge;
            topFindings.push({
              title: String(f.title || f.type || "Issue"),
              estimatedOvercharge: overcharge,
              billingCode: item.billing_code,
            });
          }
        }

        const billed = Number(item.billed_amount || 0);
        const paid = Number(item.insurance_paid || 0);
        const owed = Number(item.patient_owes || 0);
        // §18.10 list-swap — per-line cost-share PREP via the shared recipe (coverage:
        // exact slug → secondary → ACA fallback; writeoff proration + allowed; patientPaid +
        // patientResponsibility). Byte-identical to the prior inline given the same inputs
        // (scripts/calibration/fixtures/cost-share-v2/prep-parity.ts, strategy "list"). One
        // shared prep across the list + detail + dispute paths so they can't drift on how a
        // line resolves. coverageMap is RICH (loadPlanCoverageMeta).
        const lp = resolveLinePrep(item as Record<string, unknown>, csPrepInputs, "list");
        const coverage = lp.coverage;
        const patientPaid = lp.patientPaid;
        const patientResponsibility = lp.patientResponsibility;
        // Cost-Share v2 — when ON, the plan-derived phase engine replaces the
        // deductible-blind path (same as the detail GET). The result is a
        // RecoveryMetrics superset so the totals below consume it unchanged.
        // OFF = the exact computeRecoveryV2 call (byte-identical).
        let rec: RecoveryMetrics;
        let lineVerdict: CostShareVerdict | null = null;
        if (costShareV2) {
          // §18.9 — shared resolution layer; route-inputs.ts locks these engine inputs.
          // allowed + insuranceAdjusted are the recipe's header-prorated values.
          const cs = resolveCostShareForLine(
            {
              lineNumber: Number(item.line_number ?? 0),
              billed,
              allowed: lp.allowed,
              insuranceAdjusted: lp.insuranceAdjusted,
              patientPaid,
              patientResponsibility,
              coverage,
              networkStatus: (item as Record<string, unknown>).network_status as string | null,
              raw: item as Record<string, unknown>,
            },
            csCtx,
          );
          rec = cs;
          lineVerdict = cs.verdict;
        } else {
          // Rollback path (recovery_cost_share_v2 OFF). insuranceAdjusted stays the RAW
          // per-line value — NOT lp.insuranceAdjusted (header-prorated) — so this branch is
          // byte-identical to what it rolls back TO (pre-swap list-OFF behavior). Proof: all
          // 5 computeRecoveryV2 inputs are byte-identical — patientResponsibility/patientPaid/
          // coverage are prep-parity-proven; billed + this raw literal are untouched. (S120:
          // computeRecoveryV2 applies coinsurance to billed − insuranceAdjusted internally.)
          rec = computeRecoveryV2({
            billed,
            patientResponsibility,
            patientPaid,
            insuranceAdjusted: Number(item.insurance_adjusted_amount ?? 0),
            planCoverage: coverage,
          });
        }
        claimPotentialRecovery += rec.potentialRecovery;
        claimAlreadyPaid += rec.alreadyPaid;
        claimShouldOwe += rec.shouldOwe;
        claimRefund += rec.refundComponent;
        claimForgiveness += rec.forgivenessComponent;

        // needs_review counts gap rows ONLY when coverage is unknown — i.e.,
        // when the user still has something to act on. Once the user resolves
        // a slug (or Haiku auto-classifies to one with a plan_covered_services
        // row), the line is RESOLVED from the user's perspective even if the
        // EOB never allocated dollars to it. The unallocated-dollars signal
        // still surfaces per-line via the gap-explanation panel; it just
        // doesn't bubble up to the bill-level "Needs review" badge once the
        // user has done everything they can do.
        // Cost-Share v2 — when ON, a line the engine affirmatively cleared
        // (verdict 'correct'/'confident', e.g. a deductible-phase bill) is no
        // longer "needs review". A data-poor 'insufficient' line STILL counts —
        // the user must add plan data. OFF (lineVerdict null) = today's behavior.
        const csCleared = lineVerdict === "correct" || lineVerdict === "confident";
        if (billed > 0 && paid === 0 && owed === 0 && !coverage && !csCleared) {
          reviewNeededCount++;
          reviewLineItems.push({
            id: item.id,
            description: item.description,
            billing_code: item.billing_code,
            service_slug: item.service_slug,
            billed_amount: item.billed_amount,
          });
        }
        lineItemPatientOwedSum += owed;
      }

      // F-5 — surface claim-level findings (D15 unallocated_balance + future
      // claim-header types) on the summary card. They're persisted on
      // claim.metadata.auditSummary.claimLevelFindings via audit/index.ts:49-66
      // (§1.7 partition). Without this they'd be invisible to /claim list.
      const claimMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
      const auditSummary = (claimMeta.auditSummary as Record<string, unknown> | null) ?? null;
      const claimLevelFindings = Array.isArray(auditSummary?.claimLevelFindings)
        ? (auditSummary?.claimLevelFindings as Array<Record<string, unknown>>)
        : [];
      const liveClaimLevel = claimLevelFindings.filter((f) => !f.dismissed);
      findingCount += liveClaimLevel.length;
      for (const f of liveClaimLevel) {
        const overcharge = Number(f.estimatedOvercharge || 0);
        potentialSavings += overcharge;
        topFindings.push({
          title: String(f.title || f.type || "Issue"),
          estimatedOvercharge: overcharge,
          billingCode: null,
        });
      }

      // Keep top 3 findings by overcharge size
      topFindings.sort((a, b) => b.estimatedOvercharge - a.estimatedOvercharge);

      // Header-only fallback: if no line items were extracted but the claim
      // header has totals, derive claim-level recovery from those so the
      // UI still surfaces a meaningful Potential Recovery number.
      let recoveryBlock;
      if (items.length === 0 && claimTotalBilled > 0) {
        const stillOutstanding = claimStillOutstanding ?? 0;
        const alreadyPaid = Math.max(0, claimTotalBilled - stillOutstanding);
        const shouldOwe = 0;
        const potentialRecovery = Math.max(0, claimTotalBilled - shouldOwe);
        recoveryBlock = {
          billed: claimTotalBilled,
          alreadyPaid,
          stillOutstanding,
          shouldOwe,
          potentialRecovery,
          refundComponent: Math.max(0, alreadyPaid - shouldOwe),
          forgivenessComponent: Math.max(0, stillOutstanding - shouldOwe),
        };
      } else {
        recoveryBlock = {
          billed: claimTotalBilled,
          alreadyPaid: claimAlreadyPaid,
          stillOutstanding:
            claimStillOutstanding != null
              ? claimStillOutstanding
              : items.reduce((s, it) => s + Number(it.amount_still_outstanding || 0), 0),
          shouldOwe: claimShouldOwe,
          potentialRecovery: claimPotentialRecovery,
          refundComponent: claimRefund,
          forgivenessComponent: claimForgiveness,
        };
      }

      // Session 86 — expose post-adjustment billed total so BillCard can
      // surface "Billed (adj.)" headline math that reconciles with "You
      // should owe" + recovery. Prefer the claim-header value (written by
      // persist.ts from mig 092) and fall back to summing per-line
      // insurance_adjusted_amount when the header is NULL on legacy rows.
      const totalInsuranceAdjusted = claim.total_insurance_adjusted != null
        ? Number(claim.total_insurance_adjusted)
        : items.reduce((s, it) => s + Number(it.insurance_adjusted_amount ?? 0), 0);

      return {
        ...claim,
        lineItemCount: items.length,
        findingCount,
        reviewNeededCount,
        reviewLineItems,
        potentialSavings,
        lineItemPatientOwedSum,
        topFindings: topFindings.slice(0, 3),
        providerName: (claim.metadata as Record<string, unknown>)?.provider
          ? ((claim.metadata as Record<string, unknown>).provider as Record<string, unknown>)?.name || "Unknown Provider"
          : "Unknown Provider",
        recovery: recoveryBlock,
        total_insurance_adjusted: totalInsuranceAdjusted,
      };
    })
  );

  // Summary stats — also deduped via the same fingerprint so totalBills and
  // issues counts match what the paginated /claim view actually shows.
  const { data: allClaimsRaw } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, status, total_billed, total_patient_responsibility, source_document_id, date_of_service, metadata, created_at, claim_group_id, insurance_plan_id, amount_still_outstanding")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const allClaims = dedupBillsByFingerprint((allClaimsRaw as RawClaim[]) || []);

  // Aggregate potential savings across all claims' line items.
  // "Issues flagged" = classic audit findings + unverified-charge review cases.
  let totalPotentialSavings = 0;
  let totalIssuesFlagged = 0;
  if (allClaims && allClaims.length > 0) {
    // B9 B1.2 — allClaims are owned (deduped from the user-scoped fetch);
    // selectOwnedChildren re-verifies + returns their lines.
    const allLineItems = await selectOwnedChildren(
      supabase,
      user.id,
      "claim_line_items",
      allClaims.map((c) => c.id as string),
      "metadata, claim_id, billed_amount, insurance_paid, patient_owes",
    );

    for (const li of allLineItems || []) {
      const findings = (li.metadata as Record<string, unknown>)?.auditFindings;
      if (Array.isArray(findings)) {
        // F-5 — exclude dismissed entries
        for (const f of (findings as Array<Record<string, unknown>>).filter((x) => !x.dismissed)) {
          totalPotentialSavings += Number(f.estimatedOvercharge || 0);
          totalIssuesFlagged += 1;
        }
      }
      // Also count unexplained-gap lines (billed > 0, paid + owed = 0)
      const billed = Number(li.billed_amount || 0);
      const paid = Number(li.insurance_paid || 0);
      const owed = Number(li.patient_owes || 0);
      if (billed > 0 && paid === 0 && owed === 0) {
        totalIssuesFlagged += 1;
      }
    }

    // F-5 — also fold claim-level findings (D15 unallocated_balance etc.)
    // into the totals so the top-hero "Issues flagged" + savings reflect them.
    for (const c of allClaims) {
      const meta = (c.metadata as Record<string, unknown> | null) ?? {};
      const summary = (meta.auditSummary as Record<string, unknown> | null) ?? null;
      const claimLevel = Array.isArray(summary?.claimLevelFindings)
        ? (summary!.claimLevelFindings as Array<Record<string, unknown>>)
        : [];
      for (const f of claimLevel.filter((x) => !x.dismissed)) {
        totalPotentialSavings += Number(f.estimatedOvercharge || 0);
        totalIssuesFlagged += 1;
      }
    }
  }

  // Roll up paginated claims' recovery figures into a stats block so the
  // ClaimImpactHero can surface "Potential Recovery" as the headline metric
  // without re-computing.
  const totalPotentialRecovery = claimsWithSummary.reduce((s, c) => s + (c.recovery?.potentialRecovery || 0), 0);
  const totalRefundComponent = claimsWithSummary.reduce((s, c) => s + (c.recovery?.refundComponent || 0), 0);
  const totalForgivenessComponent = claimsWithSummary.reduce((s, c) => s + (c.recovery?.forgivenessComponent || 0), 0);
  const totalAlreadyPaid = claimsWithSummary.reduce((s, c) => s + (c.recovery?.alreadyPaid || 0), 0);

  const stats = {
    totalBills: allClaims?.length || 0,
    flaggedBills: allClaims?.filter((c) => c.status === "flagged").length || 0,
    totalBilled: allClaims?.reduce((sum, c) => sum + (c.total_billed || 0), 0) || 0,
    totalPatientResponsibility: allClaims?.reduce((sum, c) => sum + (c.total_patient_responsibility || 0), 0) || 0,
    totalPotentialSavings,
    totalIssuesFlagged,
    totalPotentialRecovery,
    totalRefundComponent,
    totalForgivenessComponent,
    totalAlreadyPaid,
  };

  return NextResponse.json({
    claims: claimsWithSummary,
    stats,
    pagination: { page, limit, total: count || 0 },
  });
}
