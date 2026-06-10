/**
 * POST /api/disputes/[disputeId]/clear-coverage-diff — S111 smoke #5.
 *
 * Clears `dispute.metadata.preBindCoverageSnapshot` so the GET handler stops
 * surfacing the post-bind coverage diff. Called when the user clicks
 * "Proceed with dispute" on the CoverageDiffPanel (acknowledges the changes
 * + carries on) or dismisses the panel another way.
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
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

  const nextMetadata = { ...((dispute.metadata as Record<string, unknown>) ?? {}) };
  delete nextMetadata.preBindCoverageSnapshot;
  nextMetadata.coverageDiffAcknowledgedAt = new Date().toISOString();

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[clear-coverage-diff] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to clear coverage diff" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
