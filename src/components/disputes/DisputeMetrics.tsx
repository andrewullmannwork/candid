"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface UserMetrics {
  totalFiled: number;
  totalWon: number;
  totalSettled: number;
  totalLost: number;
  totalActive: number;
  wonOnEscalation: number;
  totalRecovered: number;
  totalDisputed: number;
  winRate: number | null;
}

interface InsurerMetric {
  insurerName: string;
  totalDisputes: number;
  winRate: number;
  totalRecovered: number;
}

interface AggregateMetrics {
  insurerMetrics: InsurerMetric[];
  overallWinRate: number | null;
  overallRecovered: number;
}

export function DisputeMetrics() {
  const { user } = useAuth();
  const [userMetrics, setUserMetrics] = useState<UserMetrics | null>(null);
  const [aggregateMetrics, setAggregateMetrics] = useState<AggregateMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    async function loadMetrics() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/disputes/metrics", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUserMetrics(data.user);
          setAggregateMetrics(data.aggregate);
        }
      } catch {
        // Silent
      }
      setLoading(false);
    }
    loadMetrics();
  }, [user]);

  if (loading || !userMetrics) return null;
  if (userMetrics.totalFiled === 0) return null;

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Your Dispute Results</h3>

      {/* Personal stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard label="Filed" value={userMetrics.totalFiled} />
        <StatCard
          label={userMetrics.wonOnEscalation > 0 ? `Won (${userMetrics.wonOnEscalation} on escalation)` : "Won / Settled"}
          value={userMetrics.totalWon + userMetrics.totalSettled}
          color="green"
        />
        <StatCard label="Lost" value={userMetrics.totalLost} color="red" />
        <StatCard
          label="Recovered"
          value={`$${userMetrics.totalRecovered.toLocaleString()}`}
          color="green"
        />
      </div>

      {userMetrics.winRate !== null && (
        <p className="text-xs text-gray-500 mb-4">
          Your success rate: <span className="font-semibold text-gray-900">{(userMetrics.winRate * 100).toFixed(0)}%</span>
        </p>
      )}

      {/* Aggregate insurer metrics (k >= 5) */}
      {aggregateMetrics && aggregateMetrics.insurerMetrics.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-gray-700 mb-2">Community Dispute Success Rates</h4>
          <div className="space-y-2">
            {aggregateMetrics.insurerMetrics.slice(0, 5).map((im) => (
              <div key={im.insurerName} className="flex items-center justify-between text-xs">
                <span className="text-gray-700">{im.insurerName}</span>
                <div className="flex items-center gap-3">
                  <span className="text-gray-500">{im.totalDisputes} disputes</span>
                  <span className="font-semibold text-gray-900">
                    {(im.winRate * 100).toFixed(0)}% success
                  </span>
                </div>
              </div>
            ))}
          </div>
          {aggregateMetrics.overallWinRate !== null && (
            <p className="text-xs text-gray-400 mt-2">
              Overall community success rate: {(aggregateMetrics.overallWinRate * 100).toFixed(0)}%
              · ${aggregateMetrics.overallRecovered.toLocaleString()} recovered
            </p>
          )}
        </div>
      )}

      <Disclaimer variant="accuracy_rate" />
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  const textColor = color === "green" ? "text-green-600" : color === "red" ? "text-red-600" : "text-gray-900";
  return (
    <div className="p-3 bg-gray-50 rounded-lg">
      <p className={`text-lg font-bold ${textColor}`}>{value}</p>
      <p className="text-[10px] font-medium text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}
