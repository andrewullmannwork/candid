"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import { PricingSearch } from "@/components/care/PricingSearch";
import { PricingComparisonCard } from "@/components/care/PricingComparisonCard";
import { UninsuredView } from "@/components/care/UninsuredView";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { LockedOverlay } from "@/components/shared/LockedOverlay";

export default function CandidCarePage() {
  const { user } = useAuth();
  const [careLive, setCareLive] = useState(false);
  const [flagLoading, setFlagLoading] = useState(true);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pricingData, setPricingData] = useState<any>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [userState, setUserState] = useState<string | null>(null);
  const [showUninsured, setShowUninsured] = useState(false);

  // Check feature flag
  useEffect(() => {
    const supabase = createBrowserClient();
    supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "candid_care_live")
      .eq("target_type", "global")
      .single()
      .then(({ data }) => {
        setCareLive(data?.enabled === true);
        setFlagLoading(false);
      }, () => setFlagLoading(false));

    // Get user state for region filtering
    if (user) {
      fetch("/api/profile", {
        headers: { Authorization: `Bearer ${user.userId}` },
      })
        .then((r) => r.json())
        .then((d) => setUserState(d.profile?.state || null))
        .catch(() => {});
    }
  }, [user]);

  // Load pricing when service selected
  useEffect(() => {
    if (!selectedService) return;
    async function loadPricing() {
      setPricingLoading(true);
      try {
        const params = new URLSearchParams({ service: selectedService! });
        if (userState) params.set("state", userState);
        const res = await fetch(`/api/care/pricing?${params}`);
        const d = await res.json();
        setPricingData(d.pricing || null);
      } catch {
        // Silent
      }
      setPricingLoading(false);
    }
    loadPricing();
  }, [selectedService, userState]);

  if (flagLoading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Live Care UI (feature-flagged) ──────────────────────────────────────
  if (careLive) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Candid Care</h1>
          <p className="mt-1 text-sm text-gray-500">
            Compare prices, find fair providers, and make informed healthcare decisions.
          </p>
        </div>

        {/* Insured / Uninsured toggle */}
        <div className="flex gap-1 mb-4 p-1 bg-gray-100 rounded-xl w-fit">
          <button
            onClick={() => setShowUninsured(false)}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${!showUninsured ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            Insured
          </button>
          <button
            onClick={() => setShowUninsured(true)}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors ${showUninsured ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            Uninsured / Self-Pay
          </button>
        </div>

        {/* Service search + pricing display */}
        {selectedService && pricingData ? (
          showUninsured ? (
            <UninsuredView
              pricing={pricingData}
              onGenerateLetter={() => {
                // Navigate to negotiation letter generation
                window.location.href = `/disputes?type=negotiation&service=${selectedService}`;
              }}
            />
          ) : (
            <PricingComparisonCard
              pricing={pricingData}
              onBack={() => { setSelectedService(null); setPricingData(null); }}
            />
          )
        ) : pricingLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading pricing data...</div>
        ) : (
          <PricingSearch
            onSelect={(slug) => setSelectedService(slug)}
            state={userState || undefined}
          />
        )}

        {selectedService && pricingData && !showUninsured && (
          <button
            onClick={() => { setSelectedService(null); setPricingData(null); }}
            className="mt-4 text-sm text-blue-600 hover:text-blue-700"
          >
            &larr; Search another service
          </button>
        )}

        <Disclaimer variant="pricing_care" className="mt-6" />
      </div>
    );
  }

  // ── Coming Soon (alpha; flag candid_care_live = OFF) ────────────────────
  return (
    <LockedOverlay
      title="Candid Care"
      tone="care"
      icon={
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 13h2l3-8 4 16 3-8h4" />
        </svg>
      }
      description="Compare what providers near you actually charge — and find fair-priced, in-network care before you book. Powered by what other Candid users have actually paid."
      bullets={[
        "Side-by-side prices for the same procedure, from real bills",
        "Network + plan-coverage check baked in",
        "Community ratings + fair-price benchmarks",
      ]}
      ctaLabel="Upload a bill"
      ctaHref="/upload"
      secondaryCtaLabel="Dashboard"
      secondaryCtaHref="/dashboard"
      fineprint="Care prices will be estimates based on community-corroborated data — not guarantees. Always confirm pricing with the provider before scheduling."
      closable
    >
      <CarePreviewBackdrop />
    </LockedOverlay>
  );
}

/**
 * Backdrop rendered behind the Coming Soon overlay (blurred + dimmed via
 * LockedOverlay wrapper). Shows what /care will look like once the
 * `candid_care_live` flag flips ON post-alpha. Mock data only — no
 * hospital-side revenue paths per AKS hard rule (Stream 3 carve-out in
 * Candid_10k §5).
 */
function CarePreviewBackdrop() {
  const providers = [
    { name: "Northwest Imaging — Ballard", area: "Ballard, Seattle · 1.2 mi", cash: 380, billed: 410, network: true, rating: 4.8, reviews: 312, tag: "Best price", tagTone: "good" as const, initials: "NI", color: "#059669", verdict: "good" as const },
    { name: "Swedish Imaging Center", area: "Capitol Hill · 2.4 mi", cash: 425, billed: 462, network: true, rating: 4.7, reviews: 248, tag: "Most chosen", tagTone: "neutral" as const, initials: "SI", color: "#2563eb", verdict: "good" as const },
    { name: "First Hill Open MRI", area: "First Hill · 3.1 mi", cash: 510, billed: 540, network: true, rating: 4.6, reviews: 189, tag: null, tagTone: null, initials: "FH", color: "#0891b2", verdict: "good" as const },
    { name: "Pacific Medical Imaging", area: "Downtown · 3.6 mi", cash: 720, billed: 920, network: true, rating: 4.4, reviews: 134, tag: "Above community", tagTone: "warn" as const, initials: "PM", color: "#d97706", verdict: "warn" as const },
    { name: "St. Mark's Hospital Imaging", area: "Downtown · 3.9 mi", cash: 1180, billed: 1180, network: false, rating: 4.5, reviews: 421, tag: "Out of network", tagTone: "bad" as const, initials: "SM", color: "#dc2626", verdict: "bad" as const },
  ];

  const verdictColor = (v: "good" | "warn" | "bad") =>
    v === "good" ? "text-emerald-600" : v === "warn" ? "text-amber-600" : "text-red-600";

  const tagColor = (t: "good" | "neutral" | "warn" | "bad" | null) => {
    if (!t) return "";
    return t === "good" ? "bg-emerald-50 text-emerald-700 border-emerald-100"
         : t === "neutral" ? "bg-blue-50 text-blue-700 border-blue-100"
         : t === "warn" ? "bg-amber-50 text-amber-700 border-amber-100"
         : "bg-red-50 text-red-700 border-red-100";
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <p className="text-[11px] font-bold text-teal-600 uppercase tracking-[0.15em] mb-1.5">CANDID CARE</p>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Find fair-priced care near you.</h1>
        <p className="mt-2 text-sm text-gray-500 leading-relaxed">
          Compare what providers in your area actually bill — and what your plan + community pricing
          say is fair — before you book.
        </p>
      </div>

      {/* Procedure search */}
      <div className="mb-5 p-4 bg-white border border-gray-200 rounded-2xl flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[140px]">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Procedure</div>
          <div className="text-sm font-semibold text-gray-900">MRI · Lumbar Spine (CPT 72148)</div>
        </div>
        <div className="flex-1 min-w-[140px]">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Your location</div>
          <div className="text-sm font-semibold text-gray-900">Seattle, WA · 5 mi radius</div>
        </div>
        <div className="flex-1 min-w-[140px]">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Your plan</div>
          <div className="text-sm font-semibold text-gray-900">Cigna Open Access Plus</div>
        </div>
        <div className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl">Search providers</div>
      </div>

      {/* Fair price strip */}
      <div className="mb-5 p-5 bg-gradient-to-br from-teal-50 to-cyan-50 border border-teal-100 rounded-2xl flex flex-col sm:flex-row items-stretch gap-5">
        <div className="shrink-0">
          <div className="text-[10px] font-semibold text-teal-700 uppercase tracking-wider mb-1">Fair price</div>
          <div className="text-3xl font-bold text-gray-900 tabular-nums">$425</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Community-corroborated median</div>
        </div>
        <div className="flex-1 flex flex-col justify-center">
          <div className="relative h-2 rounded-full bg-gradient-to-r from-emerald-200 via-amber-200 to-red-200">
            <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-[12%] w-3 h-3 rounded-full bg-emerald-600 border-2 border-white" />
            <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-[50%] w-3.5 h-3.5 rounded-full bg-teal-700 border-2 border-white" />
            <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-[88%] w-3 h-3 rounded-full bg-red-600 border-2 border-white" />
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mt-2">
            <span>$320 lowest</span>
            <span className="font-semibold text-teal-700">$425 fair</span>
            <span>$1,180 highest</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="px-3 py-1 text-[11px] font-semibold rounded-full bg-teal-600 text-white">All providers <span className="opacity-70">{providers.length}</span></span>
        <span className="px-3 py-1 text-[11px] font-medium rounded-full bg-white border border-gray-200 text-gray-600">In-network <span className="text-gray-400">{providers.filter((p) => p.network).length}</span></span>
        <span className="px-3 py-1 text-[11px] font-medium rounded-full bg-white border border-gray-200 text-gray-600">At or below fair price <span className="text-gray-400">3</span></span>
        <span className="px-3 py-1 text-[11px] font-medium rounded-full bg-white border border-gray-200 text-gray-600">Within 2 mi <span className="text-gray-400">1</span></span>
        <span className="px-3 py-1 text-[11px] font-medium rounded-full bg-white border border-gray-200 text-gray-600">Top rated</span>
      </div>

      {/* Provider list */}
      <div className="space-y-2.5">
        {providers.map((p, i) => (
          <div key={i} className="flex items-center gap-4 p-4 bg-white border border-gray-200 rounded-2xl">
            <div className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-white text-xs font-bold" style={{ background: p.color }}>{p.initials}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-gray-900 truncate">{p.name}</span>
                {p.tag && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${tagColor(p.tagTone)}`}>{p.tag}</span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap">
                <span>{p.area}</span>
                <span className="text-gray-300">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="#f59e0b"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" /></svg>
                  <strong className="text-gray-700">{p.rating}</strong>
                  <span className="text-gray-400">({p.reviews})</span>
                </span>
                <span className="text-gray-300">·</span>
                <span className={p.network ? "text-emerald-600 font-medium" : "text-red-600 font-medium"}>
                  {p.network ? "In-network" : "Out of network"}
                </span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className={`text-lg font-bold tabular-nums ${verdictColor(p.verdict)}`}>${p.cash}</div>
              <div className="text-[10px] text-gray-400">cash price</div>
              <div className="text-[10px] text-gray-400">avg billed ${p.billed}</div>
            </div>
            <div className="shrink-0 px-3 py-1.5 text-[11px] font-medium text-gray-600 border border-gray-200 rounded-lg">Compare</div>
          </div>
        ))}
      </div>

      <div className="mt-5 p-3 text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-xl leading-relaxed">
        <strong className="text-gray-700">Disclaimer:</strong> Prices are estimates based on community-corroborated data
        and may not reflect what you&apos;ll be charged. Always confirm pricing directly with the provider before scheduling.
      </div>
    </div>
  );
}
