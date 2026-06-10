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
import { userScoped } from "@/lib/security/user-scoped";

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
  const { data: profile } = await userScoped(supabase, userRow.id)
    .table("profiles")
    .select("active_insurance_plan_id")
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
    const { data: latest } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .select("id")
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
  // Session 72 (CF-31 root-cause fix): `metal_level` is a canonical_plans
  // column only — selecting it on insurance_plans triggers PostgREST 42703
  // and `maybeSingle()` returns null, masking the row's existence and
  // making the affordance never render. Read metal_level from canonical_plans
  // separately when canonical_plan_id is set.
  // Split the destructuring: `plan` reassigned in the orphan-recovery branch
  // below (must be `let`); `planErr` only read here (must be `const` per
  // eslint prefer-const). Separate bindings keep both rules happy.
  // B1 — userScoped injects `.eq("user_id")` here. planId is always user-derived
  // (from the user-scoped profile / latest-plan reads above), so this is
  // op-equivalent on owned data AND hardens the one read that previously fetched
  // by id alone (defense-in-depth on the derive-from-owned path).
  const planQuery = await userScoped(supabase, userRow.id)
    .table("insurance_plans")
    .select("canonical_plan_id, plan_name, plan_type, state, plan_year, insurer_name")
    .eq("id", planId)
    .maybeSingle();
  if (planQuery.error) {
    console.warn("[/api/plan/current] insurance_plans select error:", planQuery.error.message);
  }
  let plan = planQuery.data;

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
    const { data: latest, error: latestErr } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .select("id, canonical_plan_id, plan_name, plan_type, state, plan_year, insurer_name")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) {
      console.warn("[/api/plan/current] fallback select error:", latestErr.message);
    }
    if (latest) {
      planId = latest.id as string;
      plan = latest;
    }
  }

  if (!plan) {
    console.warn("[/api/plan/current] no active insurance_plans row for user (post-fallback)", userRow.id);
    return NextResponse.json({ plan: null });
  }

  // metal_level lives on canonical_plans only — fetch it separately when the
  // user plan is linked to a canonical (otherwise null).
  let metalLevel: string | null = null;
  if (plan.canonical_plan_id) {
    const { data: canon } = await supabase
      .from("canonical_plans")
      .select("metal_level")
      .eq("id", plan.canonical_plan_id as string)
      .maybeSingle();
    metalLevel = (canon?.metal_level as string | null) ?? null;
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
      metalLevel,
      year: (plan.plan_year as number | null) ?? null,
    },
  });
}
