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

      {/* ── Quick Actions ───────────────────────────────────────────────────── */}
      {!hasDocuments && (
        <div className="p-8 border-2 border-dashed border-gray-200 rounded-2xl text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Upload your first bill</h3>
          <p className="mt-1 text-sm text-gray-500 max-w-sm mx-auto">
            Upload an EOB or itemized bill and we&apos;ll audit it for errors, overcharges, and missed adjustments.
          </p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 mt-5 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
          >
            Upload a document
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
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

      {/* ── Benefits Section — Gamified ─────────────────────────────────────── */}
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
            {/* Important Notice */}
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl mb-4">
              <p className="text-[11px] text-gray-400 leading-relaxed">
                <span className="font-semibold text-gray-500">Important Notice:</span>{" "}
                Candid provides general information about benefits commonly available with your
                type of insurance plan. This is not a guarantee of coverage. Actual benefits vary by
                specific plan, employer, and state. Always contact your insurance company to verify
                your specific benefits before seeking services. Candid does not provide insurance
                advice. Candid is an Airgetlam Labs LLC company.
              </p>
            </div>

            {/* Progress ring + score */}
            <div className="p-5 bg-white border border-gray-100 rounded-2xl mb-4">
              <div className="flex items-center gap-5">
                <div className="relative w-20 h-20 shrink-0">
                  <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                    <circle cx="40" cy="40" r="34" fill="none" stroke="#f1f5f9" strokeWidth="6" />
                    <circle
                      cx="40" cy="40" r="34" fill="none" stroke="#3b82f6" strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={`${Math.round((usedBenefitsCount / Math.max(planResult.totalBenefits, 1)) * 213.6)} 213.6`}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold text-gray-900">{usedBenefitsCount}/{planResult.totalBenefits}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {usedBenefitsCount === 0
                      ? "You're leaving money on the table"
                      : usedBenefitsCount < planResult.totalBenefits / 2
                        ? "Good start — keep going"
                        : usedBenefitsCount < planResult.totalBenefits
                          ? "You're getting great value"
                          : "You're maximizing your plan!"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {planResult.totalBenefits - usedBenefitsCount} covered benefit{planResult.totalBenefits - usedBenefitsCount !== 1 ? "s" : ""} you may not be using yet.
                    {planResult.benefits.some((b) => b.benefit.hsaFsaEligible) && (
                      <span className="text-purple-600 font-medium"> {planResult.benefits.filter((b) => b.benefit.hsaFsaEligible).length} can be paid with HSA/FSA if you have one.</span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Benefits list — unused first */}
            <div className="space-y-1.5">
              {planResult.benefits.slice(0, 6).map((item) => (
                <BenefitRow key={item.benefit.id} item={item} onToggle={toggleBenefit} isUsed={usedBenefits.has(item.benefit.id)} />
              ))}
            </div>

            {planResult.totalBenefits > 6 && (
              <Link
                href="/plan"
                className="block mt-3 text-center text-xs font-medium text-blue-600 hover:text-blue-700 py-2"
              >
                See all {planResult.totalBenefits} benefits →
              </Link>
            )}

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

      {/* ── Candid Care — Your Contributions ────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900 mb-4">Candid Care</h2>
        <div className="p-5 bg-gradient-to-br from-gray-50 to-white border border-gray-100 rounded-2xl">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Price transparency — coming soon</h3>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Compare what you paid against what others paid for the same procedure.
                Every bill you upload contributes anonymized data to help everyone find fairer prices.
              </p>
              {hasDocuments && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <p className="text-xs font-medium text-green-700">
                    You&apos;ve contributed {documents.length} document{documents.length !== 1 ? "s" : ""}
                  </p>
                </div>
              )}
            </div>
          </div>
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
