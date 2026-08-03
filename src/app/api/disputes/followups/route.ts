/**
 * GET  /api/disputes/followups — the banner's per-CLAIM waiting rows
 * POST /api/disputes/followups — Handle a follow-up action (won/settled/lost/still_waiting/dismiss)
 *
 * S300 phase 2b (agenda §0.9c) — the GET returns CLAIM GROUPS, not follow-up
 * rows: the banner is a standing per-claim pointer ("«provider» — 2 letters
 * waiting"), so grouping happens here rather than in the component. A
 * client-side grouping would be a second place deriving case state.
 * `followups` is still returned alongside for the dismiss plumbing.
 *
 * The POST keeps its full action set even though the banner now only sends
 * `dismiss`: the outcome actions remain the API contract, and phase 3 retires
 * them with the UnifiedTodo work rather than mid-flight here.
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import {
  resolveClaimFollowups,
  getActiveFollowups,
  groupFollowupsByClaim,
  handleFollowupAction,
} from "@/lib/disputes/followups";

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
  const today = new Date().toISOString().split("T")[0];
  return NextResponse.json({
    followups,
    claims: groupFollowupsByClaim(followups, today),
  });
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
  const { followupId, followupIds, action, amountRecovered } = body;

  const validActions = ["won", "settled", "lost", "still_waiting", "dismiss"];
  if (!action || !validActions.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${validActions.join(", ")}` },
      { status: 400 }
    );
  }

  // S300 phase 2b — CLAIM-SCOPED dismiss. The banner row covers every letter
  // waiting on one bill, so its ✕ dismisses all of that claim's due nudges in
  // one press. Deliberately NOT a new dismissal path: it loops the existing
  // per-followup handler, which already owns ownership scoping and the
  // status transition. Only `dismiss` may fan out — an outcome is per-letter
  // by construction and belongs in the rail's modal.
  if (Array.isArray(followupIds)) {
    if (action !== "dismiss" && action !== "acknowledge") {
      return NextResponse.json(
        { error: "followupIds is only valid with action=dismiss|acknowledge" },
        { status: 400 },
      );
    }
    const ids = followupIds.filter((id: unknown): id is string => typeof id === "string");
    if (ids.length === 0) {
      return NextResponse.json({ error: "followupIds must be non-empty" }, { status: 400 });
    }
    // S300 — two gestures. `dismiss` (the ✕) ends the check-in chain;
    // `acknowledge` ("Open your claim") clears the row but advances it one
    // rung, so only a logged outcome truly retires the ask. Both re-assert
    // deadline-anchored nudges at deadline−2 and −1.
    const { dismissed, reasserts, rescheduled } = await resolveClaimFollowups(supabase, {
      userId: user.id,
      followupIds: ids,
      gesture: action,
    });
    return NextResponse.json({ success: dismissed > 0, dismissed, reasserts, rescheduled });
  }

  if (!followupId) {
    return NextResponse.json({ error: "followupId or followupIds required" }, { status: 400 });
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
