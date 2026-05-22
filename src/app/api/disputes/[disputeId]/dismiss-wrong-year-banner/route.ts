/**
 * POST /api/disputes/[disputeId]/dismiss-wrong-year-banner — S111 smoke #5.
 *
 * Persists `dispute.metadata.wrongYearBannerDismissed = true`. After dismissal
 * the VerifStrip suppresses the wrong-year banner and surfaces a small
 * clickable badge instead (per Andrew's smoke iteration 5 ask).
 *
 * Reset to false on every new bind via bind-canonical's metadata write, so
 * users re-binding to another wrong-year plan see the banner again.
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
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
        wrongYearBannerDismissed: true,
        wrongYearBannerDismissedAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);

  if (updateErr) {
    console.error("[dismiss-wrong-year-banner] update failed:", updateErr);
    return NextResponse.json(
      { error: "Failed to persist dismissal" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
