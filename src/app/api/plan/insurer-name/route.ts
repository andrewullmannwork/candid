/**
 * POST /api/plan/insurer-name — S310 (F14a expanded): user correction of the
 * insurer name on one of their own insurance_plans rows.
 *
 * The plan row's `insurer_name` is the single upstream source every surface
 * reads — resolvePlanContext's recipient resolution (which may still swap in
 * the insurer directory's canonical name + verified appeals address when the
 * corrected name matches a catalog row), the rail's wait-titles
 * (insurerNameByDispute), and the claim page's pinned-plan row — so one write
 * here flows everywhere, and the compose-basis fingerprint change makes live
 * drafts rebuild with it.
 *
 * Flywheel: the correction stamps `field_provenance.insurer_name` with a
 * `user_correction` entry carrying the previous value (parser said X, user
 * said Y), which also makes the value durable — plan-merge's S310 guard never
 * lets a later parse overwrite a user-corrected field. A confirm
 * ("These look right") stamps `metadata.insurerNameConfirmedAt` without
 * touching the value or its provenance.
 *
 * Body: { planId, insurerName? , confirm? } — insurerName for a fix, confirm
 * for a vouch; at least one required.
 * Auth: Firebase bearer token; userScoped enforces plan ownership.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";

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

  const body = (await req.json().catch(() => null)) as {
    planId?: unknown;
    insurerName?: unknown;
    confirm?: unknown;
  } | null;
  if (!body || typeof body.planId !== "string" || !body.planId) {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }

  const isConfirmOnly = body.confirm === true && body.insurerName == null;
  const nextName =
    typeof body.insurerName === "string" ? body.insurerName.trim().slice(0, 200) : "";
  if (!isConfirmOnly && !nextName) {
    return NextResponse.json(
      { error: "Provide insurerName, or confirm: true to vouch for the current one." },
      { status: 400 },
    );
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

  const { data: plan } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .select("id, insurer_name, metadata, field_provenance")
    .eq("id", body.planId)
    .single();
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  const metadata = (plan.metadata as Record<string, unknown> | null) ?? {};

  if (isConfirmOnly) {
    const { error } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .update({
        metadata: { ...metadata, insurerNameConfirmedAt: nowIso },
        updated_at: nowIso,
      })
      .eq("id", plan.id);
    if (error) {
      console.error("[plan/insurer-name] confirm failed:", error);
      return NextResponse.json({ error: "Failed to save" }, { status: 500 });
    }
    return NextResponse.json({ success: true, insurerName: plan.insurer_name ?? null });
  }

  // A fix — write the name, stamp user_correction provenance with the previous
  // value preserved (the alias-pair flywheel signal), and vouch the result.
  const provenance = (plan.field_provenance as Record<string, unknown> | null) ?? {};
  const { error } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .update({
      insurer_name: nextName,
      field_provenance: {
        ...provenance,
        insurer_name: {
          source: "user_correction",
          corrected_at: nowIso,
          previous: plan.insurer_name ?? null,
        },
      },
      metadata: { ...metadata, insurerNameConfirmedAt: nowIso },
      updated_at: nowIso,
    })
    .eq("id", plan.id);
  if (error) {
    console.error("[plan/insurer-name] update failed:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ success: true, insurerName: nextName });
}
