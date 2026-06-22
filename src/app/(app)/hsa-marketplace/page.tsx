"use client";

import { useState } from "react";
import Link from "next/link";
import { LockedOverlay } from "@/components/shared/LockedOverlay";
import { HsaPartnerSignupForm } from "@/components/marketing/HsaPartnerSignupForm";

/**
 * Candid HSA marketplace — B-LAND.1 / S130 alpha coming-soon stub.
 *
 * Full UI built per s112-full-refresh hsa-marketplace.jsx design so the
 * B3-HSA.2 main session post-OPS.8 counsel review just needs to remove the
 * <LockedOverlay> wrapper + wire mock data to real `/api/plan/analyze`
 * HSA-flagged benefits.
 *
 * NON-NEGOTIABLE preservation per Subplan §1.C.5:
 * - NO partner branding visible pre-OPS.8 (default tab="plan" ensures
 *   partner names only mount in DOM client-side when user toggles to
 *   marketplace tab — blocked by overlay; SSR never renders partners).
 * - NO affiliate disclosure copy visible pre-OPS.8 (same gate).
 * - `hsa_affiliate_disclosure_v1` flag stays OFF until counsel cleared.
 */
export default function HsaMarketplacePage() {
  return (
    <LockedOverlay
      title="Candid HSA"
      tone="hsa"
      icon={
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
      }
      description="Pre-tax money, fully used. Find HSA / FSA-eligible benefits in your plan, and shop a curated marketplace of products that qualify — from telehealth to vision to therapy."
      bullets={[
        "Every HSA / FSA-eligible benefit in your plan, surfaced",
        "Curated marketplace of HSA-qualifying products + services",
        "Eligibility check baked in — no guessing",
      ]}
      ctaLabel="Upload a bill"
      ctaHref="/upload"
      secondaryCtaLabel="Dashboard"
      secondaryCtaHref="/dashboard"
      extraSlot={<HsaPartnerSignupForm />}
      fineprint="HSA / FSA eligibility depends on your specific account administrator. Always confirm with your account provider before purchasing. Candid does not sell or fulfill orders."
      closable
      closeHref="/plan"
    >
      <HsaMarketplaceBackdrop />
    </LockedOverlay>
  );
}

/**
 * Backdrop rendered behind the Coming Soon overlay (blurred + dimmed via
 * LockedOverlay wrapper). Default tab="plan" — Marketplace tab content
 * only mounts in DOM when toggled, which is blocked by the overlay
 * pointer-events-none gate. Pre-OPS.8 = zero partner exposure on the wire.
 */
function HsaMarketplaceBackdrop() {
  const [tab, setTab] = useState<"plan" | "market">("plan");

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/plan" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to benefits
      </Link>

      {/* Hero */}
      <div className="mb-6 p-6 sm:p-8 bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-100 rounded-2xl flex items-start gap-4">
        <div className="shrink-0 w-12 h-12 bg-white rounded-xl flex items-center justify-center text-rose-500 shadow-sm">
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
            <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
            <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold text-rose-600 uppercase tracking-[0.15em] mb-1">HSA / FSA</p>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Pre-tax money, fully used.</h1>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">
            9 benefits in your plan are HSA / FSA eligible — pay for them with pre-tax dollars
            and keep up to <strong>32% more</strong> in your pocket. Plus, shop a curated
            marketplace of products that qualify.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 p-1 bg-gray-100 rounded-xl w-fit">
        <button
          onClick={() => setTab("plan")}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
            tab === "plan" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          In your plan
          <span className="inline-flex items-center justify-center min-w-[18px] px-1 h-[18px] text-[10px] font-bold rounded-full bg-rose-100 text-rose-700">9</span>
        </button>
        <button
          onClick={() => setTab("market")}
          className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
            tab === "market" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Marketplace
          <span className="inline-flex items-center justify-center min-w-[18px] px-1 h-[18px] text-[10px] font-bold rounded-full bg-gray-200 text-gray-600">6</span>
        </button>
      </div>

      {tab === "plan" && <InPlanList />}
      {tab === "market" && <MarketplaceGrid />}
    </div>
  );
}

function InPlanList() {
  const benefits = [
    { name: "Telehealth Visit", detail: "In-network: $0 copay through MDLIVE.", category: "Office Visits", source: "Open Access Plus SBC · p.3", catBg: "bg-blue-50", catFg: "text-blue-600", iconD: "M3 12h2l2-5 4 10 2-5h8" },
    { name: "Occupational Therapy", detail: "In-network: $40 per visit copay, up to 30 visits/year.", category: "Therapy & Rehab", source: "Open Access Plus SBC · p.5", catBg: "bg-orange-50", catFg: "text-orange-600", iconD: "M13 7h8m-8 5h8m-8 5h8M3 17l3-3-3-3m0-2l3-3-3-3" },
    { name: "Physical Therapy", detail: "In-network: $40 per visit copay, up to 30 visits/year.", category: "Therapy & Rehab", source: "Open Access Plus SBC · p.5", catBg: "bg-orange-50", catFg: "text-orange-600", iconD: "M13 7h8m-8 5h8m-8 5h8M3 17l3-3-3-3m0-2l3-3-3-3" },
    { name: "Acupuncture", detail: "Covered up to 20 visits/year at in-network rate.", category: "Therapy & Rehab", source: "Corroborated across similar Cigna plans", catBg: "bg-orange-50", catFg: "text-orange-600", iconD: "M13 7h8m-8 5h8m-8 5h8M3 17l3-3-3-3m0-2l3-3-3-3" },
    { name: "Chiropractic Visit", detail: "In-network: $40 per visit, up to 20 visits/year.", category: "Therapy & Rehab", source: "Open Access Plus SBC · p.5", catBg: "bg-orange-50", catFg: "text-orange-600", iconD: "M13 7h8m-8 5h8m-8 5h8M3 17l3-3-3-3m0-2l3-3-3-3" },
    { name: "Vision Exam", detail: "Annual exam covered at $0 copay.", category: "Vision", source: "Open Access Plus SBC · p.7", catBg: "bg-purple-50", catFg: "text-purple-600", iconD: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 100-6 3 3 0 000 6z" },
  ];

  return (
    <div className="space-y-2">
      {benefits.map((b, i) => (
        <button key={i} className="w-full flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-2xl text-left hover:border-gray-300 transition-colors">
          <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${b.catBg} ${b.catFg}`}>
            <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d={b.iconD} />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{b.name}</span>
              <span className="text-[10px] font-bold text-purple-700 bg-purple-50 border border-purple-100 px-1.5 py-0.5 rounded">HSA/FSA</span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500 leading-relaxed">{b.detail}</p>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 uppercase tracking-wider">
              <span className="font-semibold">{b.category}</span>
              <span className="normal-case tracking-normal text-gray-400 italic">From {b.source}</span>
            </div>
          </div>
          <svg className="shrink-0 text-gray-400" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      ))}

      <div className="mt-3 p-3 text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-xl leading-relaxed">
        We surface every covered benefit in your plan that&apos;s HSA / FSA eligible. More benefits
        coming as you upload more plan documents.
      </div>
    </div>
  );
}

function MarketplaceGrid() {
  // Marketplace partner data — mounted only when tab="market". Default tab
  // is "plan" so SSR never includes partner names. Tab toggle blocked by
  // overlay pre-OPS.8 counsel review (NON-NEGOTIABLE per Subplan §1.C.5).
  const products = [
    { cat: "Telehealth", name: "MDLIVE virtual visits", price: "$0 with your plan", note: "Use your HSA for visits outside Cigna's network too.", verified: true },
    { cat: "Therapy", name: "Talkspace mental-health therapy", price: "$65–$99 / session", note: "FSA-eligible. Many Cigna PPO plans reimburse a portion.", verified: false },
    { cat: "Vision", name: "Warby Parker prescription glasses", price: "From $95", note: "Frames + lenses are HSA/FSA-eligible.", verified: true },
    { cat: "Sleep", name: "Lofta sleep apnea CPAP & home test", price: "From $189", note: "100% HSA-eligible with a prescription.", verified: true },
    { cat: "Fitness", name: "Whoop fitness tracker", price: "$30 / month", note: "Eligible with a Letter of Medical Necessity.", verified: false },
    { cat: "Skincare", name: "EltaMD UV Clear sunscreen", price: "$41 / tube", note: "FSA-eligible (sun protection is qualified medical).", verified: true },
  ];

  return (
    <div>
      <div className="mb-4 p-4 bg-rose-50/50 border border-rose-100 rounded-xl">
        <span className="inline-block text-[10px] font-bold text-rose-700 bg-rose-100 px-2 py-0.5 rounded uppercase tracking-wider mb-2">
          Marketplace preview
        </span>
        <p className="text-xs text-gray-600 leading-relaxed">
          Curated products and services that qualify for HSA / FSA spending. Powered by partners —
          Candid earns a small affiliate fee to keep the platform free, never priced into what you pay.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {products.map((p, i) => (
          <button key={i} className="text-left bg-white border border-gray-200 rounded-2xl overflow-hidden hover:border-gray-300 transition-colors">
            <div className="h-24 bg-gradient-to-br from-rose-50 to-pink-50 flex items-center justify-center">
              <span className="text-3xl font-bold text-rose-300">{p.cat[0]}</span>
            </div>
            <div className="p-4">
              <div className="text-[10px] font-bold text-rose-600 uppercase tracking-wider mb-1">{p.cat}</div>
              <div className="text-sm font-semibold text-gray-900">{p.name}</div>
              <div className="mt-1 text-sm font-bold text-gray-900">{p.price}</div>
              <p className="mt-1 text-xs text-gray-500 leading-relaxed">{p.note}</p>
              <div className="mt-3">
                {p.verified ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
                    <svg width={9} height={9} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    HSA verified
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Likely eligible
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-4 p-3 text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-xl leading-relaxed">
        <strong className="text-gray-700">Disclaimer:</strong> HSA / FSA eligibility depends on your specific account
        administrator. Always confirm with your account provider before purchasing. Candid does not sell or fulfill
        orders — we link to partner stores who do.
      </div>
    </div>
  );
}
