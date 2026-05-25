/**
 * Admin GET for /admin/auto-reparse-stats (Ing-A, S127).
 *
 *   GET /api/admin/auto-reparse-stats?window_days=7
 *
 * Returns per-field rolling fire stats from `auto_reparse_field_frequencies`
 * — fire counts, per-trigger-reason breakdown, per-outcome breakdown, total
 * cost. Used to calibrate the triage threshold (`haiku_confidence < 0.5`) +
 * per-field cap tuning in Phase 6+.
 *
 * Auth: admin-only via Firebase ID token → users.is_admin. Mirrors the gate
 * used by /api/admin/documents/blocklist.
 *
 * Aggregation strategy: pulls raw rows for the window + aggregates in JS.
 * Admin traffic is low; no SQL function needed at MVP. If row volume grows
 * past ~10k per window, switch to a Postgres function with GROUP BY.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

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

interface PerFieldStats {
  field_name: string;
  service_slug: string | null;
  fires: number;
  triggers: { null_value: number; unverified_excerpt: number; low_confidence: number };
  outcomes: Record<string, number>;
  total_cost_usd: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const windowDaysRaw = Number(req.nextUrl.searchParams.get("window_days") ?? "7");
  const windowDays =
    Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 && windowDaysRaw <= 90 ? windowDaysRaw : 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await auth.supabase
    .from("auto_reparse_field_frequencies")
    .select("field_name, service_slug, trigger_reason, reparse_outcome, reparse_cost_usd")
    .gte("created_at", since);

  if (error) {
    console.error("[auto-reparse-stats] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }

  const byField = new Map<string, PerFieldStats>();
  let totalFires = 0;
  let totalCostUsd = 0;
  let skippedCapCount = 0;

  for (const row of data ?? []) {
    const fieldName = row.field_name as string;
    const serviceSlug = (row.service_slug as string | null) ?? null;
    const trigger = row.trigger_reason as keyof PerFieldStats["triggers"];
    const outcome = row.reparse_outcome as string;
    const cost = (row.reparse_cost_usd as number | null) ?? 0;

    const key = `${serviceSlug ?? ""}::${fieldName}`;
    let stats = byField.get(key);
    if (!stats) {
      stats = {
        field_name: fieldName,
        service_slug: serviceSlug,
        fires: 0,
        triggers: { null_value: 0, unverified_excerpt: 0, low_confidence: 0 },
        outcomes: {},
        total_cost_usd: 0,
      };
      byField.set(key, stats);
    }
    stats.fires += 1;
    stats.triggers[trigger] += 1;
    stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
    stats.total_cost_usd += cost;

    totalFires += 1;
    totalCostUsd += cost;
    if (outcome === "reparse_skipped_cap") skippedCapCount += 1;
  }

  const fields = Array.from(byField.values()).sort((a, b) => b.fires - a.fires);

  return NextResponse.json({
    window_days: windowDays,
    total_fires: totalFires,
    total_cost_usd: Number(totalCostUsd.toFixed(5)),
    skipped_cap_count: skippedCapCount,
    by_field: fields,
  });
}
