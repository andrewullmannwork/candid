"use client";

import { useSearchParams } from "next/navigation";
import { LockedOverlay } from "@/components/shared/LockedOverlay";

export default function CandidCasePage() {
  const searchParams = useSearchParams();
  const escalationInsurer = searchParams.get("insurer");
  const escalationService = searchParams.get("service");
  const escalationAmount = searchParams.get("amount");
  // T2.2 v3 (Q-T2.2-7 LOCK): denial_type pre-fill param. Informational only —
  // no algorithmic match per ABA Rule 7.2 + Q-DR-1G1-3 marketplace-not-vetting.
  const escalationDenialType = searchParams.get("denial_type");
  const isSystemic = searchParams.get("systemic") === "true";
  const affectedCount = searchParams.get("affectedCount");
  const hasEscalationContext = escalationInsurer || escalationService || escalationAmount || escalationDenialType;

  return (
    <div>
      {/* Escalation context card (from EscalationCard link, interactive above the lock) */}
      {hasEscalationContext && (
        <div className="mb-4 p-4 bg-purple-50 border border-purple-200 rounded-xl">
          <p className="text-sm font-semibold text-purple-900">Escalating your dispute</p>
          <p className="text-xs text-purple-700 mt-1">
            {escalationInsurer && `Insurer: ${escalationInsurer}`}
            {escalationService && ` · Service: ${escalationService.replace(/_/g, " ")}`}
            {escalationAmount && ` · Amount: $${parseFloat(escalationAmount).toLocaleString()}`}
            {escalationDenialType && ` · Denial type: ${escalationDenialType.replace(/_/g, " ")}`}
          </p>
          {isSystemic && (
            <p className="text-xs text-red-700 mt-1 font-semibold">
              Systemic pattern detected — {affectedCount ? `${affectedCount} members affected` : "multiple members affected"}
            </p>
          )}
          <p className="text-xs text-purple-600 mt-2">
            When Candid Case launches, your dispute context will be pre-filled here.
          </p>
        </div>
      )}

      <LockedOverlay
        title="Candid Case"
        tone="case"
        icon={
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6l3 1m0 0l-3 9a5 5 0 006 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5 5 0 006 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
          </svg>
        }
        description="Build your case. Find your lawyer. Compile audits, dispute letters, and evidence into one downloadable case file — and connect with attorneys who specialize in medical billing disputes."
        bullets={[
          "Downloadable case file (audit + letters + evidence + timeline)",
          "Independent directory of healthcare billing attorneys",
          "Escalation guide for state Insurance Commissioners",
        ]}
        ctaLabel="Upload a bill"
        ctaHref="/upload"
        secondaryCtaLabel="Dashboard"
        secondaryCtaHref="/dashboard"
        fineprint="Candid does not provide legal advice or referrals. Attorney listings will be for informational purposes only. No attorney-client relationship is formed through this platform."
        closable
      >
        <CasePreviewBackdrop />
      </LockedOverlay>
    </div>
  );
}

/**
 * Backdrop rendered behind the Coming Soon overlay (blurred + dimmed via
 * LockedOverlay wrapper). Shows what /case will look like when Candid Case
 * launches. NON-NEGOTIABLE per project_candid_marketplace_not_vetting +
 * ABA Rule 7.2: "independent directory" (NOT "vetted"). Candid never takes
 * per-referral fees.
 */
function CasePreviewBackdrop() {
  const builderItems = [
    { title: "Audit Report", sub: "Line-by-line bill analysis with flagged errors" },
    { title: "Dispute Letters", sub: "Every drafted appeal, organized and signed" },
    { title: "Supporting Evidence", sub: "Benchmark data, CPT references, plan citations" },
    { title: "Timeline", sub: "Chronological record of every billing event" },
    { title: "Escalation Guide", sub: "State commissioner contacts + legal next steps" },
  ];

  const attorneys = [
    { name: "Sarah Chen, Esq.", firm: "Chen Health Law Group", focus: "Medical billing disputes", rating: 4.9, cases: 234, initials: "SC", color: "#0891b2" },
    { name: "Marcus Williams, JD", firm: "Patient Rights Legal", focus: "Insurance denials & appeals", rating: 4.8, cases: 189, initials: "MW", color: "#7e22ce" },
    { name: "Dr. Lisa Park, JD", firm: "Park & Associates", focus: "Hospital billing fraud", rating: 4.9, cases: 156, initials: "LP", color: "#db2777" },
    { name: "Jonathan Pierce, Esq.", firm: "Pierce Healthcare Law", focus: "ERISA appeals & ABA litigation", rating: 4.7, cases: 142, initials: "JP", color: "#059669" },
  ];

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <p className="text-[11px] font-bold text-purple-600 uppercase tracking-[0.15em] mb-1.5">CANDID CASE</p>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Build your case. Find your lawyer.</h1>
        <p className="mt-2 text-sm text-gray-500 leading-relaxed">
          Audits, dispute letters, and supporting evidence compiled into one downloadable case file —
          plus an independent directory of attorneys who specialize in medical billing disputes.
        </p>
      </div>

      {/* Case builder */}
      <div className="mb-6 p-5 bg-white border border-gray-200 rounded-2xl">
        <div className="flex items-start justify-between mb-4 gap-3">
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Case Builder</div>
            <h2 className="text-base font-bold text-gray-900">Your case file</h2>
            <p className="mt-1 text-xs text-gray-500 leading-relaxed">
              Everything Candid has on you, organized into one PDF you can hand to a lawyer or
              your state Insurance Commissioner.
            </p>
          </div>
          <span className="shrink-0 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-0.5 rounded-full">
            5 of 5 sections ready
          </span>
        </div>

        <div className="space-y-2">
          {builderItems.map((it, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <div className="w-5 h-5 rounded-md bg-emerald-500 flex items-center justify-center shrink-0">
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-900">{it.title}</p>
                <p className="text-xs text-gray-500">{it.sub}</p>
              </div>
              <span className="text-[10px] font-semibold text-emerald-700">Included</span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <div className="flex-1 py-2.5 text-center text-sm font-semibold text-white bg-purple-600 rounded-xl">Download Case File (PDF)</div>
          <div className="px-4 py-2.5 text-sm font-medium text-gray-600 border border-gray-200 rounded-xl">Preview</div>
        </div>
      </div>

      {/* Attorney directory */}
      <div className="p-5 bg-white border border-gray-200 rounded-2xl">
        <div className="flex items-start justify-between mb-3 gap-3">
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Attorney Directory</div>
            <h2 className="text-base font-bold text-gray-900">Lawyers who specialize in this</h2>
            <p className="mt-1 text-xs text-gray-500 leading-relaxed">
              An independent directory of medical-billing attorneys near you. Candid never takes
              per-referral fees from anyone listed.
            </p>
          </div>
          <span className="shrink-0 text-[10px] font-semibold text-gray-600 bg-gray-50 border border-gray-200 px-2.5 py-0.5 rounded-full">
            {attorneys.length} attorneys
          </span>
        </div>

        <div className="mb-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
          <p className="text-[10px] text-gray-500 leading-relaxed">
            <strong className="text-gray-600">Disclaimer:</strong> Candid does not provide legal advice
            or referrals. Attorney listings are for informational purposes only. No attorney-client
            relationship is formed through this platform.
          </p>
        </div>

        <div className="space-y-2">
          {attorneys.map((a, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ background: a.color }}>{a.initials}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{a.name}</p>
                <p className="text-xs text-gray-500 truncate">{a.firm} · {a.focus}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-amber-600">
                    <svg width={10} height={10} viewBox="0 0 24 24" fill="#f59e0b"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" /></svg>
                    {a.rating}
                  </span>
                  <span className="text-[10px] text-gray-400">{a.cases} cases</span>
                </div>
              </div>
              <div className="shrink-0 px-3 py-1.5 text-[11px] font-medium text-gray-600 border border-gray-200 rounded-lg">View profile</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
