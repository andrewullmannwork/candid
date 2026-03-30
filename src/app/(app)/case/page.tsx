"use client";

import Link from "next/link";

export default function CandidCasePage() {
  return (
    <div className="relative min-h-[80vh]">
      {/* ── Locked overlay ──────────────────────────────────────────────── */}
      <div className="sticky top-[25vh] z-20 h-0">
        <div className="flex items-center justify-center">
        <div className="flex flex-col items-center bg-white/95 backdrop-blur-sm border border-gray-200 rounded-2xl shadow-xl px-10 py-8 max-w-md">
          <div className="w-12 h-12 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900">Candid Case</h2>
          <span className="mt-1.5 text-[11px] font-semibold text-purple-600 bg-purple-50 px-2.5 py-0.5 rounded-full border border-purple-100">
            Coming Soon
          </span>
          <p className="mt-3 text-sm text-gray-500 text-center leading-relaxed">
            Build your case. Find your lawyer. Compile audits, dispute letters, and evidence into a downloadable case file.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <Link href="/upload" className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
              Upload a bill
            </Link>
            <Link href="/dashboard" className="px-5 py-2 text-gray-500 text-sm font-medium border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
              Dashboard
            </Link>
          </div>
          <p className="mt-4 text-[10px] text-gray-400 text-center leading-relaxed max-w-sm">
            Candid does not provide legal advice or referrals. Attorney listings are for informational purposes only.
            No attorney-client relationship is formed through this platform.
          </p>
        </div>
        </div>
      </div>

      {/* ── Preview dashboard (non-interactive, visible behind lock) ──── */}
      <div className="pointer-events-none select-none opacity-40">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Candid Case</h1>
          <p className="mt-1 text-sm text-gray-500">Compile your case, download evidence, and browse attorneys.</p>
        </div>

        {/* Case builder preview */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Case Builder</h2>
          <div className="p-5 bg-white border border-gray-100 rounded-xl">
            <div className="space-y-3 mb-4">
              {[
                { label: "Audit Report", desc: "Line-by-line bill analysis with flagged errors", included: true },
                { label: "Dispute Letters", desc: "3 generated letters ready to send", included: true },
                { label: "Supporting Evidence", desc: "Benchmark data, CPT references, plan terms", included: true },
                { label: "Timeline", desc: "Chronological record of all billing events", included: true },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-100 rounded-lg">
                  <div className="w-5 h-5 rounded-md bg-green-500 flex items-center justify-center shrink-0">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{item.label}</p>
                    <p className="text-xs text-gray-400">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <div className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg text-center">Download Case File</div>
              <div className="py-2.5 px-4 border border-gray-200 text-sm font-medium text-gray-600 rounded-lg text-center">Preview</div>
            </div>
          </div>
        </div>

        {/* Attorney directory preview */}
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Attorney Directory</h2>
          <div className="mb-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
            <p className="text-[10px] text-gray-400 leading-relaxed">
              <span className="font-semibold text-gray-500">Disclaimer:</span>{" "}
              Candid does not provide legal advice or referrals. Attorney listings are for informational purposes only.
              No attorney-client relationship is formed through this platform.
            </p>
          </div>
          <div className="space-y-2">
            {[
              { name: "Sarah Chen, Esq.", firm: "Chen Health Law Group", specialty: "Medical billing disputes", rating: 4.9, cases: 234 },
              { name: "Marcus Williams, JD", firm: "Patient Rights Legal", specialty: "Insurance denials & appeals", rating: 4.8, cases: 189 },
              { name: "Dr. Lisa Park, JD", firm: "MedJustice Partners", specialty: "Hospital billing errors", rating: 4.7, cases: 156 },
            ].map((lawyer, i) => (
              <div key={i} className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center">
                    <span className="text-xs font-bold text-gray-500">{lawyer.name.split(" ").map(n => n[0]).join("").slice(0, 2)}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{lawyer.name}</p>
                    <p className="text-xs text-gray-500">{lawyer.firm} · {lawyer.specialty}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-semibold text-amber-600">★ {lawyer.rating}</span>
                      <span className="text-[10px] text-gray-400">{lawyer.cases} cases</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="py-1.5 px-3 border border-gray-200 text-xs font-medium text-gray-600 rounded-lg">View Profile</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
