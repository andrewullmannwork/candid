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
import { buildDirectEntryProvenance } from "@/lib/parser/provenance-builders";
import { SOURCE_DEFAULT_CONFIDENCE } from "@/lib/parser/field-categories";

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
    .select("id, insurance_plan_id, date_of_service, metadata")
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

  // ── Amount the patient actually paid (per-claim; plan-independent) ────────
  // Durable override in claims.metadata.userPatientPaid (Rule #9 JSONB-first) — re-parse-
  // proof + updatable by overwrite; null clears. Read at letter-generation time by
  // loadDisputeGroundBasis, which overlays it onto the claim's effective totals so the
  // refund math + letter reflect it. Spread-merge preserves sibling metadata (e.g. provider).
  if (ov.field === "patient_paid") {
    const baseMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = { ...baseMeta };
    if (ov.amount === null) {
      delete nextMeta.userPatientPaid;
      delete nextMeta.userPatientPaidUpdatedAt;
    } else {
      nextMeta.userPatientPaid = ov.amount;
      nextMeta.userPatientPaidUpdatedAt = new Date().toISOString();
    }
    const { error } = await userScoped(supabase, user.id)
      .table("claims")
      .update({ metadata: nextMeta })
      .eq("id", claimId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  // ── "I checked the service list" (per-claim; plan-independent) ───────────
  // S291 (Andrew) — the guided rail's "Verify the services" step was local
  // useState, so clicking Confirmed looked like it registered and was gone on
  // the next load. Same failure as the assumptions "Done" button: an action
  // that reads as recorded but writes nothing.
  //
  // Durable in claims.metadata (Rule #9 JSONB-first) rather than a new column —
  // one boolean doesn't earn a migration, and the spread-merge keeps sibling
  // metadata (auditSummary, userPatientPaid, provider) intact. Stored as a
  // TIMESTAMP, not a flag: "confirmed at 14:02" survives a later re-parse with
  // its meaning intact, and lets a future re-audit decide whether the
  // confirmation predates new findings.
  if (ov.field === "services_confirmed") {
    const baseMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = { ...baseMeta };
    if (ov.confirmed) {
      nextMeta.servicesConfirmedAt = new Date().toISOString();
    } else {
      delete nextMeta.servicesConfirmedAt;
    }
    const { error } = await userScoped(supabase, user.id)
      .table("claims")
      .update({ metadata: nextMeta })
      .eq("id", claimId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, field: ov.field, applied: true });
  }

  // ── Re-pin the claim to a different plan the user owns ──────────────────
  // S291 (Andrew) — "the bill should be calculated against the insurance plan
  // during that period of time… the user should be able to change it."
  //
  // Ownership is verified on the TARGET plan, not just the claim: without that
  // check a caller could pin their own claim to someone else's plan id and read
  // its coverage back through the audit. userScoped makes the lookup return
  // nothing for a foreign id, so it fails closed with a 404.
  if (ov.field === "claim_plan") {
    const { data: target } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .select("id")
      .eq("id", ov.insurancePlanId)
      .maybeSingle();
    if (!target) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }
    const { error } = await userScoped(supabase, user.id)
      .table("claims")
      .update({ insurance_plan_id: ov.insurancePlanId })
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
      confidence: SOURCE_DEFAULT_CONFIDENCE.user_correction,
    };
    if (ov.copay != null) row.in_copay = ov.copay;
    if (ov.coinsurance != null) row.in_coinsurance = ov.coinsurance;
    if (ov.deductibleApplies != null) row.in_deductible_applies = ov.deductibleApplies;

    // S291 — stamp that a HUMAN asserted this. Previously this row was written
    // with `source: 'manual', confidence: 1` and no provenance, identical to the
    // card-scan write in syncCopayServices — and because this upserts on the
    // same conflict key, a user's answer OVERWROTE the fabricated row in place
    // with no trace of which it was. That ambiguity is what made mig 217
    // unsafe. `user_correction` carries 0.9 in the calibrated table, above
    // card_corroboration's 0.6, so a typed value outranks a scanned one.
    row.field_provenance = buildDirectEntryProvenance(
      "plan_covered_services",
      [
        ["in_copay", ov.copay],
        ["in_coinsurance", ov.coinsurance],
        ["in_deductible_applies", ov.deductibleApplies],
      ],
      "user_correction",
    );

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
