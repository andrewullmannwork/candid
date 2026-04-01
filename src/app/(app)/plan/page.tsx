"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import type { PlanAnalysisResult, AnalyzedBenefit } from "@/lib/plan/analyzer";
import type { BenefitCategory } from "@/lib/plan/benefits-catalog";
import { BENEFIT_CATEGORY_LABELS } from "@/lib/plan/benefits-catalog";

const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  office_visit: "Office Visits",
  emergency: "Emergency",
  hospital: "Hospital",
  imaging: "Imaging",
  lab: "Lab & Testing",
  rx: "Prescriptions",
  therapy: "Therapy & Rehab",
  mental_health: "Mental Health",
  maternity: "Maternity",
  dme: "Equipment & Supplies",
  preventive: "Preventive Care",
  other: "Other Services",
  general: "General",
};

// ── Extended API response type ─────────────────────────────────────────────────

interface AnalyzeResponse extends PlanAnalysisResult {
  dataSource: "user_plan" | "matched_plan" | "cms_api" | "verified_plan" | "static_catalog";
  planName?: string;
  insurer?: string;
  planType?: string;
  planSummary?: {
    inDeductible?: number;
    outDeductible?: number;
    inOopMax?: number;
    outOopMax?: number;
    planType?: string;
    metalLevel?: string;
    verificationStatus?: string;
  };
}

// ── SVG icon paths for each benefit category ───────────────────────────────────

const CATEGORY_ICONS: Record<BenefitCategory, { path: string; color: string }> = {
  preventive_care: {
    path: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
    color: "text-blue-600 bg-blue-50",
  },
  mental_health: {
    path: "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
    color: "text-purple-600 bg-purple-50",
  },
  nutrition: {
    path: "M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3",
    color: "text-green-600 bg-green-50",
  },
  physical_therapy: {
    path: "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z",
    color: "text-orange-600 bg-orange-50",
  },
  hsa_fsa: {
    path: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    color: "text-emerald-600 bg-emerald-50",
  },
  telehealth: {
    path: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
    color: "text-cyan-600 bg-cyan-50",
  },
  chronic_care: {
    path: "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z",
    color: "text-rose-600 bg-rose-50",
  },
  wellness: {
    path: "M13 10V3L4 14h7v7l9-11h-7z",
    color: "text-amber-600 bg-amber-50",
  },
  maternity: {
    path: "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
    color: "text-pink-600 bg-pink-50",
  },
  vision_dental: {
    path: "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z",
    color: "text-indigo-600 bg-indigo-50",
  },
};

// Fallback icon for categories not in the map
const DEFAULT_ICON = {
  path: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  color: "text-gray-600 bg-gray-50",
};

// Extended icons for service_catalog categories
const EXTENDED_CATEGORY_ICONS: Record<string, { path: string; color: string }> = {
  office_visit: { path: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4", color: "text-blue-600 bg-blue-50" },
  hospital: { path: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4", color: "text-red-600 bg-red-50" },
  emergency: { path: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z", color: "text-red-600 bg-red-50" },
  imaging: { path: "M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M15 13a3 3 0 11-6 0 3 3 0 016 0z", color: "text-violet-600 bg-violet-50" },
  lab: { path: "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z", color: "text-teal-600 bg-teal-50" },
  rx: { path: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01", color: "text-emerald-600 bg-emerald-50" },
  therapy: { path: "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z", color: "text-orange-600 bg-orange-50" },
  dme: { path: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z", color: "text-amber-600 bg-amber-50" },
  preventive: { path: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z", color: "text-blue-600 bg-blue-50" },
  other: DEFAULT_ICON,
  general: DEFAULT_ICON,
};

function CategoryIcon({ category }: { category: string }) {
  const icon = CATEGORY_ICONS[category as BenefitCategory]
    || EXTENDED_CATEGORY_ICONS[category]
    || DEFAULT_ICON;
  return (
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${icon.color}`}>
      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d={icon.path} />
      </svg>
    </div>
  );
}

// ── Data Source Banner ──────────────────────────────────────────────────────────

function DataSourceBanner({ dataSource, planName, planType, insurer, verificationStatus }: {
  dataSource: string;
  planName?: string;
  planType?: string;
  insurer?: string;
  verificationStatus?: string;
}) {
  if (dataSource === "user_plan") {
    // Unverified (from card scan or manual entry) → amber with SBC upload CTA
    if (verificationStatus === "unverified") {
      return (
        <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              Based on your insurance card
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              We extracted what we could from your card, but coverage details may be incomplete.
              Upload your Summary of Benefits (SBC) for verified, plan-specific coverage.
            </p>
            <Link
              href="/upload"
              className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Upload your SBC
            </Link>
          </div>
        </div>
      );
    }

    // Verified (from uploaded SBC/plan doc) → green
    return (
      <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-green-900">
            Based on your uploaded {planName || "plan"} documents
          </p>
          <p className="text-xs text-green-700 mt-0.5">
            These benefits reflect the actual coverage details extracted from your plan documents.
          </p>
        </div>
      </div>
    );
  }

  if (dataSource === "matched_plan" || dataSource === "cms_api") {
    return (
      <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-blue-900">
            Based on your {planName || "matched plan"} plan data
          </p>
          <p className="text-xs text-blue-700 mt-0.5">
            Matched from marketplace plan data. Upload your SBC for the most accurate results.
          </p>
        </div>
      </div>
    );
  }

  if (dataSource === "verified_plan") {
    return (
      <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-amber-900">
            Based on a similar {insurer || "insurer"} plan
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            We matched you to a similar plan from your insurer, but your specific coverage may differ.{" "}
            <Link href="/upload" className="font-semibold text-amber-800 hover:text-amber-900 underline">
              Upload your SBC
            </Link>{" "}
            for exact coverage details.
          </p>
        </div>
      </div>
    );
  }

  // static_catalog — most prominent warning
  return (
    <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-900">
            We don&apos;t have your specific plan on file
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            These are general benefits typical of {planType || "most"} plans.
            Your actual coverage may be different. For results specific to your plan, upload your Summary of Benefits and Coverage (SBC).
          </p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload your SBC
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Plan Summary Card ──────────────────────────────────────────────────────────

function PlanSummaryCard({ planName, planSummary, dataSource }: {
  planName?: string;
  planSummary?: AnalyzeResponse["planSummary"];
  dataSource: string;
}) {
  if (!planSummary || dataSource === "static_catalog") return null;

  const verificationLabels: Record<string, string> = {
    unverified: "Unverified",
    user_confirmed: "User confirmed",
    cms_matched: "CMS matched",
    multi_user_verified: "Verified",
  };

  return (
    <div className="mt-4 p-4 bg-white border border-gray-200 rounded-xl">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          {planName || "Your Plan"}
          {planSummary.planType && (
            <span className="ml-2 text-xs font-medium text-gray-500">
              {planSummary.planType}
              {planSummary.metalLevel && ` / ${planSummary.metalLevel}`}
            </span>
          )}
        </h3>
        {planSummary.verificationStatus && (
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            planSummary.verificationStatus === "unverified"
              ? "bg-amber-50 text-amber-700"
              : "bg-green-50 text-green-700"
          }`}>
            {verificationLabels[planSummary.verificationStatus] || planSummary.verificationStatus}
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Deductible (in-network)</p>
          <p className="text-sm font-medium text-gray-900">
            {planSummary.inDeductible != null
              ? `$${planSummary.inDeductible.toLocaleString()}`
              : <span className="text-gray-300">Upload SBC</span>}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Deductible (out-of-network)</p>
          <p className="text-sm font-medium text-gray-900">
            {planSummary.outDeductible != null
              ? `$${planSummary.outDeductible.toLocaleString()}`
              : <span className="text-gray-300">&mdash;</span>}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">OOP Max (in-network)</p>
          <p className="text-sm font-medium text-gray-900">
            {planSummary.inOopMax != null
              ? `$${planSummary.inOopMax.toLocaleString()}`
              : <span className="text-gray-300">Upload SBC</span>}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">OOP Max (out-of-network)</p>
          <p className="text-sm font-medium text-gray-900">
            {planSummary.outOopMax != null
              ? `$${planSummary.outOopMax.toLocaleString()}`
              : <span className="text-gray-300">&mdash;</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function CandidPlanPage() {
  const { user } = useAuth();
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Auto-expand benefit from URL hash (e.g. /plan#benefit-id)
  const [expandedBenefit, setExpandedBenefit] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.slice(1);
    return hash || null;
  });
  const [usedBenefits, setUsedBenefits] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("candid_used_benefits");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  function toggleBenefit(id: string) {
    setUsedBenefits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("candid_used_benefits", JSON.stringify([...next]));
      return next;
    });
  }

  useEffect(() => {
    if (!user) return;

    async function analyze() {
      try {
        const res = await fetch("/api/plan/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user!.userId }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to analyze plan");
        }

        const data: AnalyzeResponse = await res.json();
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLoading(false);
      }
    }

    analyze();
  }, [user]);

  if (loading) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900">Your Benefits</h1>
        <p className="mt-2 text-gray-500">Analyzing your insurance benefits...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900">Your Benefits</h1>
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
          <p className="text-yellow-800">{error}</p>
          <Link
            href="/profile"
            className="mt-2 inline-block text-blue-600 hover:text-blue-700 font-medium"
          >
            Complete your profile →
          </Link>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const isGeneric = result.dataSource === "static_catalog";

  // Group benefits by category
  const grouped = new Map<string, AnalyzedBenefit[]>();
  for (const item of result.benefits) {
    const cat = item.benefit.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  const totalUsed = result.benefits.filter((b) => usedBenefits.has(b.benefit.id)).length;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">Your Benefits</h1>
      <p className="mt-2 text-gray-600">
        {isGeneric
          ? `General benefits available with most ${result.planType || ""} plans \u2014 not specific to your plan.`
          : result.planName
            ? `Benefits your ${result.planName} plan covers. Check off what you\u2019re using.`
            : "Benefits your insurance plan covers. Check off what you\u2019re using to track your progress."
        }
      </p>

      {/* Data source transparency banner */}
      <DataSourceBanner
        dataSource={result.dataSource}
        planName={result.planName}
        planType={result.planType}
        insurer={result.insurer}
        verificationStatus={result.planSummary?.verificationStatus}
      />

      {/* Plan summary card (only for matched/uploaded plans) */}
      <PlanSummaryCard
        planName={result.planName}
        planSummary={result.planSummary}
        dataSource={result.dataSource}
      />

      {/* Profile completeness — contextual, non-blocking */}
      {!result.profileComplete && result.missingFields.length > 0 && (
        <div className="mt-4 p-4 bg-blue-50 border border-blue-100 rounded-xl flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-900">Results are partially personalized</p>
            <p className="text-sm text-blue-700 mt-0.5">
              Add your{" "}
              <span className="font-medium">
                {result.missingFields.slice(0, 2).join(" and ")}
                {result.missingFields.length > 2 ? ` +${result.missingFields.length - 2} more` : ""}
              </span>{" "}
              to see benefits specific to your plan — not just your plan type.
            </p>
            <Link
              href="/profile"
              className="inline-flex items-center gap-1 mt-2 text-sm font-semibold text-blue-600 hover:text-blue-800 transition-colors"
            >
              Complete your profile
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      )}

      {/* Overall progress */}
      <div className="mt-6 p-5 bg-white border border-gray-100 rounded-2xl">
        <div className="flex items-center gap-5">
          <div className="relative w-20 h-20 shrink-0">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" fill="none" stroke="#f1f5f9" strokeWidth="6" />
              <circle
                cx="40" cy="40" r="34" fill="none" stroke="#22c55e" strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${Math.round((totalUsed / Math.max(result.totalBenefits, 1)) * 213.6)} 213.6`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-bold text-gray-900">{totalUsed}/{result.totalBenefits}</span>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {totalUsed === 0
                ? "Start checking off benefits you use"
                : totalUsed < result.totalBenefits / 2
                  ? "Good start \u2014 keep discovering"
                  : totalUsed < result.totalBenefits
                    ? "You\u2019re getting great value"
                    : "You\u2019re maximizing your plan!"}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Check off benefits as you use them to track how much value you&apos;re getting from your plan.
            </p>
          </div>
        </div>
      </div>

      {/* HSA/FSA callout */}
      {result.benefits.some((b) => b.benefit.hsaFsaEligible) && (
        <div className="mt-4 p-3 bg-purple-50 border border-purple-100 rounded-xl">
          <p className="text-sm text-purple-800">
            Benefits marked with <span className="font-semibold">HSA/FSA</span> can be paid
            with your health savings or flexible spending account.
          </p>
        </div>
      )}

      {/* Benefits by category */}
      <div className="mt-6 space-y-4">
        {Array.from(grouped.entries()).map(([category, benefits]) => {
          const usedInCategory = benefits.filter((b) => usedBenefits.has(b.benefit.id)).length;
          return (
            <div key={category} className="border border-gray-100 rounded-2xl overflow-hidden">
              {/* Category header with progress */}
              <div className="flex items-center justify-between p-4 bg-gray-50/50">
                <div className="flex items-center gap-3">
                  <CategoryIcon category={category} />
                  <span className="font-semibold text-gray-900">
                    {BENEFIT_CATEGORY_LABELS[category as BenefitCategory] || SERVICE_CATEGORY_LABELS[category] || category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${usedInCategory === benefits.length ? "text-green-600" : "text-gray-400"}`}>
                    {usedInCategory}/{benefits.length}
                  </span>
                  <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${(usedInCategory / benefits.length) * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Benefits list */}
              <div className="divide-y divide-gray-50">
                {benefits.map((rawItem) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const item = rawItem as any; // Extended fields: costSharing, visitLimit, priorAuthRequired, covered
                  const isUsed = usedBenefits.has(item.benefit.id);
                  const isExpanded = expandedBenefit === item.benefit.id;
                  return (
                    <div key={item.benefit.id} className={`transition-colors ${isUsed ? "bg-green-50/30" : "bg-white"}`}>
                      <div className="flex items-start gap-3 p-4">
                        {/* Checkbox */}
                        <button
                          onClick={() => toggleBenefit(item.benefit.id)}
                          className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                            isUsed ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-blue-400"
                          }`}
                        >
                          {isUsed && (
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>

                        {/* Content — clickable to expand */}
                        <button
                          onClick={() => setExpandedBenefit(isExpanded ? null : item.benefit.id)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <h4 className={`font-medium ${isUsed ? "text-green-800" : "text-gray-900"}`}>
                                {item.benefit.title}
                                {isGeneric && (
                                  <span className="ml-2 text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                                    estimated
                                  </span>
                                )}
                              </h4>
                              <p className="mt-0.5 text-sm text-gray-500 line-clamp-2">
                                {item.benefit.description}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {item.benefit.hsaFsaEligible && (
                                <span className="text-[10px] font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                                  HSA/FSA
                                </span>
                              )}
                              <svg
                                className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                fill="none" stroke="currentColor" viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>
                        </button>
                      </div>

                      {/* Expanded: rich benefit details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pl-12 space-y-3">
                          {/* Cost details grid — show when we have real cost data */}
                          {item.costSharing && (
                            <div className="grid grid-cols-2 gap-3 p-3 bg-gray-50 rounded-xl">
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">In-Network</p>
                                <p className="text-sm font-medium text-gray-900 mt-0.5">
                                  {item.costSharing.inNetwork?.costDescription || "Covered"}
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Out-of-Network</p>
                                <p className="text-sm font-medium text-gray-900 mt-0.5">
                                  {item.costSharing.outOfNetwork?.costDescription || <span className="text-gray-300">&mdash;</span>}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Badges — visit limits, prior auth, coverage status */}
                          <div className="flex flex-wrap gap-2">
                            {item.visitLimit && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium bg-blue-50 text-blue-700 px-2 py-1 rounded-lg">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {item.visitLimit}
                              </span>
                            )}
                            {item.priorAuthRequired && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-700 px-2 py-1 rounded-lg">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                </svg>
                                Prior auth required
                              </span>
                            )}
                            {item.covered === false && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium bg-red-50 text-red-700 px-2 py-1 rounded-lg">
                                Not covered
                              </span>
                            )}
                          </div>

                          {/* Relevance note (when no cost grid — for generic benefits) */}
                          {!item.costSharing && item.relevanceNote && (
                            <div className="p-3 bg-blue-50 rounded-xl">
                              <p className="text-sm text-blue-800">
                                <span className="font-medium">For your plan:</span>{" "}
                                {item.relevanceNote}
                              </p>
                            </div>
                          )}

                          {item.benefit.howToAccess && (
                            <div>
                              <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                How to access this benefit
                              </h5>
                              <p className="mt-1 text-sm text-gray-600">
                                {item.benefit.howToAccess}
                              </p>
                            </div>
                          )}

                          {item.benefit.whyUnderutilized && (
                            <div>
                              <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                Why people miss this
                              </h5>
                              <p className="mt-1 text-sm text-gray-600">
                                {item.benefit.whyUnderutilized}
                              </p>
                            </div>
                          )}

                          <div className="pt-1">
                            <p className="text-xs text-gray-400">
                              {isGeneric
                                ? "This is a general benefit estimate. Upload your plan documents to see if your specific plan covers this."
                                : "Contact your insurer or check your plan documents to confirm this benefit is included in your specific plan."
                              }
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
