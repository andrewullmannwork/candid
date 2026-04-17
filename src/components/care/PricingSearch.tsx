"use client";

import { useState } from "react";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface ServiceResult {
  serviceSlug: string;
  serviceName: string;
  observationCount: number;
}

export function PricingSearch({
  onSelect,
  state,
}: {
  onSelect: (serviceSlug: string) => void;
  state?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ServiceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ search: query });
      if (state) params.set("state", state);
      const res = await fetch(`/api/care/pricing?${params}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.services || []);
      }
    } catch {
      // Silent
    }
    setLoading(false);
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search for a service (e.g., MRI, colonoscopy, therapy)"
          className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {searched && results.length === 0 && !loading && (
        <p className="text-sm text-gray-500 text-center py-4">
          No pricing data available yet for this service. As more Candid users upload bills, pricing data grows.
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r) => (
            <button
              key={r.serviceSlug}
              onClick={() => onSelect(r.serviceSlug)}
              className="w-full p-3 text-left bg-white border border-gray-100 rounded-xl hover:border-blue-200 hover:bg-blue-50/30 transition-colors"
            >
              <div className="flex justify-between items-center">
                <p className="text-sm font-medium text-gray-900">{r.serviceName}</p>
                <span className="text-[10px] text-gray-400">{r.observationCount} reports</span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Disclaimer variant="pricing_care" />
    </div>
  );
}
