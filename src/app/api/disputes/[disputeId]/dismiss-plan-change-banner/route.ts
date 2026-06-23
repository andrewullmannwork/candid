/**
 * POST /api/disputes/[disputeId]/dismiss-plan-change-banner — dispute_plan_pinning_v1
 * (Phase 3). Persists the user's "Keep" on the plan-change banner so it doesn't
 * re-nag. Keyed to the specific switch (changed_at); a NEW switch away from the
 * dispute's pinned plan re-fires the banner (the GET compares the stored
 * dismissal to the latest switch's changed_at).
 *
 * Body: { changedAt: string }  (the switch timestamp from the banner payload)
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

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

  const body = (await req.json().catch(() => null)) as { changedAt?: unknown } | null;
  const changedAt = body?.changedAt;
  if (typeof changedAt !== "string" || changedAt.length === 0) {
    return NextResponse.json(
      { error: "changedAt must be a non-empty string" },
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
    .select("id, metadata")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  const nextMetadata = {
    ...((dispute.metadata as Record<string, unknown>) ?? {}),
    planChangeBannerDismissedAt: changedAt,
  };

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
    .eq("id", disputeId);

  if (updateErr) {
    console.error("[dismiss-plan-change-banner] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to dismiss banner" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
