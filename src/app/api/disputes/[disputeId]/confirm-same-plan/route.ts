/**
 * POST /api/disputes/[disputeId]/confirm-same-plan — S109 PR #2 (Chunk B).
 *
 * Persists the user's same-plan-confirmation answer for a fallback-only
 * dispute. The answer drives whether the dispute letter renders Case C-
 * fallback (cite current plan as proxy) or Case D (safe framing only).
 *
 * Body: { answer: 'yes' | 'no' | 'not_sure' }
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
 *
 * Persists answer to dispute.metadata.userConfirmedSamePlan. The GET handler
 * at /api/disputes/[disputeId] reads it on next fetch and passes through to
 * resolveEvidence, which controls fallback-coverage loading.
 *
 * Returns: { success: true, userConfirmedSamePlan: <answer> }
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

  const body = (await req.json().catch(() => null)) as { answer?: unknown } | null;
  const answer = body?.answer;
  if (answer !== "yes" && answer !== "no" && answer !== "not_sure") {
    return NextResponse.json(
      { error: "answer must be 'yes', 'no', or 'not_sure'" },
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

  const { error: updateErr } = await supabase
    .from("dispute_outcomes")
    .update({
      metadata: {
        ...((dispute.metadata as Record<string, unknown>) ?? {}),
        userConfirmedSamePlan: answer as SamePlanAnswer,
        userConfirmedSamePlanAt: new Date().toISOString(),
      },
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
  });
}
