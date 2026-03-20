"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import type { PlanAnalysisResult, AnalyzedBenefit } from "@/lib/plan/analyzer";
import type { BenefitCategory } from "@/lib/plan/benefits-catalog";
import { BENEFIT_CATEGORY_LABELS } from "@/lib/plan/benefits-catalog";

const CATEGORY_ICONS: Record<BenefitCategory, string> = {
  preventive_care: "🩺",
  mental_health: "🧠",
  nutrition: "🥗",
  physical_therapy: "💪",
  hsa_fsa: "💰",
  telehealth: "📱",
  chronic_care: "❤️‍🩹",
  wellness: "🏃",
  maternity: "👶",
  vision_dental: "👁️",
};

export default function CandidPlanPage() {
  const { user } = useAuth();
  const [result, setResult] = useState<PlanAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [expandedBenefit, setExpandedBenefit] = useState<string | null>(null);

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

        const data: PlanAnalysisResult = await res.json();
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
        <h1 className="text-2xl font-bold text-gray-900">Candid Plan</h1>
        <p className="mt-2 text-gray-500">Analyzing your insurance benefits...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900">Candid Plan</h1>
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
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

  // Group benefits by category
  const grouped = new Map<BenefitCategory, AnalyzedBenefit[]>();
  for (const item of result.benefits) {
    const cat = item.benefit.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">Candid Plan</h1>
      <p className="mt-2 text-gray-600">
        Benefits your insurance plan likely offers that you may not be using.
      </p>

      {/* Profile completeness warning */}
      {!result.profileComplete && (
        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-yellow-800 text-sm">
            Your profile is missing: <strong>{result.missingFields.join(", ")}</strong>.
            Complete your{" "}
            <Link href="/profile" className="text-blue-600 hover:text-blue-700 underline">
              profile
            </Link>{" "}
            for more personalized results.
          </p>
        </div>
      )}

      {/* Summary cards */}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <div className="text-3xl font-bold text-blue-700">{result.totalBenefits}</div>
          <div className="text-sm text-blue-600">Benefits identified</div>
        </div>
        <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
          <div className="text-3xl font-bold text-green-700">
            {Object.keys(result.categoryCounts).length}
          </div>
          <div className="text-sm text-green-600">Benefit categories</div>
        </div>
      </div>

      {/* HSA/FSA callout */}
      {result.benefits.some((b) => b.benefit.hsaFsaEligible) && (
        <div className="mt-4 p-3 bg-purple-50 border border-purple-100 rounded-lg">
          <p className="text-sm text-purple-800">
            💰 Benefits marked with <span className="font-medium">HSA/FSA</span> can be paid
            with your health savings or flexible spending account.
          </p>
        </div>
      )}

      {/* Benefits by category */}
      <div className="mt-6 space-y-3">
        {Array.from(grouped.entries()).map(([category, benefits]) => (
          <div key={category} className="border rounded-lg overflow-hidden">
            {/* Category header */}
            <button
              onClick={() =>
                setExpandedCategory(expandedCategory === category ? null : category)
              }
              className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">{CATEGORY_ICONS[category]}</span>
                <span className="font-semibold text-gray-900">
                  {BENEFIT_CATEGORY_LABELS[category]}
                </span>
                <span className="text-sm text-gray-500">
                  ({benefits.length} benefit{benefits.length !== 1 ? "s" : ""})
                </span>
              </div>
              <svg
                className={`w-5 h-5 text-gray-400 transition-transform ${
                  expandedCategory === category ? "rotate-180" : ""
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {/* Benefits list */}
            {expandedCategory === category && (
              <div className="divide-y">
                {benefits.map((item) => (
                  <div key={item.benefit.id} className="p-4">
                    <button
                      onClick={() =>
                        setExpandedBenefit(
                          expandedBenefit === item.benefit.id ? null : item.benefit.id
                        )
                      }
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-medium text-gray-900">{item.benefit.title}</h4>
                          <p className="mt-1 text-sm text-gray-600">
                            {item.benefit.description}
                          </p>
                        </div>
                        {item.benefit.hsaFsaEligible && (
                          <span className="ml-3 shrink-0 text-xs font-medium bg-purple-100 text-purple-700 px-2 py-1 rounded">
                            HSA/FSA
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded details */}
                    {expandedBenefit === item.benefit.id && (
                      <div className="mt-3 space-y-3 pl-0">
                        {item.relevanceNote && (
                          <div className="p-3 bg-blue-50 rounded-lg">
                            <p className="text-sm text-blue-800">
                              <span className="font-medium">For your plan:</span>{" "}
                              {item.relevanceNote}
                            </p>
                          </div>
                        )}
                        <div>
                          <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            Why people miss this
                          </h5>
                          <p className="mt-1 text-sm text-gray-600">
                            {item.benefit.whyUnderutilized}
                          </p>
                        </div>
                        <div>
                          <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            How to access
                          </h5>
                          <p className="mt-1 text-sm text-gray-600">
                            {item.benefit.howToAccess}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Disclaimer */}
      <div className="mt-8 p-4 bg-gray-50 border rounded-lg">
        <h3 className="text-sm font-semibold text-gray-700">Important Notice</h3>
        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          Candid Plan provides general information about benefits commonly available with your
          type of insurance plan. This is not a guarantee of coverage. Actual benefits vary by
          specific plan, employer, and state. Always contact your insurance company to verify
          your specific benefits before seeking services. Candid does not provide insurance
          advice, and this information does not constitute a recommendation to obtain any
          particular service or treatment. Candid is an Airgetlam Labs LLC company.
        </p>
      </div>
    </div>
  );
}
