/**
 * GET  /api/disputes/followups — Fetch active follow-ups for the authenticated user
 * POST /api/disputes/followups — Handle a follow-up action (won/settled/lost/still_waiting/dismiss)
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { getActiveFollowups, handleFollowupAction } from "@/lib/disputes/followups";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const followups = await getActiveFollowups(supabase, user.id);
  return NextResponse.json({ followups });
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { followupId, action, amountRecovered } = body;

  if (!followupId || !action) {
    return NextResponse.json({ error: "followupId and action required" }, { status: 400 });
  }

  const validActions = ["won", "settled", "lost", "still_waiting", "dismiss"];
  if (!validActions.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 }
    );
  }

  const result = await handleFollowupAction(supabase, {
    followupId,
    userId: user.id,
    action,
    amountRecovered: amountRecovered ?? undefined,
  });

  if (!result.success) {
    return NextResponse.json({ error: "Follow-up not found" }, { status: 404 });
  }

  // If marked as "lost", send denial escalation email (non-blocking)
  if (action === "lost") {
    try {
      // Get dispute details for the email
      const { data: followup } = await userScoped(supabase, user.id)
        .table("dispute_followups")
        .select("dispute_id")
        .eq("id", followupId)
        .single();

      if (followup) {
        const { data: dispute } = await userScoped(supabase, user.id)
          .table("dispute_outcomes")
          .select("dispute_type, amount_disputed")
          .eq("id", followup.dispute_id)
          .single();

        if (dispute) {
          const { notifyDenialEscalation } = await import("@/lib/disputes/followup-notifications");
          notifyDenialEscalation({
            userEmail: user.email,
            disputeType: dispute.dispute_type,
            amountDisputed: dispute.amount_disputed,
          }).catch(() => {});
        }
      }
    } catch {
      // Non-blocking
    }
  }

  return NextResponse.json({ success: true, nextFollowupCreated: result.nextFollowupCreated });
}
