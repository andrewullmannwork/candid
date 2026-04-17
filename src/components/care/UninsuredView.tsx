"use client";

import { Disclaimer } from "@/components/shared/Disclaimer";

interface PricingData {
  serviceName: string;
  medianBilled: number | null;
  avgBilled: number | null;
  minBilled: number | null;
  maxBilled: number | null;
  medicareBenchmark: number | null;
  observationCount: number;
}

export function UninsuredView({
  pricing,
  onGenerateLetter,
}: {
  pricing: PricingData;
  onGenerateLetter: () => void;
}) {
  const fairRate = pricing.medicareBenchmark
    ? Math.round(pricing.medicareBenchmark * 1.2) // Medicare + 20%
    : pricing.medianBilled
      ? Math.round(pricing.medianBilled * 0.6) // 60% of median
      : null;

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
          <span className="text-blue-600 text-sm font-bold">$</span>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Self-Pay / Uninsured Pricing</h3>
          <p className="text-xs text-gray-500">{pricing.serviceName}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {pricing.medicareBenchmark != null && (
          <div className="p-3 bg-blue-50 rounded-lg">
            <p className="text-lg font-bold text-blue-700">${pricing.medicareBenchmark.toLocaleString()}</p>
            <p className="text-[10px] text-blue-500">Medicare Rate</p>
          </div>
        )}
        {pricing.medianBilled != null && (
          <div className="p-3 bg-gray-50 rounded-lg">
            <p className="text-lg font-bold text-gray-900">${pricing.medianBilled.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500">Community Median</p>
          </div>
        )}
      </div>

      {fairRate && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg mb-4">
          <p className="text-xs font-semibold text-green-900 mb-1">Suggested negotiation rate</p>
          <p className="text-2xl font-bold text-green-700">${fairRate.toLocaleString()}</p>
          <p className="text-xs text-green-600 mt-1">
            {pricing.medicareBenchmark
              ? "Based on Medicare rate + 20% (standard self-pay benchmark)"
              : "Based on 60% of community median billing rate"}
          </p>
        </div>
      )}

      <div className="space-y-2 mb-4">
        <p className="text-xs font-semibold text-gray-700">Your options:</p>
        <ul className="text-xs text-gray-600 space-y-1.5">
          <li>- Ask the provider for their <strong>self-pay / cash-pay rate</strong> before treatment</li>
          <li>- Request a <strong>payment plan</strong> if the total is over $500</li>
          <li>- Ask about <strong>financial assistance programs</strong> or charity care</li>
          <li>- Negotiate using the fair rate above as your starting point</li>
        </ul>
      </div>

      <button
        onClick={onGenerateLetter}
        className="w-full py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors"
      >
        Generate negotiation letter
      </button>

      <Disclaimer variant="negotiation_letter" className="mt-3" />
    </div>
  );
}
