/**
 * POST /api/disputes/escalate — Record a dispute escalation
 *
 * Body: { disputeId, escalationType: "case" | "small_claims" | "external_appeal" }
 *
 * Creates post-escalation follow-up (60-day timer) and records escalation in dispute metadata.
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { recordEscalation } from "@/lib/disputes/post-escalation-followup";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
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

  const { disputeId, escalationType } = await req.json();

  if (!disputeId || !escalationType) {
    return NextResponse.json({ error: "disputeId and escalationType required" }, { status: 400 });
  }

  const validTypes = ["case", "small_claims", "external_appeal"];
  if (!validTypes.includes(escalationType)) {
    return NextResponse.json({ error: `escalationType must be one of: ${validTypes.join(", ")}` }, { status: 400 });
  }

  // Verify user owns this dispute
  const { data: dispute } = await supabase
    .from("dispute_outcomes")
    .select("id")
    .eq("id", disputeId)
    .eq("user_id", user.id)
    .single();

  if (!dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  await recordEscalation(supabase, {
    disputeId,
    userId: user.id,
    escalationType,
  });

  return NextResponse.json({ success: true });
}
