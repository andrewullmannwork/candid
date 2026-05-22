/**
 * POST /api/disputes/[disputeId]/confirm-same-plan — S109 PR #2 (Chunk B).
 *
 * Persists the user's same-plan-confirmation answer for a fallback-only
 * dispute. The answer drives whether the dispute letter renders Case C-
 * fallback (cite current plan as proxy) or Case D (safe framing only).
 *
 * Body: { answer: 'yes' | 'no' | 'not_sure', acceptedProxy?: boolean }
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
 *
 * Persists answer to dispute.metadata.userConfirmedSamePlan. The GET handler
 * at /api/disputes/[disputeId] reads it on next fetch and passes through to
 * resolveEvidence, which controls fallback-coverage loading.
 *
 * S111 smoke #2 — `acceptedProxy` (optional) distinguishes "user clicked
 * Yes and is deciding what to do next" from "user explicitly chose to cite
 * current plan as proxy (weaker)". When true, persists
 * dispute.metadata.userAcceptedProxy. The VerifStrip uses this flag to
 * derive whether to show the confirm-archive prompt (archive available,
 * decision pending) or the bound-proxy state (decision made).
 *
 * Returns: { success: true, userConfirmedSamePlan: <answer>, userAcceptedProxy: <bool> }
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

type SamePlanAnswer = "yes" | "no" | "not_sure";

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

  const body = (await req.json().catch(() => null)) as {
    answer?: unknown;
    acceptedProxy?: unknown;
  } | null;
  const answer = body?.answer;
  if (answer !== "yes" && answer !== "no" && answer !== "not_sure") {
    return NextResponse.json(
      { error: "answer must be 'yes', 'no', or 'not_sure'" },
      { status: 400 },
    );
  }
  const acceptedProxy = body?.acceptedProxy === true;

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

  const baseMetadata = (dispute.metadata as Record<string, unknown>) ?? {};
  const nextMetadata: Record<string, unknown> = {
    ...baseMetadata,
    userConfirmedSamePlan: answer as SamePlanAnswer,
    userConfirmedSamePlanAt: new Date().toISOString(),
  };
  if (acceptedProxy) {
    nextMetadata.userAcceptedProxy = true;
    nextMetadata.userAcceptedProxyAt = new Date().toISOString();
  }
  // Note: we intentionally do NOT clear userAcceptedProxy when acceptedProxy
  // is undefined/false — the user's explicit proxy decision persists across
  // re-confirmations unless explicitly reset (e.g., via a future re-bind that
  // sets a real canonical, which derives bound-verified state regardless of
  // this flag).

  const { error: updateErr } = await supabase
    .from("dispute_outcomes")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[confirm-same-plan] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist confirmation" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    userConfirmedSamePlan: answer as SamePlanAnswer,
    userAcceptedProxy: !!nextMetadata.userAcceptedProxy,
  });
}
