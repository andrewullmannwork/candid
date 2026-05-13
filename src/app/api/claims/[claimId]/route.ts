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
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { maybeReauditClaim } from "@/lib/audit/reaudit";

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

  if (claim.insurance_plan_id) {
    const { data: coveredServices } = await supabase
      .from("plan_covered_services")
      .select("covered, in_copay, in_coinsurance, source, service_catalog!inner(slug)")
      .eq("insurance_plan_id", claim.insurance_plan_id);

    if (coveredServices) {
      for (const svc of coveredServices) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slug = (svc.service_catalog as any)?.slug as string | undefined;
        if (slug) {
          coverageMap.set(slug, {
            covered: svc.covered,
            copay: svc.in_copay,
            coinsurance: svc.in_coinsurance,
            source: svc.source,
          });
        }
      }
    }
  }

  // Claim-level totals used as pro-rate fallback when individual line items
  // lack allocation (the common Haiku header-only case).
  const claimTotalBilled = Number(claim.total_billed || 0);
  const claimStillOutstanding =
    claim.amount_still_outstanding != null
      ? Number(claim.amount_still_outstanding)
      : claim.total_patient_responsibility != null
        ? Number(claim.total_patient_responsibility)
        : null;

  // Enrich line items with coverage status + recovery metrics
  const enrichedLineItems = (lineItems || []).map((item) => {
    const coverage: PlanCoverageInput | null = item.service_slug
      ? coverageMap.get(item.service_slug) || null
      : null;

    const billed = Number(item.billed_amount || 0);
    // F-1 / mig 092 — patient_paid_amount column drives refund/forgiveness split.
    const patientPaid = Number(item.patient_paid_amount ?? 0);
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
      planCoverage: coverage,
    });

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
      coverageStatus: coverage
        ? coverage.covered === false
          ? "not_covered"
          : "covered"
        : item.service_slug
          ? "unknown"
          : null,
      planCoverage: coverage || null,
      recovery,
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

  // Header-only fallback: when line items weren't extracted (common for EOBs
  // where Haiku captured the header totals but no per-line allocation), derive
  // recovery directly from the claim header so the UI still surfaces a
  // meaningful Potential Recovery number instead of $0.
  const claimRecovery =
    enrichedLineItems.length === 0 && claimTotalBilled > 0
      ? (() => {
          const stillOutstanding = claimStillOutstanding ?? 0;
          const alreadyPaid = Math.max(0, claimTotalBilled - stillOutstanding);
          // Without line-level service_slug we can't resolve a plan copay; assume
          // $0 should-owe for header-only claims (the dispute is "you shouldn't
          // owe any of this"). Session 36 reconciler will fix by synthesizing
          // line items from the header before this branch ever fires.
          const shouldOwe = 0;
          const potentialRecovery = Math.max(0, claimTotalBilled - shouldOwe);
          return {
            billed: claimTotalBilled,
            alreadyPaid,
            stillOutstanding,
            shouldOwe,
            potentialRecovery,
            refundComponent: Math.max(0, alreadyPaid - shouldOwe),
            forgivenessComponent: Math.max(0, stillOutstanding - shouldOwe),
          };
        })()
      : lineSummedRecovery;

  // Fetch linked disputes
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date")
    .eq("claim_id", claimId);

  // Fetch related claims in same group
  let relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number }> = [];
  if (claim.claim_group_id) {
    const { data: grouped } = await supabase
      .from("claims")
      .select("id, date_of_service, status, total_billed")
      .eq("claim_group_id", claim.claim_group_id)
      .neq("id", claimId);
    relatedClaims = grouped || [];
  }

  return NextResponse.json({
    claim,
    lineItems: enrichedLineItems,
    disputes: disputes || [],
    relatedClaims,
    recovery: claimRecovery,
    flags: {
      categorizationFlywheelV1: flywheelEnabled,
    },
    // S74.5 D7 — surface re-audit outcome for telemetry + client toasts.
    // null when flag off or claim wasn't stale.
    reaudit: reauditResult,
  });
}
