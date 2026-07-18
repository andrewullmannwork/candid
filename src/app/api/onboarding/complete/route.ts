import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/onboarding/complete — stamp users.onboarding_completed_at (mig 207).
 *
 * Simplified onboarding: completion is a durable STATE written at flow finish
 * AND at skip/later (Q4: skips count as done — the user saw the ask and
 * declined; onboarding must never become a permanent nag).
 * Idempotent: an already-stamped row is left untouched, so repeat calls (double
 * click, banner dismiss after wizard finish) are harmless no-ops.
 *
 * No body, no params — the caller can only stamp themselves.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let uid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_completed_at")
    .eq("firebase_uid", uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.onboarding_completed_at) {
    return NextResponse.json({ success: true, onboardingCompletedAt: user.onboarding_completed_at });
  }

  const stamped = new Date().toISOString();
  const { error } = await supabase
    .from("users")
    .update({ onboarding_completed_at: stamped })
    .eq("id", user.id)
    .is("onboarding_completed_at", null);

  if (error) {
    console.error("[onboarding/complete] stamp failed:", error.message);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ success: true, onboardingCompletedAt: stamped });
}
