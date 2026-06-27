/**
 * POST /api/disputes/[disputeId]/repin — dispute_plan_pinning_v1 (Phase 4).
 *
 * Re-pins a dispute to a different one of the user's OWN insurance plans
 * (dispute_outcomes.insurance_plan_id). Sibling to bind-canonical, which binds a
 * canonical *library* plan; this pins an own plan the user has on file. Per R4
 * the pin wins over a canonical-bind during resolution.
 *
 * Mirrors bind-canonical's transition pattern: capture preBindCoverageSnapshot
 * from the CURRENT pin, set the new pin, and let the GET handler re-resolve the
 * letter on the new plan + compute the coverage diff + verdict (CoverageDiffPanel,
 * including the `invalidated` "no longer applies" case + its auto-withdraw). No
 * eager regeneration — the GET rebuilds drafts lazily and skips sent letters.
 *
 * Body: { insurancePlanId: string }  (must be a plan the caller owns)
 * Guards: flag ON (else 404 — flag-OFF byte-identical); draft only (never mutate
 *   a sent letter — R7); chosen plan user-owned (no IDOR); no-op when already
 *   pinned to it.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { captureCoverageSnapshot } from "@/lib/disputes/coverage-snapshot";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  // Flag gate — inert (404) when OFF so flag-OFF behavior is byte-identical.
  const planPinningEnabled = await isFeatureEnabled("dispute_plan_pinning_v1");
  if (!planPinningEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { insurancePlanId?: unknown } | null;
  const insurancePlanId = body?.insurancePlanId;
  if (typeof insurancePlanId !== "string" || insurancePlanId.length === 0) {
    return NextResponse.json(
      { error: "insurancePlanId must be a non-empty string" },
      { status: 400 },
    );
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error: fetchErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select(
      "id, metadata, claim_id, claim_line_item_id, dispute_type, insurance_plan_id, sent_at",
    )
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // R7 — never change the plan on a sent letter (sent_letter is the immutable
  // chain-of-custody record). Sent disputes use the existing drift banner.
  if (dispute.sent_at != null) {
    return NextResponse.json(
      { error: "This letter has been sent and can no longer be re-pinned." },
      { status: 409 },
    );
  }

  // Validate the chosen plan is one the user OWNS — insurancePlanId is body-
  // supplied / attacker-controlled. userScoped injects .eq("user_id").
  const { data: ownedPlan } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .select("id")
    .eq("id", insurancePlanId)
    .maybeSingle();
  if (!ownedPlan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  // Idempotency — re-pinning to the already-pinned plan is a no-op.
  if (dispute.insurance_plan_id === insurancePlanId) {
    return NextResponse.json({ success: true, insurancePlanId, unchanged: true });
  }

  // Capture a pre-change coverage snapshot from the CURRENT pin so the next GET
  // can diff old-plan vs new-plan + render the validity verdict. Non-fatal —
  // the re-pin proceeds even if the snapshot fails (diff just won't surface).
  let preBindCoverageSnapshot: ReturnType<typeof captureCoverageSnapshot> | null = null;
  try {
    if (dispute.claim_id) {
      const prevMetadata = (dispute.metadata as Record<string, unknown> | null) ?? {};
      const prevCanonicalPlanIdForBillYear =
        typeof prevMetadata.canonicalPlanIdForBillYear === "string" &&
        (prevMetadata.canonicalPlanIdForBillYear as string).length > 0
          ? (prevMetadata.canonicalPlanIdForBillYear as string)
          : null;
      const prevUserConfirmedSamePlan =
        prevMetadata.userConfirmedSamePlan === "yes" ||
        prevMetadata.userConfirmedSamePlan === "no" ||
        prevMetadata.userConfirmedSamePlan === "not_sure"
          ? (prevMetadata.userConfirmedSamePlan as "yes" | "no" | "not_sure")
          : null;
      const prevPlanContext = await resolvePlanContext(supabase, {
        userId: user.id,
        claimId: dispute.claim_id as string,
        canonicalPlanIdForBillYear: prevCanonicalPlanIdForBillYear,
        // The "before" reflects the CURRENT override (before we change it below).
        pinnedInsurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
      });
      const extraLineItemIds =
        (prevMetadata.claimLineItemIds as string[] | undefined) ?? [];
      const allLineItemIds = Array.from(
        new Set([dispute.claim_line_item_id, ...extraLineItemIds].filter(Boolean)),
      ) as string[];
      const prevEvidence = await resolveEvidence(supabase, {
        userId: user.id,
        claimIds: [dispute.claim_id as string],
        lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
        planContext: prevPlanContext,
        letterType: dispute.dispute_type,
        disputeId: dispute.id,
        userConfirmedSamePlan: prevUserConfirmedSamePlan,
        canonicalPlanIdForBillYear: prevCanonicalPlanIdForBillYear,
      });
      preBindCoverageSnapshot = captureCoverageSnapshot(prevEvidence, prevPlanContext);
    }
  } catch (snapshotErr) {
    console.warn("[repin] pre-change snapshot capture failed (non-fatal):", snapshotErr);
  }

  const nextMetadata: Record<string, unknown> = {
    ...((dispute.metadata as Record<string, unknown>) ?? {}),
  };
  if (preBindCoverageSnapshot) {
    nextMetadata.preBindCoverageSnapshot = preBindCoverageSnapshot;
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      insurance_plan_id: insurancePlanId,
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[repin] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to re-pin dispute" }, { status: 500 });
  }

  return NextResponse.json({ success: true, insurancePlanId });
}
