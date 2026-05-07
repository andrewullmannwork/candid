/**
 * POST /api/plan/premium — set the monthly premium on a user's insurance_plan.
 *
 * SBCs don't include premium (it's tier + age + region dependent), so we ask
 * the user to fill it in after a successful upload + on the compare results
 * surface where premium drives "lowest monthly cost" + total-cost projections.
 *
 * Pattern 1 #14: writes user-scoped only (insurance_plans.premium_monthly).
 * Never writes to canonical_plans — premium is plan-tier + region specific
 * and not a canonical-shared attribute.
 *
 * Body: { planId: string; premiumMonthly: number }
 * Returns: { ok: true, premiumMonthly } on success; 4xx on validation/auth.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

interface Body {
  planId?: unknown;
  premiumMonthly?: unknown;
}

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let firebaseUid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    firebaseUid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse + validate body ───────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.planId !== "string" || body.planId.length < 8) {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }
  if (
    typeof body.premiumMonthly !== "number" ||
    !Number.isFinite(body.premiumMonthly) ||
    body.premiumMonthly < 0 ||
    body.premiumMonthly > 100000
  ) {
    return NextResponse.json(
      { error: "premiumMonthly must be a non-negative number under $100k" },
      { status: 400 },
    );
  }
  const planId = body.planId;
  const premiumMonthly = body.premiumMonthly;

  const supabase = createServerClient();

  // ── Resolve internal user (for ownership check) ─────────────────────────
  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  if (!userRow) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // ── Verify the plan belongs to the caller (defense in depth on top of RLS) ─
  const { data: plan } = await supabase
    .from("insurance_plans")
    .select("id, user_id")
    .eq("id", planId)
    .single();
  if (!plan || plan.user_id !== userRow.id) {
    return NextResponse.json(
      { error: "Plan not found or not owned by you" },
      { status: 404 },
    );
  }

  // ── Update ──────────────────────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from("insurance_plans")
    .update({ premium_monthly: premiumMonthly })
    .eq("id", planId);
  if (updateErr) {
    return NextResponse.json(
      { error: "Failed to save premium. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, premiumMonthly });
}
