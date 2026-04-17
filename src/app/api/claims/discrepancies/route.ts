/**
 * GET  /api/claims/discrepancies — Fetch user's discrepancies (filterable by status, tier)
 * PATCH /api/claims/discrepancies — Update discrepancy status (ignore/verifying/disputed)
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Parse filters
  const status = req.nextUrl.searchParams.get("status"); // flagged, ignored, etc.
  const tier = req.nextUrl.searchParams.get("tier"); // 1, 2, 3
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50", 10), 100);

  let query = supabase
    .from("claim_discrepancies")
    .select("*, claim_line_items!inner(description, billing_code, billing_code_type, billed_amount, patient_owes)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq("status", status);
  } else {
    // Default: show active discrepancies (not ignored/resolved)
    query = query.in("status", ["flagged", "verifying", "disputed"]);
  }

  if (tier) {
    query = query.eq("tier", parseInt(tier, 10));
  }

  const { data: discrepancies, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Compute summary
  const { data: allActive } = await supabase
    .from("claim_discrepancies")
    .select("id, tier, field, expected_value, actual_value")
    .eq("user_id", user.id)
    .in("status", ["flagged", "verifying", "disputed"]);

  const summary = {
    total: allActive?.length || 0,
    tier2: allActive?.filter((d) => d.tier === 2).length || 0,
    tier3: allActive?.filter((d) => d.tier === 3).length || 0,
    systemic: discrepancies?.filter((d) => d.is_systemic).length || 0,
  };

  return NextResponse.json({ discrepancies: discrepancies || [], summary });
}

export async function PATCH(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const { discrepancyId, status } = await req.json();

  if (!discrepancyId || !status) {
    return NextResponse.json({ error: "discrepancyId and status required" }, { status: 400 });
  }

  const validStatuses = ["flagged", "ignored", "verifying", "disputed", "resolved"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
  }

  // Verify ownership
  const { data: existing } = await supabase
    .from("claim_discrepancies")
    .select("id")
    .eq("id", discrepancyId)
    .eq("user_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Discrepancy not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("claim_discrepancies")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", discrepancyId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
