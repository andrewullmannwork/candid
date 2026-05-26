/**
 * Admin GET for /admin/cost-per-canonical (Cost-F, S129).
 *
 *   GET /api/admin/cost-per-canonical?window_days=7
 *
 * Returns per-canonical cost rollups (7d total, 30d median, parser/source
 * breakdowns) + alert history from cost_alert_log.
 *
 * Auth: admin-only via Firebase ID token → users.is_admin. Mirrors the gate
 * used by /api/admin/auto-reparse-stats + /api/admin/canonical-match-decisions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { aggregatePerCanonicalCost } from "@/lib/cost/cost-per-canonical";

async function requireAdmin(req: NextRequest): Promise<
  | { ok: true; supabase: ReturnType<typeof createServerClient> }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) {
      return { ok: false, response: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
    }
    return { ok: true, supabase };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) };
  }
}

interface AlertLogRow {
  id: string;
  canonical_plan_id: string;
  alert_type: string;
  fired_at: string;
  cost_7d_usd: number;
  baseline_30d_median_usd: number | null;
  slack_delivery_status: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const windowDaysRaw = Number(req.nextUrl.searchParams.get("window_days") ?? "7");
  const windowDays =
    Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 && windowDaysRaw <= 90 ? windowDaysRaw : 7;

  const perCanonical = await aggregatePerCanonicalCost(auth.supabase, windowDays);

  // Pull recent alerts (last 14d, top 50)
  const alertsSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: alertRows } = await auth.supabase
    .from("cost_alert_log")
    .select("id, canonical_plan_id, alert_type, fired_at, cost_7d_usd, baseline_30d_median_usd, slack_delivery_status")
    .gte("fired_at", alertsSince)
    .order("fired_at", { ascending: false })
    .limit(50);

  const recent_alerts = ((alertRows ?? []) as AlertLogRow[]).map((a) => ({
    id: a.id,
    canonical_plan_id: a.canonical_plan_id,
    alert_type: a.alert_type,
    fired_at: a.fired_at,
    cost_7d_usd: a.cost_7d_usd,
    baseline_30d_median_usd: a.baseline_30d_median_usd,
    slack_delivery_status: a.slack_delivery_status,
  }));

  const totalCost7d = perCanonical.reduce((s, c) => s + c.cost_7d_usd, 0);
  const totalEvents7d = perCanonical.reduce((s, c) => s + c.event_count_7d, 0);

  return NextResponse.json({
    window_days: windowDays,
    total_cost_7d_usd: Number(totalCost7d.toFixed(5)),
    total_events_7d: totalEvents7d,
    canonicals_with_cost: perCanonical.length,
    per_canonical: perCanonical.slice(0, 200), // top 200 by cost
    recent_alerts,
  });
}
