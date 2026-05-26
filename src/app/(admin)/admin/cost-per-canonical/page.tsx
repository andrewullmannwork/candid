"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface PerCanonicalCost {
  canonical_plan_id: string;
  plan_name: string | null;
  insurer_name: string | null;
  cost_7d_usd: number;
  cost_30d_usd: number;
  baseline_30d_median_usd: number | null;
  event_count_7d: number;
  parser_kind_breakdown: Record<string, number>;
  cost_source_breakdown: Record<string, number>;
  spike_ratio: number | null;
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

interface Response {
  window_days: number;
  total_cost_7d_usd: number;
  total_events_7d: number;
  canonicals_with_cost: number;
  per_canonical: PerCanonicalCost[];
  recent_alerts: AlertLogRow[];
}

const WINDOW_OPTIONS = [1, 7, 30, 90];

export default function CostPerCanonicalPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Response | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(days: number) {
    setLoading(true);
    setError(null);
    try {
      const idToken = await user!.firebaseUser.getIdToken();
      const res = await fetch(`/api/admin/cost-per-canonical?window_days=${days}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        const body: Response = await res.json();
        setData(body);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to load cost data");
        setData(null);
      }
    } catch (err) {
      console.error("[cost-per-canonical] load failed:", err);
      setError("Failed to load cost data");
      setData(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    load(windowDays);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, windowDays]);

  return (
    <div className="max-w-7xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Cost Per Canonical (Cost-F)</h1>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">Window:</span>
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-3 py-1 rounded ${
                windowDays === d
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-200 hover:bg-gray-100"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-6">
        Per-canonical Haiku cost aggregated from <code>parse_cost_events</code> (unified cost
        ledger). 30d median is per-day baseline; <code>spike_ratio</code> = per-day average in
        window ÷ 30d median. Alerts fire when ratio ≥ 2× OR window cost &gt; $5 absolute
        (whichever first; dedup 24h per canonical+type pair).
      </p>

      {loading && <div className="text-gray-500">Loading…</div>}
      {error && <div className="text-red-600">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <SummaryCard
              label={`Total cost (${data.window_days}d)`}
              value={`$${data.total_cost_7d_usd.toFixed(4)}`}
            />
            <SummaryCard
              label={`Events (${data.window_days}d)`}
              value={data.total_events_7d.toString()}
            />
            <SummaryCard
              label="Canonicals with cost"
              value={data.canonicals_with_cost.toString()}
            />
          </div>

          <h2 className="text-lg font-semibold text-gray-900 mb-3">Per-canonical rollup</h2>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Insurer</th>
                  <th className="px-3 py-2 text-right">{data.window_days}d cost</th>
                  <th className="px-3 py-2 text-right">30d median/day</th>
                  <th className="px-3 py-2 text-right">Spike ratio</th>
                  <th className="px-3 py-2 text-right">Events</th>
                  <th className="px-3 py-2">Top kinds</th>
                  <th className="px-3 py-2">Top sources</th>
                </tr>
              </thead>
              <tbody>
                {data.per_canonical.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-gray-400">
                      No cost events recorded for canonicals in this window.
                    </td>
                  </tr>
                ) : (
                  data.per_canonical.map((c) => (
                    <tr key={c.canonical_plan_id} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-xs font-medium">
                        {c.plan_name ?? <span className="text-gray-400">(unnamed)</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {c.insurer_name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                        ${c.cost_7d_usd.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">
                        {c.baseline_30d_median_usd !== null
                          ? `$${c.baseline_30d_median_usd.toFixed(4)}`
                          : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono text-xs ${
                          c.spike_ratio !== null && c.spike_ratio >= 2
                            ? "text-red-600 font-semibold"
                            : ""
                        }`}
                      >
                        {c.spike_ratio !== null ? `${c.spike_ratio.toFixed(2)}x` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">{c.event_count_7d}</td>
                      <td className="px-3 py-2 text-xs">
                        {formatBreakdown(c.parser_kind_breakdown)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {formatBreakdown(c.cost_source_breakdown)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h2 className="text-lg font-semibold text-gray-900 mb-3">Recent alerts (last 14d)</h2>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">Fired at</th>
                  <th className="px-3 py-2">Canonical</th>
                  <th className="px-3 py-2">Alert type</th>
                  <th className="px-3 py-2 text-right">7d cost</th>
                  <th className="px-3 py-2 text-right">30d median</th>
                  <th className="px-3 py-2">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_alerts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                      No alerts fired in last 14d.
                    </td>
                  </tr>
                ) : (
                  data.recent_alerts.map((a) => (
                    <tr key={a.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {new Date(a.fired_at).toISOString().slice(0, 16)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-gray-500">
                        {a.canonical_plan_id.slice(0, 8)}…
                      </td>
                      <td className="px-3 py-2 text-xs">{a.alert_type}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        ${a.cost_7d_usd.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">
                        {a.baseline_30d_median_usd !== null
                          ? `$${a.baseline_30d_median_usd.toFixed(4)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span
                          className={
                            a.slack_delivery_status === "delivered"
                              ? "text-green-700"
                              : a.slack_delivery_status === "failed"
                                ? "text-red-700"
                                : "text-amber-700"
                          }
                        >
                          {a.slack_delivery_status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function formatBreakdown(breakdown: Record<string, number>, topN = 2): string {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(", ");
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
    </div>
  );
}
