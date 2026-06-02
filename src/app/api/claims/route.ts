/**
 * GET /api/claims — Fetch user's claims with summary stats.
 * Returns paginated claims with line item counts, totals, and finding counts.
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  computeRecoveryV2,
  resolveStillOutstanding,
  type PlanCoverageInput,
} from "@/lib/claims/recovery-math";
import { buildAcaCoverageFallback } from "@/lib/audit/aca-coverage-fallback";
import {
  resolveLineCoverage,
  resolveSecondaryCoverage,
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

  // Fetch claims. We deliberately over-fetch (no `.range()` cap on raw rows)
  // so the dedup pass below can collapse re-uploads of the same bill before
  // the paginated slice is taken. Without this, paginating raw rows would
  // surface duplicates as separate cards on /claim. Display-layer dedup; the
  // duplicate dispute_outcomes rows in the DB are untouched (a proper fix
  // lives at the ingestion layer + needs migration to merge existing dupes).
  // S74.5 D11 — exclude soft-deleted claims (merge losers + future
  // user-requested erasures). Filter is partial-index-backed (idx_claims_user_live).
  const { data: rawClaims, error } = await supabase
    .from("claims")
    .select("*")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

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
      const { data: slugRows } = await supabase
        .from("claim_line_items")
        .select("service_slug")
        .in("claim_id", claimIdsForSlugs);
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

  // For each claim, get line item summary + top findings + potential savings + recovery
  const claimsWithSummary = await Promise.all(
    (claims || []).map(async (claim) => {
      const { data: lineItems } = await supabase
        .from("claim_line_items")
        .select("id, line_number, service_slug, billing_code, billing_code_type, metadata, billed_amount, patient_owes, insurance_paid, description, amount_still_outstanding, patient_paid_amount, insurance_adjusted_amount")
        .eq("claim_id", claim.id);

      const items = lineItems || [];
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
        // F-1 / mig 092 — patient_paid_amount column drives refund/forgiveness
        // split. Defaults to 0 on legacy rows.
        const patientPaid = Number(item.patient_paid_amount ?? 0);

        // F-1 — recovery uses patient_responsibility (= patient_owes) directly
        // rather than the legacy `stillOutstanding` heuristic. patient_owes is
        // the total assigned share; patient_paid_amount is how much the user
        // has paid OOP. Refund/forgiveness split derives from those two.
        // S135 — coverage resolved via the 4-state ACA matrix helper. ACA wins
        // on conflict for math + bill state; plan wins on match. ACA-only when
        // plan missing slug. Symmetric with detail endpoint.
        let rawPlanCoverage: PlanCoverageInput | null =
          (item.service_slug && coverageMap?.get(item.service_slug)) || null;
        // S154 — secondary (category) match when the exact slug has no plan row,
        // mirroring the DETAIL GET so list/dashboard agree with the detail page.
        // BOTH `confident` and `estimate` results count as covered here (per
        // Andrew: never regress an identified service to "needs review"); the
        // estimate's Verify affordance + dispute demotion live on the detail
        // surface, keyed off coverageSource/confidence.
        if (secondaryV2 && !rawPlanCoverage && item.service_slug) {
          const meta = billSlugMeta.get(item.service_slug as string);
          if (meta) {
            const sec = resolveSecondaryCoverage(
              item.service_slug as string,
              meta,
              planMeta?.coveredMeta ?? [],
              planMeta?.acaCompliant ?? null,
              secondaryGate,
            );
            if (sec) rawPlanCoverage = sec.coverage;
          }
        }
        const acaCoverage: PlanCoverageInput | null =
          acaFallback.byLineNumber.get(Number(item.line_number ?? 0)) || null;
        const { coverage } = resolveLineCoverage(
          rawPlanCoverage,
          acaCoverage,
          acaFallback.planMeta,
        );
        const patientResponsibility = owed || resolveStillOutstanding({
          lineBilled: billed,
          lineStillOutstanding: item.amount_still_outstanding != null ? Number(item.amount_still_outstanding) : null,
          linePatientOwes: owed,
          claimTotalBilled,
          claimStillOutstanding,
        });
        const rec = computeRecoveryV2({
          billed,
          patientResponsibility,
          patientPaid,
          // S120 — apply coinsurance to ADJUSTED billed (post-writeoff), not
          // gross billed. Without this, recovery math overstates patient share
          // by the full insurer contractual writeoff.
          insuranceAdjusted: Number(item.insurance_adjusted_amount ?? 0),
          planCoverage: coverage,
        });
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
        if (billed > 0 && paid === 0 && owed === 0 && !coverage) {
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
  const { data: allClaimsRaw } = await supabase
    .from("claims")
    .select("id, status, total_billed, total_patient_responsibility, source_document_id, date_of_service, metadata, created_at, claim_group_id, insurance_plan_id, amount_still_outstanding")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const allClaims = dedupBillsByFingerprint((allClaimsRaw as RawClaim[]) || []);

  // Aggregate potential savings across all claims' line items.
  // "Issues flagged" = classic audit findings + unverified-charge review cases.
  let totalPotentialSavings = 0;
  let totalIssuesFlagged = 0;
  if (allClaims && allClaims.length > 0) {
    const { data: allLineItems } = await supabase
      .from("claim_line_items")
      .select("metadata, claim_id, billed_amount, insurance_paid, patient_owes")
      .in("claim_id", allClaims.map((c) => c.id));

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
