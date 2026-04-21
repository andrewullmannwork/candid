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

  // ── Placeholder (Coming Soon) ───────────────────────────────────────────
  return (
    <LockedOverlay
      title="Candid Care — Coming Soon"
      description="Real price transparency powered by real billing data. Upload bills now to help build the dataset — the more bills from your plan, the sharper the comparisons."
      ctaLabel="Upload a bill"
      ctaHref="/upload"
      tone="coming_soon"
    >
      <SampleCarePreview />
    </LockedOverlay>
  );
}

/**
 * Populated-looking Candid Care page rendered behind the Coming Soon overlay,
 * so users see what the feature will do once it's live for their region.
 */
function SampleCarePreview() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Candid Care</h1>
        <p className="mt-1 text-sm text-gray-500">
          Compare prices, find fair providers, and make informed healthcare decisions.
        </p>
      </div>

      <div className="flex gap-1 mb-4 p-1 bg-gray-100 rounded-xl w-fit">
        <span className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-white text-gray-900 shadow-sm">
          Insured
        </span>
        <span className="px-4 py-1.5 text-xs font-semibold rounded-lg text-gray-500">
          Uninsured / Self-Pay
        </span>
      </div>

      <div className="bg-white border border-gray-100 rounded-xl p-5 mb-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Knee MRI · Seattle, WA
        </p>
        <div className="space-y-3">
          {[
            { name: "Swedish Medical Center", price: 425, reports: 14, quality: "Best value" },
            { name: "Pacific Radiology", price: 680, reports: 9, quality: "Good" },
            { name: "Harbor Imaging", price: 1200, reports: 6, quality: "Above median" },
            { name: "UW Medical Center", price: 2100, reports: 11, quality: "Premium" },
          ].map((p) => (
            <div key={p.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                <p className="text-[11px] text-gray-500">
                  {p.reports} community reports · {p.quality}
                </p>
              </div>
              <p className="text-lg font-bold text-gray-900 tabular-nums">
                ${p.price.toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </div>

      <Disclaimer variant="pricing_care" className="mt-6" />
    </div>
  );
}
