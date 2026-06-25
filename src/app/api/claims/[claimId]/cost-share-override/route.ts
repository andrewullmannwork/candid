/**
 * POST /api/claims/[claimId]/cost-share-override
 *
 * Cost-Share v2 (W3) — the user-facing override-write endpoint behind the §5 assumptions
 * banner. The user corrects ONE assumption at a time (network / deductible-met / OOP-met /
 * a service's cost-share / "is this ACA?"); we persist it USER-SCOPED, and the read-time
 * engine recomputes on the client's next claim fetch (§5 "recompute live"). No canonical /
 * cross-user write (Rules #4/#10, Pattern 1 #14); the claim is the entry context, but
 * met-status + ACA + cost-share writes are PLAN-scoped (resolved from the claim).
 *
 * Auth: Firebase bearer token. Verifies the user owns the claim. Gated on
 * recovery_cost_share_v2 (OFF → 404, mirrors confirm-coverage's gate).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped, upsertOwnedChildren } from "@/lib/security/user-scoped";
import { parseCostShareOverride } from "@/lib/claims/cost-share-override";
import { PLAN_COVERED_ONCONFLICT } from "@/lib/plan/coverage-targeting";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
  if (!costShareV2) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
  }

  const { claimId } = await params;

  let rawBody: unknown = null;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseCostShareOverride(rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const ov = parsed.value;

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Ownership + plan/year context (userScoped injects user_id).
  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id, insurance_plan_id, date_of_service")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }
  const planId = (claim.insurance_plan_id as string | null) ?? null;
  const planYear = claim.date_of_service
    ? new Date(claim.date_of_service as string).getUTCFullYear()
    : null;

  // ── Network (per-claim) ──────────────────────────────────────────────────
  if (ov.field === "network") {
    const { error } = await userScoped(supabase, user.id)
      .table("claims")
      .update({ user_network_override: ov.value })
      .eq("id", claimId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  // Everything below is PLAN-scoped — needs the claim's plan + year.
  if (!planId) {
    return NextResponse.json(
      { error: "Claim has no linked plan to attach this correction to" },
      { status: 409 },
    );
  }

  // ── Deductible / OOP met-status (plan-year) ──────────────────────────────
  if (ov.field === "deductible_met" || ov.field === "oop_met") {
    if (planYear == null) {
      return NextResponse.json(
        { error: "Claim has no service date to attach a plan-year override to" },
        { status: 409 },
      );
    }
    const values: Record<string, unknown> = {
      insurance_plan_id: planId,
      plan_year: planYear,
      // source omitted → column default 'user_assumption_override' (mig 174).
    };
    if (ov.field === "deductible_met") {
      values.deductible_met = ov.met;
      values.deductible_met_as_of = ov.asOf;
    } else {
      values.oop_met = ov.met;
      values.oop_met_as_of = ov.asOf;
    }
    const { error } = await userScoped(supabase, user.id)
      .table("user_plan_cost_share_overrides")
      .upsert(values, { onConflict: "user_id,insurance_plan_id,plan_year" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  // ── Service cost-share (plan-level coverage row) ─────────────────────────
  if (ov.field === "service_cost") {
    const { data: service } = await supabase
      .from("service_catalog")
      .select("id")
      .eq("slug", ov.serviceSlug)
      .maybeSingle();
    if (!service) {
      return NextResponse.json({ error: `Unknown service: ${ov.serviceSlug}` }, { status: 400 });
    }
    // Only the fields the user supplied are written, so a copay-only correction never
    // clobbers an existing coinsurance (and vice-versa). source='manual' is the mig-031
    // CHECK value for a human-stated entry — the circularity firewall's human-vs-parser tag
    // (matching syncCopayServices); confidence per Rule #8. A finer user-correction-vs-profile
    // provenance + the cross-user value-corroboration are deferred with the corroboration rail.
    const row: Record<string, unknown> = {
      service_id: service.id,
      place_of_service: "any",
      component: "global",
      covered: true,
      source: "manual",
      confidence: 1,
    };
    if (ov.copay != null) row.in_copay = ov.copay;
    if (ov.coinsurance != null) row.in_coinsurance = ov.coinsurance;
    if (ov.deductibleApplies != null) row.in_deductible_applies = ov.deductibleApplies;

    const { upserted } = await upsertOwnedChildren(
      supabase,
      user.id,
      "plan_covered_services",
      planId,
      [row],
      { onConflict: PLAN_COVERED_ONCONFLICT },
    );
    if (upserted === 0) {
      return NextResponse.json({ error: "Coverage write failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  // ── ACA confirmation (fill-only-when-NULL on the user's own plan row) ────
  // The engine only ASKS when is_aca_compliant is NULL, so a confirmation only ever
  // FILLS an unknown — it never overwrites a parsed/known value (no conflation).
  if (ov.field === "aca") {
    const { data: plan } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .select("id, is_aca_compliant")
      .eq("id", planId)
      .maybeSingle();
    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }
    if (plan.is_aca_compliant != null) {
      // Already known — the question shouldn't have surfaced; no-op, let the client re-fetch.
      return NextResponse.json({ ok: true, field: ov.field, applied: false, reason: "aca_already_set" });
    }
    const { error } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .update({
        is_aca_compliant: ov.status === "confirmed",
        // 'user_override' is the mig-093 CHECK value for a user-corrected ACA flag;
        // aca_compliance_source is free-text provenance.
        aca_compliance_basis: "user_override",
        aca_compliance_source: "user_override",
        updated_at: new Date().toISOString(),
      })
      .eq("id", planId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  return NextResponse.json({ error: "Unhandled field" }, { status: 400 });
}
