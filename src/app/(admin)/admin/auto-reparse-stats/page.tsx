"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface PerFieldStats {
  field_name: string;
  service_slug: string | null;
  fires: number;
  triggers: { null_value: number; unverified_excerpt: number; low_confidence: number };
  outcomes: Record<string, number>;
  total_cost_usd: number;
}

interface StatsResponse {
  window_days: number;
  total_fires: number;
  total_cost_usd: number;
  skipped_cap_count: number;
  by_field: PerFieldStats[];
}

const WINDOW_OPTIONS = [1, 7, 30, 90];

export default function AutoReparseStatsPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadStats(days: number) {
    setLoading(true);
    setError(null);
    try {
      const idToken = await user!.firebaseUser.getIdToken();
      const res = await fetch(`/api/admin/auto-reparse-stats?window_days=${days}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        const data: StatsResponse = await res.json();
        setStats(data);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to load stats");
        setStats(null);
      }
    } catch (err) {
      console.error("[auto-reparse-stats] load failed:", err);
      setError("Failed to load stats");
      setStats(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStats(windowDays);
  }, [user, windowDays]);

  return (
    <div className="max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Auto-Reparse Stats (Ing-A)</h1>
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
        Per-field fire counts for the post-promotion auto-reparse triage hook. Triggers:{" "}
        <code>null_value</code> (no value extracted), <code>unverified_excerpt</code> (Pattern P-8
        verifier didn&apos;t confirm), <code>low_confidence</code> (haiku_confidence &lt; 0.5). Use
        these counts to calibrate per-field thresholds in Phase 6+.
      </p>

      {loading && <div className="text-gray-500">Loading…</div>}
      {error && <div className="text-red-600">{error}</div>}

      {stats && (
        <>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <SummaryCard label="Total fires" value={stats.total_fires.toString()} />
            <SummaryCard
              label="Total cost (USD)"
              value={`$${stats.total_cost_usd.toFixed(4)}`}
            />
            <SummaryCard label="Skipped (cap)" value={stats.skipped_cap_count.toString()} />
          </div>

          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2">Field</th>
                  <th className="px-4 py-2">Service slug</th>
                  <th className="px-4 py-2 text-right">Fires</th>
                  <th className="px-4 py-2">Triggers (null / unverified / low-conf)</th>
                  <th className="px-4 py-2">Outcomes</th>
                  <th className="px-4 py-2 text-right">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_field.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                      No fires recorded in this window.
                    </td>
                  </tr>
                ) : (
                  stats.by_field.map((f) => (
                    <tr key={`${f.service_slug ?? ""}::${f.field_name}`} className="border-t border-gray-100">
                      <td className="px-4 py-2 font-mono text-xs">{f.field_name}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">
                        {f.service_slug ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold">{f.fires}</td>
                      <td className="px-4 py-2 text-xs">
                        {f.triggers.null_value} / {f.triggers.unverified_excerpt} /{" "}
                        {f.triggers.low_confidence}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {Object.entries(f.outcomes)
                          .map(([k, v]) => `${k.replace("reparse_", "")}=${v}`)
                          .join(", ")}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs">
                        ${f.total_cost_usd.toFixed(4)}
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

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
    </div>
  );
}
