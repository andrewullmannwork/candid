"use client";

import Link from "next/link";

export default function CandidCarePage() {
  return (
    <div className="relative min-h-[80vh]">
      {/* ── Locked overlay ──────────────────────────────────────────────── */}
      <div className="sticky top-[25vh] z-20 h-0">
        <div className="flex items-center justify-center">
        <div className="flex flex-col items-center bg-white/95 backdrop-blur-sm border border-gray-200 rounded-2xl shadow-xl px-10 py-8 max-w-md">
          <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900">Candid Care</h2>
          <span className="mt-1.5 text-[11px] font-semibold text-blue-600 bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-100">
            Coming Soon
          </span>
          <p className="mt-3 text-sm text-gray-500 text-center leading-relaxed">
            Real price transparency powered by real billing data. Upload bills now to help build the dataset.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <Link href="/upload" className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
              Upload a bill
            </Link>
            <Link href="/dashboard" className="px-5 py-2 text-gray-500 text-sm font-medium border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
              Dashboard
            </Link>
          </div>
        </div>
        </div>
      </div>

      {/* ── Preview dashboard (non-interactive, visible behind lock) ──── */}
      <div className="pointer-events-none select-none opacity-40">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Candid Care</h1>
          <p className="mt-1 text-sm text-gray-500">Compare prices, find fair providers, and make informed healthcare decisions.</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">847K</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Data Points</p>
            <p className="text-[10px] text-green-600 font-semibold mt-1">+12.4% this month</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">48</p>
            <p className="text-xs font-medium text-gray-500 mt-1">States Covered</p>
            <p className="text-[10px] text-green-600 font-semibold mt-1">+3 new regions</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">2,340</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Procedures Tracked</p>
            <p className="text-[10px] text-blue-600 font-semibold mt-1">All major categories</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">94%</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Data Confidence</p>
            <p className="text-[10px] text-purple-600 font-semibold mt-1">User-verified</p>
          </div>
        </div>

        {/* Search bar */}
        <div className="mb-6">
          <div className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-xl">
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="text-sm text-gray-400">Search procedures, providers, or facilities...</span>
          </div>
        </div>

        {/* Price comparison cards */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Price Comparison</h2>
          <div className="space-y-3">
            {[
              { procedure: "MRI (Brain, without contrast)", code: "70551", low: "$425", median: "$1,250", high: "$3,800", you: "$1,875", savings: "$625", providers: 142 },
              { procedure: "Colonoscopy (Diagnostic)", code: "45378", low: "$800", median: "$2,100", high: "$5,200", you: "$2,750", savings: "$650", providers: 89 },
              { procedure: "Complete Blood Count (CBC)", code: "85025", low: "$12", median: "$45", high: "$210", you: "$95", savings: "$50", providers: 312 },
            ].map((item) => (
              <div key={item.code} className="p-4 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{item.procedure}</p>
                    <p className="text-xs text-gray-400 mt-0.5">CPT {item.code} · {item.providers} providers in your area</p>
                  </div>
                  <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                    Save {item.savings}
                  </span>
                </div>
                {/* Price bar */}
                <div className="relative h-8 bg-gray-50 rounded-lg overflow-hidden">
                  <div className="absolute inset-y-0 left-[10%] right-[20%] bg-gradient-to-r from-green-100 via-blue-50 to-amber-100 rounded" />
                  <div className="absolute inset-y-0 left-[10%] flex items-center">
                    <div className="w-0.5 h-5 bg-green-500 rounded-full" />
                    <span className="ml-1 text-[10px] font-bold text-green-700">{item.low}</span>
                  </div>
                  <div className="absolute inset-y-0 left-[45%] flex items-center">
                    <div className="w-0.5 h-5 bg-blue-500 rounded-full" />
                    <span className="ml-1 text-[10px] font-bold text-blue-700">{item.median}</span>
                  </div>
                  <div className="absolute inset-y-0 right-[20%] flex items-center">
                    <div className="w-0.5 h-5 bg-amber-500 rounded-full" />
                    <span className="ml-1 text-[10px] font-bold text-amber-700">{item.high}</span>
                  </div>
                  <div className="absolute inset-y-0 left-[60%] flex items-center">
                    <div className="w-2 h-2 bg-red-500 rounded-full border-2 border-white shadow" />
                    <span className="ml-1 text-[10px] font-bold text-red-600">You: {item.you}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-gray-400">Lowest in area</span>
                  <span className="text-[10px] text-gray-400">Median</span>
                  <span className="text-[10px] text-gray-400">Highest</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Provider billing scores */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Provider Billing Scores</h2>
          <div className="space-y-2">
            {[
              { name: "Bay Area Medical Center", score: 94, rating: "Excellent", color: "text-green-700 bg-green-50", bills: 1247, errors: "2.1%" },
              { name: "Pacific Heights Imaging", score: 87, rating: "Good", color: "text-blue-700 bg-blue-50", bills: 834, errors: "5.8%" },
              { name: "Golden Gate Radiology", score: 72, rating: "Fair", color: "text-amber-700 bg-amber-50", bills: 456, errors: "12.3%" },
              { name: "Summit Health Partners", score: 61, rating: "Below Avg", color: "text-red-700 bg-red-50", bills: 289, errors: "18.7%" },
            ].map((p) => (
              <div key={p.name} className="flex items-center justify-between p-3.5 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                    <span className="text-sm font-bold text-gray-600">{p.score}</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-400">{p.bills.toLocaleString()} bills analyzed · {p.errors} error rate</p>
                  </div>
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${p.color}`}>{p.rating}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Regional benchmarks */}
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Regional Benchmarks</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { region: "San Francisco, CA", avg: "$2,340", vs: "+18%", trend: "above" },
              { region: "Oakland, CA", avg: "$1,890", vs: "-4%", trend: "below" },
              { region: "San Jose, CA", avg: "$2,100", vs: "+7%", trend: "above" },
              { region: "Sacramento, CA", avg: "$1,650", vs: "-16%", trend: "below" },
            ].map((r) => (
              <div key={r.region} className="p-3.5 bg-white border border-gray-100 rounded-xl">
                <p className="text-sm font-medium text-gray-900">{r.region}</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <p className="text-lg font-bold text-gray-900">{r.avg}</p>
                  <span className={`text-xs font-semibold ${r.trend === "above" ? "text-red-500" : "text-green-500"}`}>
                    {r.vs} vs national
                  </span>
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">Avg procedure cost</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
