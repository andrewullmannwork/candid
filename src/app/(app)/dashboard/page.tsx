"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import type { PlanAnalysisResult, AnalyzedBenefit } from "@/lib/plan/analyzer";
import { BENEFIT_CATEGORY_LABELS } from "@/lib/plan/benefits-catalog";
import type { BenefitCategory } from "@/lib/plan/benefits-catalog";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProfileData {
  insurer: string | null;
  plan_type: string | null;
  plan_name: string | null;
  state: string | null;
  group_number: string | null;
  member_id: string | null;
}

interface DocumentRow {
  id: string;
  file_name: string;
  doc_type: string;
  status: string;
  created_at: string;
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [planResult, setPlanResult] = useState<PlanAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
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

  const usedBenefitsCount = usedBenefits.size;

  useEffect(() => {
    if (!user) return;

    async function loadDashboard() {
      const supabase = createBrowserClient();

      // Load profile, documents, and plan analysis in parallel
      const [profileRes, docsRes, planRes] = await Promise.all([
        fetch("/api/profile", {
          headers: { Authorization: `Bearer ${await user!.firebaseUser.getIdToken()}` },
        }),
        supabase
          .from("documents")
          .select("id, file_name, doc_type, status, created_at")
          .eq("user_id", user!.userId)
          .order("created_at", { ascending: false }),
        fetch("/api/plan/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user!.userId }),
        }).catch(() => null),
      ]);

      if (profileRes.ok) {
        const { profile: p } = await profileRes.json();
        setProfile(p);
      }

      if (docsRes.data) {
        setDocuments(docsRes.data);
      }

      if (planRes && planRes.ok) {
        try {
          setPlanResult(await planRes.json());
        } catch {
          // Plan analysis may fail if profile incomplete
        }
      }

      setLoading(false);
    }

    loadDashboard();
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const profileFields = profile
    ? [profile.insurer, profile.plan_type, profile.state, profile.group_number, profile.member_id, profile.plan_name]
    : [];
  const filledFields = profileFields.filter(Boolean).length;
  const totalFields = 6;
  const profileComplete = filledFields >= 2; // any 2 identifiers is enough
  const hasDocuments = documents.length > 0;
  const pendingReviewDocs = documents.filter((d) => d.status === "pending_review");

  const firstName = user?.firebaseUser.displayName?.split(" ")[0] || "";

  return (
    <div className="space-y-8">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Here&apos;s everything Candid knows about your healthcare.
        </p>
      </div>

      {/* ── Plan verification banner ──────────────────────────────────────── */}
      {planResult && (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = planResult as any;
        const ds = pr.dataSource;
        const vs = pr.planSummary?.verificationStatus;
        const pn = pr.planName;

        if (ds === "user_plan" && vs === "unverified") {
          return (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">
                  {pn || "Your plan"} &mdash; Unverified
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Upload your plan document (SBC) for accurate, verified benefits and audit results.
                </p>
                <Link href="/upload" className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-amber-700 hover:text-amber-900">
                  Upload plan document &rarr;
                </Link>
              </div>
            </div>
          );
        }

        if (ds === "user_plan" && vs !== "unverified") {
          return (
            <div className="p-4 bg-green-50 border border-green-200 rounded-2xl flex items-start gap-3">
              <svg className="w-5 h-5 text-green-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-semibold text-green-900">
                {pn || "Your plan"} &mdash; Verified
              </p>
            </div>
          );
        }

        if (ds === "static_catalog") {
          return (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">No plan on file</p>
                <p className="text-xs text-amber-700 mt-0.5">Upload your insurance card or plan document for personalized results.</p>
                <Link href="/profile" className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-amber-700 hover:text-amber-900">
                  Set up your profile &rarr;
                </Link>
              </div>
            </div>
          );
        }

        return null;
      })()}

      {/* ── Pending review document banner ─────────────────────────────────── */}
      {pendingReviewDocs.length > 0 && (
        <div className="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-amber-900">
              {pendingReviewDocs.length === 1 ? "Your document is being reviewed" : `${pendingReviewDocs.length} documents being reviewed`}
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              We&apos;ll email you when your results are ready &mdash; usually within 24 hours.
            </p>
          </div>
        </div>
      )}

      {/* ── Profile completeness ────────────────────────────────────────────── */}
      {!profileComplete && (
        <div className="p-5 bg-blue-50 border border-blue-100 rounded-2xl flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-900">Complete your profile for better results</p>
            <p className="text-sm text-blue-700 mt-0.5">
              Add your insurance details so we can personalize your audit and surface the right benefits.
              {filledFields > 0 && ` You've filled ${filledFields} of ${totalFields} fields.`}
            </p>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-blue-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all"
                  style={{ width: `${Math.round((filledFields / totalFields) * 100)}%` }}
                />
              </div>
              <Link
                href="/profile"
                className="shrink-0 px-3.5 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors"
              >
                Complete profile
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick Actions — compact upload CTA ────────────────────────────── */}
      {!hasDocuments && (
        <div className="p-4 bg-white border border-gray-100 rounded-2xl flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900">Upload a bill to get started</p>
            <p className="text-xs text-gray-500 mt-0.5">
              We&apos;ll audit it for errors, overcharges, and missed adjustments.
            </p>
          </div>
          <Link
            href="/upload"
            className="shrink-0 px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors"
          >
            Upload
          </Link>
        </div>
      )}

      {/* ── Audit Results Section ───────────────────────────────────────────── */}
      {hasDocuments && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Your documents</h2>
            <Link href="/upload" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
              Upload more
            </Link>
          </div>

          <div className="space-y-2">
            {documents.slice(0, 5).map((doc) => (
              <div key={doc.id} className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                    <p className="text-xs text-gray-400">
                      {doc.doc_type === "eob" ? "EOB" : "Itemized Bill"}
                      {" · "}
                      {new Date(doc.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <StatusBadge status={doc.status} />
              </div>
            ))}
          </div>

          {documents.length > 5 && (
            <p className="mt-3 text-xs text-gray-400 text-center">
              Showing 5 of {documents.length} documents
            </p>
          )}

          {/* Run audit prompt */}
          {documents.some((d) => d.status === "uploaded") && (
            <div className="mt-4 p-4 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-3">
              <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">You have unprocessed documents</p>
                <p className="text-xs text-amber-600">Run an audit to check for billing errors.</p>
              </div>
              <Link
                href="/audit"
                className="shrink-0 px-3.5 py-1.5 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700 transition-colors"
              >
                Run audit
              </Link>
            </div>
          )}
        </section>
      )}

      {/* ── Benefits Section — Category overview with highlights ──────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Your benefits</h2>
          {planResult && planResult.totalBenefits > 0 && (
            <Link href="/plan" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
              View all details
            </Link>
          )}
        </div>

        {planResult && planResult.totalBenefits > 0 ? (
          <>
            {/* Progress + summary row */}
            <div className="p-4 bg-white border border-gray-100 rounded-2xl mb-4">
              <div className="flex items-center gap-4">
                <div className="relative w-14 h-14 shrink-0">
                  <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                    <circle cx="28" cy="28" r="23" fill="none" stroke="#f1f5f9" strokeWidth="5" />
                    <circle
                      cx="28" cy="28" r="23" fill="none" stroke="#3b82f6" strokeWidth="5"
                      strokeLinecap="round"
                      strokeDasharray={`${Math.round((usedBenefitsCount / Math.max(planResult.totalBenefits, 1)) * 144.5)} 144.5`}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-sm font-bold text-gray-900">{usedBenefitsCount}/{planResult.totalBenefits}</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {usedBenefitsCount === 0
                      ? "Start checking off benefits you use"
                      : usedBenefitsCount < planResult.totalBenefits / 2
                        ? "Good start — keep going"
                        : usedBenefitsCount < planResult.totalBenefits
                          ? "You're getting great value"
                          : "You're maximizing your plan!"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {planResult.totalBenefits - usedBenefitsCount} covered benefit{planResult.totalBenefits - usedBenefitsCount !== 1 ? "s" : ""} you may not be using yet.
                    {planResult.benefits.some((b) => b.benefit.hsaFsaEligible) && (
                      <span className="text-purple-600 font-medium"> {planResult.benefits.filter((b) => b.benefit.hsaFsaEligible).length} HSA/FSA eligible.</span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Category summary grid — shows all categories at a glance */}
            {(() => {
              const catMap = new Map<string, { total: number; used: number; topBenefit: string }>();
              for (const item of planResult.benefits) {
                const cat = item.categoryLabel || (BENEFIT_CATEGORY_LABELS[item.benefit.category as BenefitCategory]) || item.benefit.category.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                const prev = catMap.get(cat) || { total: 0, used: 0, topBenefit: item.benefit.title };
                prev.total++;
                if (usedBenefits.has(item.benefit.id)) prev.used++;
                catMap.set(cat, prev);
              }
              return (
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {Array.from(catMap.entries()).map(([cat, { total, used, topBenefit }]) => (
                    <Link
                      key={cat}
                      href="/plan"
                      className="p-3 bg-white border border-gray-100 rounded-xl hover:border-blue-200 hover:bg-blue-50/30 transition-all group"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-gray-700 group-hover:text-blue-700 transition-colors truncate">{cat}</span>
                        <span className={`text-[10px] font-bold ${used === total ? "text-green-500" : "text-gray-400"}`}>{used}/{total}</span>
                      </div>
                      <p className="text-[11px] text-gray-400 truncate">{topBenefit}</p>
                    </Link>
                  ))}
                </div>
              );
            })()}

            <Link
              href="/plan"
              className="block text-center text-xs font-medium text-blue-600 hover:text-blue-700 py-2"
            >
              See all {planResult.totalBenefits} benefits →
            </Link>

            {/* Important Notice */}
            <div className="mt-3 p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <p className="text-[10px] text-gray-400 leading-relaxed">
                <span className="font-semibold text-gray-500">Important Notice:</span>{" "}
                Candid provides general information about benefits commonly available with your type of
                insurance plan. This is not a guarantee of coverage. Actual benefits vary by specific plan,
                employer, and state. Always contact your insurance company to verify your specific benefits
                before seeking services. Candid does not provide insurance advice, and this information does
                not constitute a recommendation to obtain any particular service or treatment. Candid is an
                Airgetlam Labs LLC company.
              </p>
            </div>

            {!planResult.profileComplete && (
              <div className="mt-3 p-3 bg-blue-50 border border-blue-100 rounded-xl">
                <p className="text-xs text-blue-700">
                  <span className="font-semibold">Want more personalized results?</span>{" "}
                  <Link href="/profile" className="underline font-medium">Add your plan details</Link> to see benefits
                  specific to your plan — not just your plan type.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="p-5 bg-white border border-gray-100 rounded-2xl text-center">
            <p className="text-sm text-gray-500">
              {profile?.insurer
                ? "Analyzing your plan..."
                : "Add your insurance details to discover covered benefits you may not be using."}
            </p>
            {!profile?.insurer && (
              <Link
                href="/profile"
                className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                Complete your profile
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            )}
          </div>
        )}
      </section>

      {/* ── Coming Soon Services ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-4">More from Candid</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Candid Claim */}
          <Link href="/claim" className="p-4 bg-gradient-to-br from-gray-50 to-white border border-gray-100 rounded-2xl hover:border-blue-200 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">Candid Claim</h3>
                <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">Coming soon</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Dispute letters, documentation aggregation, and legal marketplace to fight unfair charges.
            </p>
          </Link>

          {/* Candid Care */}
          <Link href="/care" className="p-4 bg-gradient-to-br from-gray-50 to-white border border-gray-100 rounded-2xl hover:border-blue-200 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">Candid Care</h3>
                <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">Coming soon</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Compare what you paid against what others paid. Find fairer prices for procedures near you.
            </p>
            {hasDocuments && (
              <div className="mt-2 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <p className="text-[10px] font-medium text-green-700">
                  {documents.length} document{documents.length !== 1 ? "s" : ""} contributed
                </p>
              </div>
            )}
          </Link>

          {/* Candid Case */}
          <Link href="/case" className="p-4 bg-gradient-to-br from-gray-50 to-white border border-gray-100 rounded-2xl hover:border-blue-200 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">Candid Case</h3>
                <span className="text-[10px] font-semibold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">Coming soon</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Build your case. Find your lawyer. Compile audits, dispute letters, and evidence into a downloadable case file.
            </p>
            <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
              Candid does not provide legal advice or referrals. Attorney listings are for informational purposes only.
            </p>
          </Link>
        </div>
      </section>

    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles = {
    uploaded: "bg-amber-50 text-amber-700 border-amber-100",
    processing: "bg-blue-50 text-blue-700 border-blue-100",
    processed: "bg-green-50 text-green-700 border-green-100",
    error: "bg-red-50 text-red-700 border-red-100",
  }[status] || "bg-gray-50 text-gray-500 border-gray-200";

  const labels: Record<string, string> = {
    uploaded: "Pending",
    processing: "Processing",
    processed: "Audited",
    error: "Error",
  };

  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${styles}`}>
      {labels[status] || status}
    </span>
  );
}

function SummaryCard({ value, label, color }: { value: string; label: string; color: "blue" | "green" | "purple" }) {
  const styles = {
    blue: "bg-blue-50 border-blue-100 text-blue-700",
    green: "bg-green-50 border-green-100 text-green-700",
    purple: "bg-purple-50 border-purple-100 text-purple-700",
  }[color];

  return (
    <div className={`p-3.5 rounded-xl border ${styles}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium mt-0.5">{label}</div>
    </div>
  );
}

function BenefitRow({ item, onToggle, isUsed }: { item: AnalyzedBenefit; onToggle: (id: string) => void; isUsed: boolean }) {
  return (
    <div className={`flex items-center justify-between p-3.5 border rounded-xl transition-all ${
      isUsed ? "bg-green-50/50 border-green-100" : "bg-white border-gray-100"
    }`}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={() => onToggle(item.benefit.id)}
          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
            isUsed
              ? "bg-green-500 border-green-500"
              : "border-gray-300 hover:border-blue-400"
          }`}
        >
          {isUsed && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
        <Link href={`/plan#${item.benefit.id}`} className="min-w-0 group">
          <p className={`text-sm font-medium truncate group-hover:text-blue-600 transition-colors ${isUsed ? "text-green-800" : "text-gray-900"}`}>{item.benefit.title}</p>
          <p className="text-xs text-gray-400 truncate">{BENEFIT_CATEGORY_LABELS[item.benefit.category as BenefitCategory]}</p>
        </Link>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-3">
        {item.isRecommended && !isUsed && (
          <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">For you</span>
        )}
        {item.benefit.hsaFsaEligible && (
          <span className="text-[10px] font-semibold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">HSA/FSA</span>
        )}
        {isUsed ? (
          <span className="text-[10px] font-semibold text-green-600">Using</span>
        ) : (
          <Link href={`/plan#${item.benefit.id}`} className="text-[10px] font-semibold text-blue-600 hover:text-blue-700">
            Learn more
          </Link>
        )}
      </div>
    </div>
  );
}
