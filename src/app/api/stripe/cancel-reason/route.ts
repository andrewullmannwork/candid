/**
 * POST /api/stripe/cancel-reason — Capture the reason behind a subscription
 * cancellation as a flywheel signal for retention learnings.
 *
 * Body: { reason: string, note?: string }
 *   reason — one of the 5 design-preset reasons or "Other"
 *   note   — optional free-text follow-up
 *
 * Writes a row to `subscription_events` (mig 114) with event_type
 * 'cancel_reason_captured' and metadata={reason, note}. Decoupled from the
 * actual Stripe cancellation (POST /api/stripe/cancel-subscription) so that
 * the cancellation can still succeed even if reason capture fails — the
 * cancel side is user-facing and load-bearing; the reason side is telemetry.
 *
 * Auth: Firebase bearer token. Service-role write (no client-side INSERT
 * policy on subscription_events).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

const MAX_REASON_LEN = 200;
const MAX_NOTE_LEN = 2000;

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

  const body = await req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LEN) : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE_LEN) : "";

  if (!reason) {
    return NextResponse.json({ error: "reason required" }, { status: 400 });
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

  const metadata: { reason: string; note?: string } = { reason };
  if (note) metadata.note = note;

  const { error } = await supabase.from("subscription_events").insert({
    user_id: user.id,
    event_type: "cancel_reason_captured",
    metadata,
  });

  if (error) {
    console.error("[cancel-reason] insert failed:", error);
    return NextResponse.json({ error: "Failed to log reason" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
