/**
 * GET /api/plan/current — return the caller's active insurance plan summary.
 *
 * Server-side route exists because the equivalent browser-Supabase-client query
 * 406'd under RLS for the /compare "Use my current plan" affordance: the user
 * is authenticated via Firebase (not Supabase auth), so RLS policies that gate
 * on auth.uid() reject the read.
 *
 * Returns:
 *   { plan: { canonicalPlanId, planName, insurerName, planType, state, metalLevel, year } }
 *   or { plan: null } when the user has no active plan with a canonical link.
 *
 * The plan must have `canonical_plan_id` populated — the /compare flow uses
 * the canonical id to resolve via /api/plan/compare's resolveCanonicalPlan.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
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

  const supabase = createServerClient();

  // ── Resolve internal user ────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  if (!userRow) {
    console.warn("[/api/plan/current] no users row for firebase_uid", firebaseUid);
    return NextResponse.json({ plan: null });
  }

  // ── Resolve plan ID — prefer profile.active_insurance_plan_id, fall back
  // to the user's latest active insurance_plans row if profile doesn't have
  // it set (stale-profile recovery). ──────────────────────────────────────
  const { data: profile } = await supabase
    .from("profiles")
    .select("active_insurance_plan_id")
    .eq("user_id", userRow.id)
    .single();

  let planId: string | null = (profile?.active_insurance_plan_id as string | null) ?? null;
  if (!planId) {
    console.warn(
      "[/api/plan/current] profile has no active_insurance_plan_id; falling back to latest plan for user",
      userRow.id,
    );
    // Latest plan period — active OR inactive — to handle users whose plans
    // were deactivated by earlier (buggy) upload paths but still represent
    // "their plan" intent. Better to show the most recent plan than nothing.
    const { data: latest } = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("user_id", userRow.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    planId = (latest?.id as string | null) ?? null;
  }
  if (!planId) {
    console.warn("[/api/plan/current] no insurance_plans rows for user at all", userRow.id);
    return NextResponse.json({ plan: null });
  }

  // ── Plan summary ─────────────────────────────────────────────────────────
  // Return whatever the user has as their active plan, even if canonical_plan_id
  // is null (some user-uploaded plans don't end up linked to a canonical row —
  // their data still resolves via resolveUserPlan). Both IDs returned so the
  // /compare flow can pick the richer reference (canonical when available;
  // user_plan otherwise).
  let { data: plan } = await supabase
    .from("insurance_plans")
    .select("canonical_plan_id, plan_name, plan_type, state, plan_year, metal_level, insurer_name")
    .eq("id", planId)
    .maybeSingle();

  // Orphaned-pointer recovery: profile.active_insurance_plan_id points to a
  // row that doesn't exist (deleted plan, stale FK, etc.). Fall back to the
  // user's latest plan (active OR inactive) so the affordance still surfaces
  // when their plan got deactivated by an earlier buggy upload path.
  if (!plan) {
    console.warn(
      "[/api/plan/current] orphaned active_insurance_plan_id (no row at",
      planId,
      ") — falling back to latest plan for user",
      userRow.id,
    );
    const { data: latest } = await supabase
      .from("insurance_plans")
      .select("id, canonical_plan_id, plan_name, plan_type, state, plan_year, metal_level, insurer_name")
      .eq("user_id", userRow.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      planId = latest.id as string;
      plan = latest;
    }
  }

  if (!plan) {
    console.warn("[/api/plan/current] no active insurance_plans row for user (post-fallback)", userRow.id);
    return NextResponse.json({ plan: null });
  }

  console.log("[/api/plan/current] returning plan", {
    insurancePlanId: planId,
    hasCanonical: !!plan.canonical_plan_id,
    planName: plan.plan_name,
  });

  return NextResponse.json({
    plan: {
      insurancePlanId: planId,
      canonicalPlanId: (plan.canonical_plan_id as string | null) ?? null,
      planName: (plan.plan_name as string) || "Your plan",
      insurerName: (plan.insurer_name as string) || "",
      planType: (plan.plan_type as string | null) ?? null,
      state: (plan.state as string | null) ?? null,
      metalLevel: (plan.metal_level as string | null) ?? null,
      year: (plan.plan_year as number | null) ?? null,
    },
  });
}
