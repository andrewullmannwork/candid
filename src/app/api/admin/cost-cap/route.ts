/**
 * GET /api/admin/cost-cap
 *
 * S74.6 §H.4 A4 — list users currently paused on the $10/user/day Haiku
 * spend cap (haiku_spend_tracking.paused_at IS NOT NULL). Each row joins to
 * the users table for email + firebase_uid so the admin can identify who
 * needs unfreezing.
 *
 * POST /api/admin/cost-cap
 *
 * Two actions:
 *   { action: "unfreeze", userId: <uuid>, dayIso?: <YYYY-MM-DD> }
 *     Clears paused_at + pause_reason on the user's row for the given day
 *     (defaults to today). Optionally resets total_cost_usd to 0 via the
 *     `resetTotal` flag (so the user can continue charging the cap from
 *     scratch). Logs admin reason.
 *   { action: "override", userId: <uuid>, overrideCapUsd: <number> }
 *     Sets haiku_spend_tracking.override_cap_usd for today's row (creates one
 *     if needed). null overrideCapUsd clears the override (reverts to global
 *     default).
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { logAdminAction } from "@/lib/admin/audit-log";

async function verifyAdmin(req: NextRequest): Promise<
  | { authorized: false }
  | { authorized: true; adminUserId: string; adminEmail: string }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { authorized: false };

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id, email, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!data?.is_admin) return { authorized: false };
    return {
      authorized: true,
      adminUserId: data.id as string,
      adminEmail: (data.email as string) ?? "",
    };
  } catch {
    return { authorized: false };
  }
}

export async function GET(req: NextRequest) {
  const auth = await verifyAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Paused users for today + last 7 days (so admins can audit recent
  // cap-trip history, not just current state).
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data: pausedRows, error } = await supabase
    .from("haiku_spend_tracking")
    .select(
      "user_id, day_iso, total_cost_usd, paused_at, pause_reason, override_cap_usd, updated_at",
    )
    .not("paused_at", "is", null)
    .gte("day_iso", sevenDaysAgo)
    .order("paused_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Hydrate email per user — small N, batch IN.
  const userIds = Array.from(new Set((pausedRows ?? []).map((r) => r.user_id)));
  const { data: userRows } = await supabase
    .from("users")
    .select("id, email, firebase_uid")
    .in("id", userIds);
  const userMap = new Map(
    (userRows ?? []).map((u) => [u.id as string, u]),
  );

  return NextResponse.json({
    paused: (pausedRows ?? []).map((r) => {
      const u = userMap.get(r.user_id as string);
      return {
        userId: r.user_id,
        email: (u?.email as string) ?? null,
        firebaseUid: (u?.firebase_uid as string) ?? null,
        dayIso: r.day_iso,
        totalCostUsd: Number(r.total_cost_usd ?? 0),
        pausedAt: r.paused_at,
        pauseReason: r.pause_reason,
        overrideCapUsd:
          r.override_cap_usd != null ? Number(r.override_cap_usd) : null,
        updatedAt: r.updated_at,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    action?: unknown;
    userId?: unknown;
    dayIso?: unknown;
    overrideCapUsd?: unknown;
    resetTotal?: unknown;
    reason?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  const dayIso =
    typeof body.dayIso === "string"
      ? body.dayIso
      : new Date().toISOString().slice(0, 10);
  const reason =
    typeof body.reason === "string" ? body.reason.slice(0, 500) : "";

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  if (action === "unfreeze") {
    const resetTotal = body.resetTotal === true;
    const update: Record<string, unknown> = {
      paused_at: null,
      pause_reason: null,
      updated_at: new Date().toISOString(),
    };
    if (resetTotal) update.total_cost_usd = 0;
    const { error: updateErr } = await supabase
      .from("haiku_spend_tracking")
      .update(update)
      .eq("user_id", userId)
      .eq("day_iso", dayIso);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
    await logAdminAction({
      adminUserId: auth.adminUserId,
      adminEmail: auth.adminEmail,
      action: "cost_cap_unfrozen",
      targetTable: "haiku_spend_tracking",
      details: `Unfroze user ${userId} for ${dayIso}${resetTotal ? " (reset total to 0)" : ""}${reason ? `; reason="${reason}"` : ""}`,
    });
    return NextResponse.json({ ok: true, userId, dayIso, resetTotal });
  }

  if (action === "override") {
    const overrideCap =
      body.overrideCapUsd == null
        ? null
        : Number(body.overrideCapUsd);
    if (overrideCap != null && (!Number.isFinite(overrideCap) || overrideCap < 0)) {
      return NextResponse.json(
        { error: "overrideCapUsd must be a non-negative number or null" },
        { status: 400 },
      );
    }
    // UPSERT — A4 may set an override even before the user has any spend rows today.
    const { error: upsertErr } = await supabase
      .from("haiku_spend_tracking")
      .upsert(
        {
          user_id: userId,
          day_iso: dayIso,
          override_cap_usd: overrideCap,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,day_iso" },
      );
    if (upsertErr) {
      return NextResponse.json({ error: upsertErr.message }, { status: 500 });
    }
    await logAdminAction({
      adminUserId: auth.adminUserId,
      adminEmail: auth.adminEmail,
      action: "cost_cap_override_set",
      targetTable: "haiku_spend_tracking",
      details: `Set override_cap_usd=${overrideCap == null ? "null" : `$${overrideCap.toFixed(2)}`} for user ${userId} on ${dayIso}${reason ? `; reason="${reason}"` : ""}`,
    });
    return NextResponse.json({ ok: true, userId, dayIso, overrideCapUsd: overrideCap });
  }

  return NextResponse.json(
    { error: `Unknown action: ${action}; expected 'unfreeze' or 'override'` },
    { status: 400 },
  );
}
