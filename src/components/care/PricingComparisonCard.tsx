"use client";

import { Disclaimer } from "@/components/shared/Disclaimer";

interface PricingData {
  serviceSlug: string;
  serviceName: string;
  observationCount: number;
  medianBilled: number | null;
  avgBilled: number | null;
  minBilled: number | null;
  maxBilled: number | null;
  medianPatientOwes: number | null;
  avgPatientOwes: number | null;
  medicareBenchmark: number | null;
  region: string | null;
}

export function PricingComparisonCard({
  pricing,
  userPaid,
  onBack,
}: {
  pricing: PricingData;
  userPaid?: number;
  onBack: () => void;
}) {
  const hasRange = pricing.minBilled != null && pricing.maxBilled != null;

  return (
    <div>
      <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-700 mb-4 flex items-center gap-1">
        <span>&larr;</span> Back to search
      </button>

      <div className="bg-white border border-gray-100 rounded-xl p-5 mb-4">
        <h3 className="text-lg font-bold text-gray-900 mb-1">{pricing.serviceName}</h3>
        <p className="text-xs text-gray-500 mb-4">
          Based on {pricing.observationCount} community reports{pricing.region ? ` in ${pricing.region}` : ""}
        </p>

        {/* Price range visualization */}
        {hasRange && (
          <div className="mb-4">
            <div className="flex justify-between text-[10px] text-gray-500 mb-1">
              <span>Low</span>
              <span>Median</span>
              <span>High</span>
            </div>
            <div className="relative h-3 bg-gradient-to-r from-green-200 via-yellow-200 to-red-200 rounded-full">
              {/* Median marker */}
              {pricing.medianBilled && pricing.minBilled && pricing.maxBilled && (
                <div
                  className="absolute top-0 w-0.5 h-3 bg-gray-800"
                  style={{
                    left: `${((pricing.medianBilled - pricing.minBilled) / (pricing.maxBilled - pricing.minBilled)) * 100}%`,
                  }}
                />
              )}
              {/* User marker */}
              {userPaid && pricing.minBilled && pricing.maxBilled && (
                <div
                  className="absolute -top-1 w-3 h-5 bg-blue-600 rounded-sm"
                  style={{
                    left: `${Math.min(100, Math.max(0, ((userPaid - pricing.minBilled) / (pricing.maxBilled - pricing.minBilled)) * 100))}%`,
                  }}
                  title={`You paid: $${userPaid}`}
                />
              )}
            </div>
            <div className="flex justify-between text-xs font-semibold text-gray-900 mt-1">
              <span>${pricing.minBilled?.toLocaleString()}</span>
              <span>${pricing.medianBilled?.toLocaleString()}</span>
              <span>${pricing.maxBilled?.toLocaleString()}</span>
            </div>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {pricing.medianBilled != null && (
            <div className="p-3 bg-gray-50 rounded-lg">
              <p className="text-lg font-bold text-gray-900">${pricing.medianBilled.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Median Billed</p>
            </div>
          )}
          {pricing.medianPatientOwes != null && (
            <div className="p-3 bg-gray-50 rounded-lg">
              <p className="text-lg font-bold text-gray-900">${pricing.medianPatientOwes.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Median Patient Cost</p>
            </div>
          )}
          {pricing.medicareBenchmark != null && (
            <div className="p-3 bg-blue-50 rounded-lg">
              <p className="text-lg font-bold text-blue-700">${pricing.medicareBenchmark.toLocaleString()}</p>
              <p className="text-[10px] text-blue-500">Medicare Rate</p>
            </div>
          )}
        </div>

        {/* User comparison */}
        {userPaid != null && pricing.medianBilled != null && (
          <div className={`mt-4 p-3 rounded-lg border ${
            userPaid > pricing.medianBilled * 1.15
              ? "bg-red-50 border-red-200"
              : "bg-green-50 border-green-200"
          }`}>
            <p className={`text-xs font-semibold ${
              userPaid > pricing.medianBilled * 1.15 ? "text-red-800" : "text-green-800"
            }`}>
              You paid ${userPaid.toLocaleString()} — {
                userPaid > pricing.medianBilled * 1.15
                  ? `${((userPaid / pricing.medianBilled - 1) * 100).toFixed(0)}% above median`
                  : "within normal range"
              }
            </p>
          </div>
        )}
      </div>

      <Disclaimer variant="pricing_care" />
    </div>
  );
}
