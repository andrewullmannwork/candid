/**
 * POST /api/plan/field — set a single plan-summary numeric field on a user's
 * insurance_plans row. Generalization of the original /api/plan/premium route
 * so the /compare inline-edit pattern can support deductibles + OOP max too
 * (SBCs sometimes parse those incompletely; user fills in the gap).
 *
 * Pattern 1 #14: writes user-scoped only. Never writes to canonical_plans.
 *
 * Body: { planId: string; field: AllowedField; value: number }
 *   AllowedField is whitelisted below — ANY other value is rejected to prevent
 *   arbitrary column writes via this surface.
 *
 * Returns: { ok: true, field, value } on success; 4xx on validation/auth.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

const ALLOWED_FIELDS = [
  "premium_monthly",
  "in_deductible_individual",
  "out_deductible_individual",
  "in_oop_max_individual",
  "out_oop_max_individual",
] as const;
type AllowedField = (typeof ALLOWED_FIELDS)[number];

function isAllowedField(value: unknown): value is AllowedField {
  return typeof value === "string" && (ALLOWED_FIELDS as readonly string[]).includes(value);
}

interface Body {
  planId?: unknown;
  field?: unknown;
  value?: unknown;
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
  if (!isAllowedField(body.field)) {
    return NextResponse.json(
      { error: `field must be one of: ${ALLOWED_FIELDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (
    typeof body.value !== "number" ||
    !Number.isFinite(body.value) ||
    body.value < 0 ||
    body.value > 1_000_000
  ) {
    return NextResponse.json(
      { error: "value must be a non-negative number under $1M" },
      { status: 400 },
    );
  }
  const planId = body.planId;
  const field: AllowedField = body.field;
  const value = body.value;

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
    .select("id, user_id, field_provenance")
    .eq("id", planId)
    .single();
  if (!plan || plan.user_id !== userRow.id) {
    return NextResponse.json(
      { error: "Plan not found or not owned by you" },
      { status: 404 },
    );
  }

  // Session 72 v2: write field_provenance with source="user_correction" so
  // the consumer-read filter can render a "User Verified" badge for fields
  // the caller explicitly typed via inline-edit. Merge into existing provenance
  // (preserve other fields' entries; overwrite this field's entry).
  const existingProv =
    (plan.field_provenance as Record<string, Record<string, unknown>> | null) ?? {};
  const mergedProv: Record<string, Record<string, unknown>> = {
    ...existingProv,
    [field]: {
      source: "user_correction",
      confidence: 1.0, // user-typed → highest confidence
      last_corroborated_at: new Date().toISOString(),
    },
  };

  // ── Update ──────────────────────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from("insurance_plans")
    .update({ [field]: value, field_provenance: mergedProv })
    .eq("id", planId);
  if (updateErr) {
    return NextResponse.json(
      { error: "Failed to save. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, field, value });
}
