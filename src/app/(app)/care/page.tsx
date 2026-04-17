"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import { PricingSearch } from "@/components/care/PricingSearch";
import { PricingComparisonCard } from "@/components/care/PricingComparisonCard";
import { UninsuredView } from "@/components/care/UninsuredView";
import { Disclaimer } from "@/components/shared/Disclaimer";

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
    <div className="relative min-h-[80vh]">
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
    </div>
  );
}
