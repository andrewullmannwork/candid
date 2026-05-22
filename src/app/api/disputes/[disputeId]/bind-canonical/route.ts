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
    .select("id, metadata")
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

  const { error: updateErr } = await supabase
    .from("dispute_outcomes")
    .update({
      metadata: {
        ...((dispute.metadata as Record<string, unknown>) ?? {}),
        canonicalPlanIdForBillYear: canonicalPlanId,
        canonicalPlanBoundAt: new Date().toISOString(),
      },
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
