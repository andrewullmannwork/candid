"use client";

import Link from "next/link";

export default function CandidClaimPage() {
  return (
    <div className="relative min-h-[80vh]">
      {/* ── Locked overlay ──────────────────────────────────────────────── */}
      <div className="sticky top-[25vh] z-20 flex items-center justify-center" style={{ marginBottom: "-200px" }}>
        <div className="flex flex-col items-center bg-white/95 backdrop-blur-sm border border-gray-200 rounded-2xl shadow-xl px-10 py-8 max-w-md">
          <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900">Candid Claim</h2>
          <span className="mt-1.5 text-[11px] font-semibold text-amber-600 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-100">
            Coming Soon
          </span>
          <p className="mt-3 text-sm text-gray-500 text-center leading-relaxed">
            Dispute letters, documentation aggregation, and a legal marketplace to fight unfair charges.
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

      {/* ── Preview dashboard (non-interactive, visible behind lock) ──── */}
      <div className="pointer-events-none select-none opacity-40">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Candid Claim</h1>
          <p className="mt-1 text-sm text-gray-500">Dispute overcharges, track claims, and connect with legal help.</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-green-600">$2,847</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Total Recovered</p>
            <p className="text-[10px] text-green-600 font-semibold mt-1">Across 3 disputes</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">5</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Active Disputes</p>
            <p className="text-[10px] text-amber-600 font-semibold mt-1">2 awaiting response</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">12</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Letters Generated</p>
            <p className="text-[10px] text-blue-600 font-semibold mt-1">All ERISA-compliant</p>
          </div>
          <div className="p-4 bg-white border border-gray-100 rounded-xl">
            <p className="text-2xl font-bold text-gray-900">89%</p>
            <p className="text-xs font-medium text-gray-500 mt-1">Success Rate</p>
            <p className="text-[10px] text-purple-600 font-semibold mt-1">Candid users avg</p>
          </div>
        </div>

        {/* Active disputes */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Active Disputes</h2>
          <div className="space-y-2">
            {[
              { provider: "Bay Area Medical Center", charge: "$3,200", issue: "Upcoded ER visit (99285 → 99283)", status: "Appeal Filed", statusColor: "text-blue-700 bg-blue-50", date: "Mar 15, 2026", savings: "$1,400" },
              { provider: "Pacific Heights Imaging", charge: "$2,100", issue: "Duplicate MRI charge", status: "Under Review", statusColor: "text-amber-700 bg-amber-50", date: "Mar 8, 2026", savings: "$2,100" },
              { provider: "Golden Gate Lab Services", charge: "$450", issue: "Balance billing — in-network provider", status: "Letter Sent", statusColor: "text-purple-700 bg-purple-50", date: "Mar 1, 2026", savings: "$450" },
              { provider: "Summit Orthopedics", charge: "$890", issue: "Unbundled physical therapy charges", status: "Won — Refund Issued", statusColor: "text-green-700 bg-green-50", date: "Feb 22, 2026", savings: "$890" },
              { provider: "Bay Area Radiology", charge: "$1,750", issue: "Out-of-network billed at in-network facility", status: "Won — Adjusted", statusColor: "text-green-700 bg-green-50", date: "Feb 10, 2026", savings: "$1,750" },
            ].map((d, i) => (
              <div key={i} className="p-4 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{d.provider}</p>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${d.statusColor}`}>{d.status}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{d.issue}</p>
                    <p className="text-[10px] text-gray-400 mt-1">{d.date}</p>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <p className="text-sm font-bold text-gray-900">{d.charge}</p>
                    <p className="text-xs font-semibold text-green-600">−{d.savings}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Dispute letter generator */}
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Generate Dispute Letter</h2>
          <div className="p-5 bg-white border border-gray-100 rounded-xl">
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">Dispute Type</p>
                <div className="p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">Billing Error — Upcoding</div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">Provider</p>
                <div className="p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">Bay Area Medical Center</div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">Date of Service</p>
                <div className="p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">March 12, 2026</div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">Amount Disputed</p>
                <div className="p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">$1,400.00</div>
              </div>
            </div>
            <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg mb-4">
              <p className="text-xs text-blue-700"><span className="font-semibold">Auto-populated:</span> Your plan details, ERISA references, provider contact info, and appeals deadlines are filled in from your uploaded plan documents.</p>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg text-center">Generate Letter</div>
              <div className="py-2.5 px-4 border border-gray-200 text-sm font-medium text-gray-600 rounded-lg text-center">Preview</div>
            </div>
          </div>
        </div>

        {/* Candid Case — legal marketplace */}
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Candid Case — Legal Marketplace</h2>
          <div className="mb-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
            <p className="text-[10px] text-gray-400 leading-relaxed">
              <span className="font-semibold text-gray-500">Disclaimer:</span>{" "}
              Candid does not provide legal advice or referrals. Attorney listings are for informational purposes only.
              No attorney-client relationship is formed through this platform.
            </p>
          </div>
          <div className="space-y-2">
            {[
              { name: "Sarah Chen, Esq.", firm: "Chen Health Law Group", specialty: "Medical billing disputes", rating: 4.9, cases: 234, fee: "$150/mo" },
              { name: "Marcus Williams, JD", firm: "Patient Rights Legal", specialty: "Insurance denials & appeals", rating: 4.8, cases: 189, fee: "$125/mo" },
              { name: "Dr. Lisa Park, JD", firm: "MedJustice Partners", specialty: "Hospital billing errors", rating: 4.7, cases: 156, fee: "$175/mo" },
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
                  <p className="text-sm font-bold text-gray-900">{lawyer.fee}</p>
                  <p className="text-[10px] text-gray-400">flat fee</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
