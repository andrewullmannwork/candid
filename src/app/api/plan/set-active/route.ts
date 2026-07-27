/**
 * POST /api/plan/set-active — set the caller's active insurance plan to an
 * existing canonical library plan (the "Change plan" feature, bugbash Stretch 1;
 * since S288 also the onboarding step-2 "Search for your plan" select).
 *
 * The persistence body lives in src/lib/plan/set-active-canonical.ts (S288
 * plan-flow unification — ONE shared path for every canonical search-select;
 * see that module for the LINK-ONLY / no-corroboration rationale).
 *
 * Flag-gated server-side: reachable when EITHER change_plan_v1 (the /plan
 * picker) OR onboarding_simplified_v1 (the onboarding search) is ON — the
 * route must not die if one flag flips while the other surface still ships
 * it. 404 when both are OFF.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { setActiveCanonicalPlan } from "@/lib/plan/set-active-canonical";

export async function POST(req: NextRequest) {
  // ── Flag gate (defense in depth) ──────────────────────────────────────────
  const changePlanOn = await isFeatureEnabled("change_plan_v1");
  const onboardingOn = changePlanOn ? true : await isFeatureEnabled("onboarding_simplified_v1");
  if (!changePlanOn && !onboardingOn) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
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

  // ── Body ──────────────────────────────────────────────────────────────────
  let canonicalPlanId: string | null = null;
  try {
    const body = await req.json();
    canonicalPlanId = typeof body?.canonicalPlanId === "string" ? body.canonicalPlanId : null;
  } catch {
    /* malformed body falls through to the 400 below */
  }
  if (!canonicalPlanId) {
    return NextResponse.json({ error: "canonicalPlanId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // ── Resolve internal user ─────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  if (!userRow) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const result = await setActiveCanonicalPlan(supabase, userRow.id, canonicalPlanId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // cardCleared (S288): true only on a real cross-insurer switch — the client
  // mirrors it (clears its card slot) so the UI never shows a card the server
  // just retired.
  return NextResponse.json({
    success: true,
    insurancePlanId: result.insurancePlanId,
    cardCleared: result.cardCleared,
  });
}
