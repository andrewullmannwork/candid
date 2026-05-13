/**
 * GET /api/disputes/outcome — Fetch the authenticated user's dispute history.
 * POST /api/disputes/outcome — Update a dispute's outcome (status, amount recovered).
 *
 * S74 hardening: both methods now require a Firebase bearer token and verify the
 * caller owns the target dispute. Prior to S74 the POST handler accepted any
 * disputeId from any caller, and GET took `userId` as a URL parameter — both
 * routes leaked across users. The "mark sent" UI added in S74 reuses POST with
 * `status='filed'`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { updateDisputeOutcome, getUserDisputes } from "@/lib/disputes/persist";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

async function resolveUserId(supabase: ReturnType<typeof createServerClient>, firebaseUid: string): Promise<string | null> {
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const userId = await resolveUserId(supabase, decoded.uid);
  if (!userId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const result = await getUserDisputes(supabase, userId);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const decoded = await getAuthUser(req);
    if (!decoded) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { disputeId, status, amountRecovered, resolutionDate, strategyNotes } = await req.json();

    if (!disputeId || !status) {
      return NextResponse.json(
        { error: "disputeId and status are required" },
        { status: 400 }
      );
    }

    // S74: the new lifecycle vocabulary (Session 35+) coexists with the legacy
    // statuses. The mark-sent button on the disputes toolbar POSTs with
    // status='filed' to transition the dispute from drafted → filed.
    const validStatuses = [
      "filed",
      "in_progress",
      "won",
      "lost",
      "settled",
      "withdrawn",
      "won_on_escalation",
      "settled_on_escalation",
      "dispute_letter_drafted",
      "court_documentation_drafted",
    ];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const userId = await resolveUserId(supabase, decoded.uid);
    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Ownership check — verify the dispute belongs to the authenticated user
    // BEFORE running the update. Without this guard any authenticated user
    // could mutate any dispute by knowing its UUID.
    const { data: existing } = await supabase
      .from("dispute_outcomes")
      .select("id, user_id, status, filed_date")
      .eq("id", disputeId)
      .single();

    if (!existing || existing.user_id !== userId) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    const success = await updateDisputeOutcome(supabase, disputeId, {
      status,
      amountRecovered: amountRecovered ?? undefined,
      resolutionDate: resolutionDate ?? undefined,
      strategyNotes: strategyNotes ?? undefined,
    });

    if (!success) {
      return NextResponse.json({ error: "Failed to update dispute" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Dispute outcome update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
