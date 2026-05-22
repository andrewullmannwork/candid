/**
 * POST /api/disputes/[disputeId]/bind-canonical — S110 Chunk D.
 *
 * Persists a user's explicit binding of a canonical_plans row as the bill-
 * year plan for this dispute. Selected via SearchCanonicalPlanModal when the
 * user (a) has no plan on file for the bill year, AND (b) clicks "No,
 * different insurer" on SamePlanConfirmBanner (or directly opens the
 * "Find my <billYear> plan in Candid's library" affordance).
 *
 * Body: { canonicalPlanId: string }
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute. Verifies the
 * canonical_plans row exists (no orphan binds).
 *
 * Persists `canonicalPlanIdForBillYear` to dispute.metadata. The GET handler
 * at /api/disputes/[disputeId] reads it on next fetch and passes through to
 * resolveEvidence's source-priority chain (manual bind beats archive auto-
 * lookup beats user_fallback) so the letter cites the bound canonical.
 *
 * Pattern 1 #2 ("no fabricated citations") preserved at the data layer: the
 * bound canonical's terms ARE the cited terms; the user's explicit selection
 * IS the same-plan confirmation. Bypass of isArchiveLookupEligible gate is
 * intentional — manual bind is stronger evidence of user intent than the
 * coarse banner answer.
 *
 * Returns: { success: true, canonicalPlanIdForBillYear: <id> }
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
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
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { canonicalPlanId?: unknown } | null;
  const canonicalPlanId = body?.canonicalPlanId;
  if (typeof canonicalPlanId !== "string" || canonicalPlanId.length === 0) {
    return NextResponse.json(
      { error: "canonicalPlanId must be a non-empty string" },
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

  const { data: dispute, error: fetchErr } = await supabase
    .from("dispute_outcomes")
    .select("id, metadata, claim_id, claim_line_item_id, dispute_type")
    .eq("id", disputeId)
    .eq("user_id", user.id)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // Verify the canonical exists. Pattern 1 #2 — never bind a non-existent
  // reference; the letter would emit a broken citation block when resolveEvidence
  // hit a null canonical_plan_services lookup.
  const { data: canonicalRow, error: canonicalErr } = await supabase
    .from("canonical_plans")
    .select("id")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (canonicalErr || !canonicalRow) {
    return NextResponse.json(
      { error: "Canonical plan not found" },
      { status: 404 },
    );
  }

  // S111 smoke iteration 5 — capture pre-bind coverage snapshot so the next
  // GET can compute a diff + validity verdict for the user. We resolve plan
  // context + evidence with the CURRENT (pre-update) metadata so the
  // snapshot reflects what the dispute was citing before this bind. Failure
  // here is non-fatal — bind proceeds; the diff just won't surface on the
  // next render.
  let preBindCoverageSnapshot: ReturnType<
    typeof captureCoverageSnapshot
  > | null = null;
  try {
    if (dispute.claim_id) {
      const prevMetadata =
        (dispute.metadata as Record<string, unknown> | null) ?? {};
      const prevCanonicalPlanIdForBillYear =
        typeof prevMetadata.canonicalPlanIdForBillYear === "string" &&
        (prevMetadata.canonicalPlanIdForBillYear as string).length > 0
          ? (prevMetadata.canonicalPlanIdForBillYear as string)
          : null;
      const prevUserConfirmedSamePlan =
        prevMetadata.userConfirmedSamePlan === "yes" ||
        prevMetadata.userConfirmedSamePlan === "no" ||
        prevMetadata.userConfirmedSamePlan === "not_sure"
          ? (prevMetadata.userConfirmedSamePlan as
              | "yes"
              | "no"
              | "not_sure")
          : null;
      const prevPlanContext = await resolvePlanContext(supabase, {
        userId: user.id,
        claimId: dispute.claim_id as string,
        canonicalPlanIdForBillYear: prevCanonicalPlanIdForBillYear,
      });
      const extraLineItemIds =
        (prevMetadata.claimLineItemIds as string[] | undefined) ?? [];
      const allLineItemIds = Array.from(
        new Set(
          [dispute.claim_line_item_id, ...extraLineItemIds].filter(Boolean),
        ),
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
      preBindCoverageSnapshot = captureCoverageSnapshot(
        prevEvidence,
        prevPlanContext,
      );
    }
  } catch (snapshotErr) {
    console.warn(
      "[bind-canonical] pre-bind snapshot capture failed (non-fatal):",
      snapshotErr,
    );
  }

  const nextMetadata: Record<string, unknown> = {
    ...((dispute.metadata as Record<string, unknown>) ?? {}),
    canonicalPlanIdForBillYear: canonicalPlanId,
    canonicalPlanBoundAt: new Date().toISOString(),
    // S111 smoke iteration 5 — reset the wrong-year banner dismissal on
    // each new bind so the banner re-evaluates against the new bound
    // canonical's year (if the user binds another wrong-year plan, they
    // should see the banner again).
    wrongYearBannerDismissed: false,
  };
  if (preBindCoverageSnapshot) {
    nextMetadata.preBindCoverageSnapshot = preBindCoverageSnapshot;
  }

  const { error: updateErr } = await supabase
    .from("dispute_outcomes")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[bind-canonical] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist binding" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    canonicalPlanIdForBillYear: canonicalPlanId,
  });
}
