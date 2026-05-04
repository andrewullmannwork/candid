/**
 * DisputeAggregateWidget — Per-insurer dispute outcome aggregate (T2.2 v3)
 *
 * Renders cross-user dispute success metrics for a specific insurer (canonical FK).
 * Pattern 1 #11 tiered methodology disclosure via MethodologyTooltip.
 * K-anon ≥5 distinct USER count enforced server-side; sub-k cells render
 * "insufficient data" placeholder per Q-T2.2-4 LOCK SHARPENED.
 *
 * Reads from /api/aggregates/disputes?scope=aggregate&insurer_id=<id>.
 * Behind dispute_feedback_loop flag (default OFF; admin-only soak then global).
 */

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { MethodologyTooltip, type MethodologyMetadata } from "./MethodologyTooltip";

interface AggregateRow {
  insurerName: string;
  insurerCanonicalId: string | null;
  distinctUserCount: number;
  totalOutcomes: number;
  wins: number;
  losses: number;
  winRate: number;
  totalRecovered: number;
  avgRecoveredPct: number | null;
}

interface AggregateResponse {
  scope: string;
  data: {
    insurerMetrics: AggregateRow[];
    overallDistinctUsers: number;
    overallWinRate: number | null;
    overallRecovered: number;
    methodology: MethodologyMetadata;
  };
  methodology: MethodologyMetadata;
  flagEnabled: boolean;
}

interface Props {
  insurerCanonicalId?: string;
}

export function DisputeAggregateWidget({ insurerCanonicalId }: Props) {
  const { user } = useAuth();
  const [response, setResponse] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    async function load() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const params = new URLSearchParams({ scope: "aggregate" });
        if (insurerCanonicalId) params.set("insurer_id", insurerCanonicalId);
        const res = await fetch(`/api/aggregates/disputes?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = (await res.json()) as AggregateResponse;
          setResponse(json);
        }
      } catch {
        // Silent — widget is non-critical
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user, insurerCanonicalId]);

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }

  if (!response || !response.flagEnabled) return null;

  const rows = response.data.insurerMetrics;
  const methodology = response.methodology;

  // K-anon threshold not met for any insurer cells
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-100 bg-white p-4">
        <p className="text-sm font-semibold text-gray-900">Community dispute success rates</p>
        <p className="mt-1 text-sm text-gray-500">
          Insufficient data — we need at least {methodology.k_anon_min_distinct_users ?? 5} distinct
          Candid users with resolved disputes before showing community metrics.
        </p>
        <div className="mt-2">
          <MethodologyTooltip methodology={methodology} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-100 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm font-semibold text-gray-900">Community dispute success rates</p>
        <MethodologyTooltip methodology={methodology} />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.insurerCanonicalId ?? row.insurerName}
            className="flex items-baseline justify-between border-b border-gray-50 pb-2 last:border-b-0 last:pb-0"
          >
            <div>
              <p className="text-sm font-medium text-gray-900">{row.insurerName}</p>
              <p className="text-xs text-gray-500">
                {row.distinctUserCount} users · {row.totalOutcomes} outcomes
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-gray-900">
                {Math.round(row.winRate * 100)}% win rate
              </p>
              <p className="text-xs text-gray-500">
                ${row.totalRecovered.toLocaleString()} recovered
                {row.avgRecoveredPct !== null && (
                  <span> · avg {Math.round(row.avgRecoveredPct * 100)}% of disputed amount</span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
