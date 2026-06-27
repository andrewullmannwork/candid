/**
 * POST /api/plan/set-active — set the caller's active insurance plan to an
 * existing canonical library plan (the "Change plan" feature, bugbash Stretch 1).
 *
 * LINK-ONLY, USER-SCOPED. This is the search path of the /plan "Change plan"
 * picker: the user picked a canonical_plans row, and we make it their active
 * plan so /api/plan/analyze renders that plan's benefits (Priority 0 →
 * canonical_plan_services via insurance_plans.canonical_plan_id).
 *
 * Deliberately NOT confirmCanonicalMatch(): that helper also increments the
 * canonical source_count and merges services INTO the canonical row — i.e. it
 * treats the action as a corroborating data source. A user picking a plan from
 * a dropdown is NOT corroboration; firing those would inflate flywheel
 * confidence on a UI click (Pattern 1 #14). So we only WRITE the user's own
 * rows: insurance_plans (link + identity) + profiles (repoint + clear stale
 * cost/match fields). No canonical-table writes.
 *
 * Mirrors the /api/profile force_plan_switch invariants (single active plan;
 * no stale denormalized profile fields) but for a canonical id instead of a
 * card-scan / manual form payload.
 *
 * Flag-gated (change_plan_v1) server-side: 404 when OFF so the endpoint isn't
 * reachable before launch.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";

export async function POST(req: NextRequest) {
  // ── Flag gate (defense in depth) ──────────────────────────────────────────
  if (!(await isFeatureEnabled("change_plan_v1"))) {
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

  // ── Read canonical identity (server-trusted; never trust client-sent fields).
  // insurer name lives on insurer_catalog (canonical_plans.insurer_id FK). Two
  // plain reads instead of a PostgREST embed to avoid 42703 typing ambiguity. ─
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("id, plan_name, plan_type, state, plan_year, insurer_id")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (!canonical) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  let insurerName: string | null = null;
  if (canonical.insurer_id) {
    const { data: insurerRow } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", canonical.insurer_id)
      .maybeSingle();
    insurerName = (insurerRow?.name as string | null) ?? null;
  }

  // Identity written to both insurance_plans + profiles. source='catalog_match'
  // (NOT a user-upload source) so the /plan card shows honest canonical-grade
  // provenance — never a false "User Verified" badge.
  const identity = {
    canonical_plan_id: canonicalPlanId,
    insurer_name: insurerName,
    plan_name: canonical.plan_name,
    plan_type: canonical.plan_type,
    state: canonical.state,
    plan_year: canonical.plan_year,
    source: "catalog_match" as const,
  };

  // ── Dedup: reuse an existing owned row already linked to this canonical plan
  // (re-selecting the same plan should reactivate, not duplicate). ────────────
  const { data: existing } = await userScoped(supabase, userRow.id)
    .table("insurance_plans")
    .select("id")
    .eq("canonical_plan_id", canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Single-active-plan guard: deactivate ALL the user's active rows first
  // (mirrors /api/profile force_plan_switch + extraction-dedup).
  const { error: deactivateErr } = await userScoped(supabase, userRow.id)
    .table("insurance_plans")
    .update({ is_active: false })
    .eq("is_active", true);
  if (deactivateErr) {
    console.error("[/api/plan/set-active] deactivate failed:", deactivateErr.message);
    return NextResponse.json({ error: "Could not set plan" }, { status: 500 });
  }

  let activePlanId: string;
  if (existing?.id) {
    const { error: reactivateErr } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .update({ ...identity, is_active: true })
      .eq("id", existing.id);
    if (reactivateErr) {
      console.error("[/api/plan/set-active] reactivate failed:", reactivateErr.message);
      return NextResponse.json({ error: "Could not set plan" }, { status: 500 });
    }
    activePlanId = existing.id as string;
  } else {
    const { data: inserted, error: insertErr } = await userScoped(supabase, userRow.id)
      .table("insurance_plans")
      .insert({ ...identity, user_id: userRow.id, is_active: true })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      console.error("[/api/plan/set-active] insert failed:", insertErr?.message);
      return NextResponse.json({ error: "Could not set plan" }, { status: 500 });
    }
    activePlanId = inserted.id as string;
  }

  // ── Repoint profile + set identity + CLEAR stale cost/match fields ─────────
  // analyze resolves the active plan's cost-share from canonical_plan_services
  // (via canonical_plan_id), so the profile's old per-plan cost fields must be
  // cleared. matched_plan_id is cleared so the prior plan_catalog match can't
  // shadow the new canonical plan in analyze Priority 1.
  const { error: profileErr } = await userScoped(supabase, userRow.id)
    .table("profiles")
    .update({
      active_insurance_plan_id: activePlanId,
      insurer: insurerName,
      plan_name: canonical.plan_name,
      plan_type: canonical.plan_type,
      state: canonical.state,
      plan_source: "catalog_match",
      matched_plan_id: null,
      group_number: null,
      member_id: null,
      deductible_individual: null,
      oop_max_individual: null,
      copay_primary: null,
      copay_specialist: null,
      copay_er: null,
      coinsurance_pct: null,
    });
  if (profileErr) {
    console.error("[/api/plan/set-active] profile repoint failed:", profileErr.message);
    return NextResponse.json({ error: "Could not set plan" }, { status: 500 });
  }

  return NextResponse.json({ success: true, insurancePlanId: activePlanId });
}
