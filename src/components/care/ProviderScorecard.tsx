"use client";

import { useState, useEffect } from "react";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface ProviderData {
  name: string;
  npi: string | null;
  specialty: string | null;
  organization: string | null;
  city: string | null;
  state: string | null;
}

interface AuditMetrics {
  totalBillsAnalyzed: number;
  findingCount: number;
  findingRate: number;
  findingTypes: Record<string, number>;
}

export function ProviderScorecard({ providerId }: { providerId: string }) {
  const [provider, setProvider] = useState<ProviderData | null>(null);
  const [metrics, setMetrics] = useState<AuditMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/care/provider?id=${providerId}`);
        if (res.ok) {
          const data = await res.json();
          setProvider(data.provider);
          setMetrics(data.auditMetrics);
        }
      } catch {
        // Silent
      }
      setLoading(false);
    }
    load();
  }, [providerId]);

  if (loading) return <div className="text-sm text-gray-500">Loading provider...</div>;
  if (!provider) return null;

  const rateColor = metrics
    ? metrics.findingRate > 0.3 ? "text-red-600" : metrics.findingRate > 0.1 ? "text-amber-600" : "text-green-600"
    : "text-gray-400";

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">{provider.name}</h4>
          {provider.specialty && (
            <p className="text-xs text-gray-500">{provider.specialty}</p>
          )}
          {provider.city && provider.state && (
            <p className="text-xs text-gray-400">{provider.city}, {provider.state}</p>
          )}
        </div>
        {provider.npi && (
          <span className="text-[10px] text-gray-400 font-mono">NPI: {provider.npi}</span>
        )}
      </div>

      {metrics ? (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-2.5 bg-gray-50 rounded-lg text-center">
            <p className="text-lg font-bold text-gray-900">{metrics.totalBillsAnalyzed}</p>
            <p className="text-[10px] text-gray-500">Bills Reviewed</p>
          </div>
          <div className="p-2.5 bg-gray-50 rounded-lg text-center">
            <p className="text-lg font-bold text-gray-900">{metrics.findingCount}</p>
            <p className="text-[10px] text-gray-500">Issues Found</p>
          </div>
          <div className="p-2.5 bg-gray-50 rounded-lg text-center">
            <p className={`text-lg font-bold ${rateColor}`}>
              {(metrics.findingRate * 100).toFixed(0)}%
            </p>
            <p className="text-[10px] text-gray-500">Error Rate</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-400">Not enough data for billing scorecard yet.</p>
      )}

      <Disclaimer variant="pricing_care" className="mt-3" />
    </div>
  );
}
