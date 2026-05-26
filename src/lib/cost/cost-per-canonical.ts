/**
 * Cost-F per-canonical aggregation helpers (S129).
 *
 * Queries parse_cost_events (the unified cost ledger) to produce per-canonical
 * cost rollups: 7d total + 30d median (for relative-spike detection per R9).
 *
 * Used by:
 *   - /api/admin/cost-per-canonical (admin observability dashboard)
 *   - /api/cron/cost-per-canonical-alerts (daily alert evaluation)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PerCanonicalCost {
  canonical_plan_id: string;
  plan_name: string | null;
  insurer_name: string | null;
  cost_7d_usd: number;
  cost_30d_usd: number;
  baseline_30d_median_usd: number | null;
  event_count_7d: number;
  parser_kind_breakdown: Record<string, number>;
  cost_source_breakdown: Record<string, number>;
  spike_ratio: number | null; // cost_7d / median_30d (null when median is 0 or missing)
}

interface CostEventRow {
  canonical_plan_id: string;
  cost_usd: number;
  parser_kind: string;
  cost_source: string;
  created_at: string;
}

interface CanonicalLookupRow {
  id: string;
  plan_name: string | null;
  insurer_id: string;
}

interface InsurerLookupRow {
  id: string;
  name: string;
}

/**
 * Aggregate per-canonical cost over the requested window. Returns rows sorted
 * by 7d cost desc.
 *
 * windowDays parameter controls the SECONDARY (display) window; the rolling
 * 30d median is always computed over 30d regardless of windowDays so the
 * spike_ratio is comparable across UI window selections.
 *
 * Note: percentile_cont via Postgres function would be cleaner but admin
 * traffic is low (≤ daily cron + ad-hoc admin clicks) and the data volume
 * is small (~10k events / month at MVP scale). JS-side median is sufficient
 * at v1; revisit if row count grows past ~100k.
 */
export async function aggregatePerCanonicalCost(
  supabase: SupabaseClient,
  windowDays: number,
): Promise<PerCanonicalCost[]> {
  const since7d = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Pull all events in last 30d (covers both windowDays and 30d-median needs)
  const { data, error } = await supabase
    .from("parse_cost_events")
    .select("canonical_plan_id, cost_usd, parser_kind, cost_source, created_at")
    .not("canonical_plan_id", "is", null)
    .gte("created_at", since30d)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[cost-per-canonical] aggregation query failed:", error.message);
    return [];
  }

  const rows = (data ?? []) as CostEventRow[];

  // Group by canonical_plan_id
  type Acc = {
    canonical_plan_id: string;
    events_window: CostEventRow[];
    events_30d: CostEventRow[];
  };
  const byCanonical = new Map<string, Acc>();
  for (const r of rows) {
    let entry = byCanonical.get(r.canonical_plan_id);
    if (!entry) {
      entry = {
        canonical_plan_id: r.canonical_plan_id,
        events_window: [],
        events_30d: [],
      };
      byCanonical.set(r.canonical_plan_id, entry);
    }
    entry.events_30d.push(r);
    if (r.created_at >= since7d) entry.events_window.push(r);
  }

  // Lookup canonical_plans + insurer_catalog names in bulk
  const canonicalIds = Array.from(byCanonical.keys());
  const canonicalLookup = new Map<string, { plan_name: string | null; insurer_id: string }>();
  if (canonicalIds.length > 0) {
    const { data: canonicals } = await supabase
      .from("canonical_plans")
      .select("id, plan_name, insurer_id")
      .in("id", canonicalIds);
    for (const c of (canonicals ?? []) as CanonicalLookupRow[]) {
      canonicalLookup.set(c.id, { plan_name: c.plan_name, insurer_id: c.insurer_id });
    }
  }

  const insurerIds = Array.from(new Set(Array.from(canonicalLookup.values()).map((c) => c.insurer_id)));
  const insurerLookup = new Map<string, string>();
  if (insurerIds.length > 0) {
    const { data: insurers } = await supabase
      .from("insurer_catalog")
      .select("id, name")
      .in("id", insurerIds);
    for (const i of (insurers ?? []) as InsurerLookupRow[]) {
      insurerLookup.set(i.id, i.name);
    }
  }

  // Build per-canonical rollup
  const results: PerCanonicalCost[] = [];
  for (const acc of byCanonical.values()) {
    const cost_7d_usd = acc.events_window.reduce((s, r) => s + r.cost_usd, 0);
    const cost_30d_usd = acc.events_30d.reduce((s, r) => s + r.cost_usd, 0);

    const parserBreakdown: Record<string, number> = {};
    const sourceBreakdown: Record<string, number> = {};
    for (const r of acc.events_window) {
      parserBreakdown[r.parser_kind] = (parserBreakdown[r.parser_kind] ?? 0) + r.cost_usd;
      sourceBreakdown[r.cost_source] = (sourceBreakdown[r.cost_source] ?? 0) + r.cost_usd;
    }

    // Rolling 30d median: bucket events into per-day cost, then median across days
    const perDayCost: number[] = computePerDayCosts(acc.events_30d, 30);
    const median = computeMedian(perDayCost);
    const spike_ratio = median > 0 ? cost_7d_usd / 7 / median : null; // cost_7d/7 = per-day avg in window

    const lookup = canonicalLookup.get(acc.canonical_plan_id);
    const insurerName = lookup ? insurerLookup.get(lookup.insurer_id) ?? null : null;

    results.push({
      canonical_plan_id: acc.canonical_plan_id,
      plan_name: lookup?.plan_name ?? null,
      insurer_name: insurerName,
      cost_7d_usd: Number(cost_7d_usd.toFixed(5)),
      cost_30d_usd: Number(cost_30d_usd.toFixed(5)),
      baseline_30d_median_usd: median > 0 ? Number(median.toFixed(5)) : null,
      event_count_7d: acc.events_window.length,
      parser_kind_breakdown: Object.fromEntries(
        Object.entries(parserBreakdown).map(([k, v]) => [k, Number(v.toFixed(5))]),
      ),
      cost_source_breakdown: Object.fromEntries(
        Object.entries(sourceBreakdown).map(([k, v]) => [k, Number(v.toFixed(5))]),
      ),
      spike_ratio: spike_ratio !== null ? Number(spike_ratio.toFixed(3)) : null,
    });
  }

  // Sort by 7d cost desc
  results.sort((a, b) => b.cost_7d_usd - a.cost_7d_usd);
  return results;
}

/**
 * Bucket events into per-day cost over the past `days` days. Returns an array
 * of length `days`; index 0 = today, index days-1 = oldest day. Days with no
 * events have cost 0 (counted in median computation).
 */
function computePerDayCosts(events: CostEventRow[], days: number): number[] {
  const perDay = new Array(days).fill(0);
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (const e of events) {
    const eventMs = new Date(e.created_at).getTime();
    const daysAgo = Math.floor((nowMs - eventMs) / dayMs);
    if (daysAgo >= 0 && daysAgo < days) {
      perDay[daysAgo] += e.cost_usd;
    }
  }
  return perDay;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Lookup the most recent cost_alert_log row for a (canonical, alert_type) pair
 * within the dedup window. Returns true if an alert was fired within `dedupHours`.
 */
export async function wasRecentlyAlerted(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  alertType: "relative_spike" | "absolute_threshold",
  dedupHours: number,
): Promise<boolean> {
  const since = new Date(Date.now() - dedupHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("cost_alert_log")
    .select("id")
    .eq("canonical_plan_id", canonicalPlanId)
    .eq("alert_type", alertType)
    .gte("fired_at", since)
    .limit(1);

  if (error) {
    console.warn(
      `[cost-per-canonical] dedup lookup failed (treating as not-alerted): ${error.message}`,
    );
    return false;
  }
  return (data ?? []).length > 0;
}
