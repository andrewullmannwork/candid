"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import type { PlanAnalysisResult, AnalyzedBenefit } from "@/lib/plan/analyzer";
import { FollowupBanner } from "@/components/disputes/FollowupBanner";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { PageHeader } from "@/components/page-header";
import { ProfileMeter } from "@/components/onboarding/ProfileMeter";
import { SIMPLIFIED_ONBOARDING_FLAG } from "@/lib/onboarding/simplified";
import { Banner } from "@/components/banner";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { DataSourceContextLine } from "@/components/data-source-context-line";
import { ClaimHero, PlanHero, CompareBand } from "@/components/dashboard/DashDuo";
import { useClaimPipeline } from "@/lib/claims/use-claim-pipeline";
import { useAccumulatorLedger } from "@/components/plan/use-accumulator-ledger";
import {
  DashStripPlanCard,
  DashStripUploadCard,
} from "@/components/dashboard/DashStripCard";
import {
  BenefitsGrid,
  type BenefitsGridTile,
  type TileDomain,
} from "@/components/dashboard/BenefitsGrid";
import { categoryToDomain } from "@/lib/plan/category-display";
import { MoreFromCandidCards } from "@/components/dashboard/MoreFromCandidCards";

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
  processing_completed_pages?: number | null;
  processing_total_pages?: number | null;
  processing_step?: string | null;
}

// PlanAnalysisResult is the analyzer output; the /api/plan/analyze response is
// a richer shape (planSummary + planName + planYear + planType + insurer +
// dataSource + planSource etc.). We any-cast at consumption points rather than
// fork the type.
type EnrichedPlanResult = PlanAnalysisResult & {
  planSummary?: { verificationStatus?: string } | null;
  planName?: string | null;
  planYear?: number | null;
  planType?: string | null;
  insurer?: string | null;
  dataSource?: string;
  planSource?: string;
  insurancePlanId?: string | null;
};

// ─── Dashboard component ────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [planResult, setPlanResult] = useState<EnrichedPlanResult | null>(null);
  const [currentYear] = useState(() => new Date().getFullYear());
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);
  // Simplified onboarding (S285): profile meter gate — replaces the legacy
  // complete-profile banner when ON (never both).
  const [meterOn, setMeterOn] = useState(false);
  const [loading, setLoading] = useState(true);
  // Claim pipeline (Surface 1 dash-duo) — same derived counts as /claim.
  const pipeline = useClaimPipeline();
  // S289 — slug-keyed ticks hydrated from the analyze response (server truth
  // on the active plan row). The old localStorage init read TITLE-keyed
  // entries written by /plan, so the per-tile used counts below could never
  // match a tick; server hydration fixes both surfaces at once.
  const [usedBenefits, setUsedBenefits] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;

    async function loadDashboard() {
      const supabase = createBrowserClient();
      const idToken = await user!.firebaseUser.getIdToken();

      const [profileRes, docsRes, planRes] = await Promise.all([
        fetch("/api/profile", {
          headers: { Authorization: `Bearer ${idToken}` },
        }),
        supabase
          .from("documents")
          .select(
            "id, file_name, doc_type, status, created_at, processing_completed_pages, processing_total_pages",
          )
          .eq("user_id", user!.userId)
          .order("created_at", { ascending: false }),
        fetch("/api/plan/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({}),
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
          const planData = await planRes.json();
          setPlanResult(planData);
          setUsedBenefits(new Set((planData.usedBenefits as string[] | undefined) ?? []));
        } catch {
          // Plan analysis may fail if profile incomplete; non-fatal.
        }
      }

      supabase
        .from("feature_flag_rules")
        .select("enabled")
        .eq("flag_key", "plan_year_rollover")
        .eq("target_type", "global")
        .single()
        .then(({ data }) => {
          if (data?.enabled) setYearRolloverEnabled(true);
        });

      // Simplified onboarding (S285): meter flag via the public endpoint,
      // fetched per mount — no module-scope cache (the v7 banner cached a
      // flag read for the whole SPA session; mid-session flips were
      // invisible until hard reload). Fail-closed: errors leave the meter
      // off and the legacy banner in place.
      fetch(`/api/feature-flags/${SIMPLIFIED_ONBOARDING_FLAG}`)
        .then((r) => r.json())
        .then((j: { enabled?: boolean }) => {
          if (j?.enabled === true) setMeterOn(true);
        })
        .catch(() => {});

      setLoading(false);
    }

    loadDashboard();

    // 10s polling — re-queries documents + re-triggers stalled `process-chunk`
    // calls when processing_step is null or non-`working_*`. Load-bearing for
    // S99/S100/S102 upload chain reliability per S112 §1.C.1 Critical Pass.
    // Surfaces only when actionable via the standalone documents list below
    // (D-§1.C.1-D state-conditional integration).
    let prevProcessingIds = new Set<string>();
    const pollInterval = setInterval(async () => {
      if (!user) return;
      const supabase = createBrowserClient();
      const { data } = await supabase
        .from("documents")
        .select(
          "id, file_name, doc_type, status, created_at, processing_completed_pages, processing_total_pages, processing_step",
        )
        .eq("user_id", user.userId)
        .order("created_at", { ascending: false });
      if (data) {
        setDocuments(data);
        const processingDocs = data.filter(
          (d) =>
            (d.status === "processing" || d.status === "queued") &&
            (d.doc_type === "sbc" || d.doc_type === "plan_document"),
        );
        const currentProcessingIds = new Set(processingDocs.map((d) => d.id));

        if (processingDocs.length > 0) {
          prevProcessingIds = currentProcessingIds;
          for (const doc of processingDocs) {
            const step = (doc as { processing_step?: string }).processing_step;
            if (!step || !step.startsWith("working_")) {
              fetch("/api/documents/process-chunk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ documentId: doc.id }),
              }).catch(() => {});
            }
          }
        } else if (prevProcessingIds.size > 0) {
          // A document just finished processing — reload plan data.
          prevProcessingIds = new Set();
          loadDashboard();
        }
      }
    }, 10000);

    return () => clearInterval(pollInterval);
  }, [user]);

  // Plan-hero tracker rows — the shared accumulator-ledger hook (merged from
  // candid/backend-accumulator-ledger-v1). GET /api/plan/accumulators is gated
  // by accumulator_ledger_v1 and self-resolves the active plan; the hook
  // returns null (→ tracker rows hidden) when the flag is off, the plan is
  // missing, or there's no ledger yet.
  const ledger = useAccumulatorLedger(planResult?.insurancePlanId, planResult?.planYear);
  const ledgerPair = ledger
    ? (ledger.individual ?? ledger.familyAggregate ?? ledger.familyEmbedded?.cap ?? null)
    : null;
  // max = 0 is a REAL limit (e.g. $0-deductible platinum plans) — the row
  // renders "$0 of $0" with a full bar (met by definition), not hidden.
  const toTracker = (bucket: { candidApplied: number; max: number | null } | undefined) =>
    bucket && bucket.max != null
      ? { applied: bucket.candidApplied ?? 0, max: bucket.max }
      : null;
  const trackers = {
    deductible: toTracker(ledgerPair?.in?.deductible),
    oopMax: toTracker(ledgerPair?.in?.oop),
  };

  if (loading || pipeline.loading) {
    return <CubeLoaderBuilding />;
  }

  // ─── Derived state ────────────────────────────────────────────────────────
  const profileFields = profile
    ? [
        profile.insurer,
        profile.plan_type,
        profile.state,
        profile.group_number,
        profile.member_id,
        profile.plan_name,
      ]
    : [];
  const filledFields = profileFields.filter(Boolean).length;
  const totalFields = 6;
  const profileComplete = filledFields >= 2;
  const hasDocuments = documents.length > 0;
  const processingPlanDocs = documents.filter(
    (d) =>
      (d.status === "processing" || d.status === "queued") &&
      (d.doc_type === "sbc" || d.doc_type === "plan_document"),
  );

  // Actionable documents — surface standalone list only when there's something
  // the user needs to do (per D-§1.C.1-D).
  const actionableDocuments = documents.filter(
    (d) =>
      d.status === "error" ||
      d.status === "pending_review" ||
      d.status === "uploaded",
  );

  const firstName = user?.firebaseUser.displayName?.split(" ")[0] || "";

  // Plan card 4-state derivation (D-§1.C.1-A) — processing takes priority.
  const planState = (() => {
    if (processingPlanDocs.length > 0) return "processing" as const;
    const ds = planResult?.dataSource;
    const ps = planResult?.planSource;
    const vs = planResult?.planSummary?.verificationStatus;
    if (!planResult || ds === "static_catalog") return "no_plan" as const;
    const isUserPlan = ds === "user_plan" || ds === "user_plan_with_canonical";
    if (isUserPlan) {
      if (
        ps === "sbc_upload" ||
        ps === "plan_doc_upload" ||
        // S288: a search-selected named plan is canonical-grade (green tier per
        // the S269 DataSourceContextLine decision) — not "unverified".
        ps === "catalog_match" ||
        (vs && vs !== "unverified")
      ) {
        return "verified" as const;
      }
      return "unverified" as const;
    }
    if (ds === "matched_plan" || ds === "cms_api") return "verified" as const;
    if (ds === "verified_plan") return "unverified" as const;
    return "no_plan" as const;
  })();

  const processingDoc = processingPlanDocs[0];
  const planYear = planResult?.planYear ?? null;
  const planName = planResult?.planName ?? null;
  const planType = planResult?.planType ?? null;
  const totalBenefits = planResult?.totalBenefits ?? 0;
  const showYearRolloverSuffix =
    yearRolloverEnabled && planYear === currentYear ? `${planYear} plan year active` : undefined;

  // Plan card meta line (verified state) — "PPO · 2026 · 90 benefits".
  const planCardMeta =
    planState === "verified" && (planType || planYear || totalBenefits > 0)
      ? [planType, planYear, totalBenefits > 0 ? `${totalBenefits} benefits` : null]
          .filter(Boolean)
          .join(" · ")
      : null;

  // BenefitsGrid tile mapping (D-§1.C.1-E + AMA-scrub NON-NEGOTIABLE).
  const benefits = planResult?.benefits ?? [];
  const benefitsTiles = buildBenefitsTiles(benefits, usedBenefits);
  const hsaCount = benefits.filter((b) => b.benefit.hsaFsaEligible).length;
  const usedCount = usedBenefits.size;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        sub="Here's everything Candid knows about your healthcare — your money, your plan, your next moves."
      />

      {/* Simplified onboarding (S285): the profile-strength meter replaces
          the legacy complete-profile banner below when the flag is ON —
          never render both. */}
      {meterOn && <ProfileMeter />}

      {/* ── Action-required banner stack (max 2 above dash-trio) ───── */}
      {/* Followup banner self-gates on dispute follow-up presence. */}
      <FollowupBanner />

      {/* Profile completeness banner — D-§1.C.1-I via S113 Banner primitive.
          Suppressed while the profile meter is on (S285: never both). */}
      {!meterOn && !profileComplete && (
        <Banner
          tone="info"
          shape="card"
          size="md"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          }
          title="Complete your profile for better results"
          body={
            <>
              Add your insurance details so we can personalize your audit and surface the right
              benefits.
              {filledFields > 0 && ` You've filled ${filledFields} of ${totalFields} fields.`}
            </>
          }
          action={{ label: "Complete profile", onClick: () => { window.location.href = "/profile"; } }}
        />
      )}

      {/* ── Dash-duo (Claim + Plan heroes) + Compare band — Surface 1 ── */}
      <div className="space-y-3.5">
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4">
          <ClaimHero
            billsCount={pipeline.claims.length}
            totalRecovery={pipeline.totalRecovery}
            counts={pipeline.counts}
          />
          <PlanHero
            totalBenefits={planResult ? totalBenefits : 0}
            usedCount={usedCount}
            hsaCount={hsaCount}
            verified={planState === "verified"}
            deductible={trackers.deductible}
            oopMax={trackers.oopMax}
          />
        </div>
        <CompareBand />
      </div>

      {/* AccumulatorMini's standalone dashboard mount is retired — the Plan
          hero's deductible/OOP tracker rows (same ledger hook) own that
          surface now. The full spending panel remains on /plan. */}

      {/* ── Dash-strip (plan + upload paired cards) ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <DashStripPlanCard
          state={planState}
          planName={planName}
          metaLine={planCardMeta}
          eyebrowSuffix={showYearRolloverSuffix}
          processingCompletedPages={processingDoc?.processing_completed_pages ?? undefined}
          processingTotalPages={processingDoc?.processing_total_pages ?? undefined}
          ctaHref={
            planState === "no_plan"
              ? "/profile"
              : planState === "unverified"
                ? "/upload"
                : "/plan"
          }
          ctaLabel={
            planState === "no_plan"
              ? "Set up"
              : planState === "unverified"
                ? "Upload SBC"
                : planState === "processing"
                  ? "View"
                  : "View benefits"
          }
        />
        <DashStripUploadCard
          summary={
            hasDocuments
              ? `${documents.length} document${documents.length === 1 ? "" : "s"} on file`
              : undefined
          }
        />
      </div>

      {/* ── Actionable documents list (conditional per D-§1.C.1-D) ──── */}
      {actionableDocuments.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">Documents needing attention</h2>
            <Link href="/upload" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
              Upload more
            </Link>
          </div>
          <div className="space-y-2">
            {actionableDocuments.slice(0, 5).map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-4 bg-white rounded-xl ring-1 ring-gray-100"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{doc.file_name}</p>
                    <p className="text-xs text-gray-400">
                      {labelFor(doc.doc_type)} · {new Date(doc.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <StatusBadge status={doc.status} />
              </div>
            ))}
          </div>

          {actionableDocuments.some((d) => d.status === "uploaded") && (
            <div className="mt-3 p-3 bg-amber-50 ring-1 ring-amber-100 rounded-xl flex items-center gap-3">
              <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
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

      {/* ── Benefits utilization section ────────────────────────────── */}
      {planResult && totalBenefits > 0 ? (
        <section>
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-gray-900">Your benefits at a glance</h2>
              <DataSourceContextLine
                dataSource={planResult.dataSource}
                planSource={planResult.planSource}
                planType={planType ?? undefined}
                verificationStatus={planResult.planSummary?.verificationStatus}
                className="mt-1"
              />
            </div>
            <Link
              href="/plan"
              className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
            >
              View all details ›
            </Link>
          </div>

          <BenefitsGrid tiles={benefitsTiles} />

          <div className="flex justify-center mt-4">
            <Link
              href="/plan"
              className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 py-2"
            >
              See all {totalBenefits} benefits
              <span aria-hidden="true">→</span>
            </Link>
          </div>

          <div className="mt-3 p-3 bg-gray-50 rounded-xl ring-1 ring-gray-100">
            <p className="text-[10px] text-gray-400 leading-relaxed">
              <span className="font-semibold text-gray-500">Important Notice:</span>{" "}
              Candid provides general information about benefits commonly available with your type
              of insurance plan. This is not a guarantee of coverage. Actual benefits vary by
              specific plan, employer, and state. Always contact your insurance company to verify
              your specific benefits before seeking services. Candid does not provide insurance
              advice, and this information does not constitute a recommendation to obtain any
              particular service or treatment. Candid is an Airgetlam Labs LLC company.
            </p>
          </div>
        </section>
      ) : (
        <section className="p-5 bg-white rounded-2xl ring-1 ring-gray-100 text-center">
          {processingPlanDocs.length > 0 ? (
            <>
              <div className="flex items-center justify-center gap-2 mb-2">
                <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-blue-700">Processing your plan document…</p>
              </div>
              <p className="text-xs text-gray-500">
                This takes about a minute. Your benefits will appear automatically when done.
              </p>
            </>
          ) : profile?.insurer ? (
            <>
              <p className="text-sm text-gray-500">
                Upload a plan document to see your specific covered benefits.
              </p>
              <Link
                href="/upload"
                className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                Upload plan document
                <span aria-hidden="true">→</span>
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                Add your insurance details to discover covered benefits you may not be using.
              </p>
              <Link
                href="/profile"
                className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
              >
                Complete your profile
                <span aria-hidden="true">→</span>
              </Link>
            </>
          )}
        </section>
      )}

      {/* ── More from Candid ────────────────────────────────────────── */}
      <section>
        <h2 className="text-base font-semibold text-gray-900">More from Candid</h2>
        <p className="text-xs text-gray-500 mt-1 mb-4">
          We&rsquo;re building the rest of the financial-trust suite on top of the same plan data.
        </p>
        <MoreFromCandidCards careContributedCount={documents.length} />
      </section>

      {/* ── ShareWithFriend soft embed (un-gated per S124 close opportunity) ─ */}
      <ShareWithFriend variant="soft" surface="dashboard" />
    </div>
  );
}

// ─── Status badge for actionable documents list ────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles =
    {
      uploaded: "bg-amber-50 text-amber-700 ring-amber-100",
      queued: "bg-blue-50 text-blue-700 ring-blue-100",
      processing: "bg-blue-50 text-blue-700 ring-blue-100",
      processed: "bg-green-50 text-green-700 ring-green-100",
      pending_review: "bg-amber-50 text-amber-700 ring-amber-100",
      error: "bg-red-50 text-red-700 ring-red-100",
    }[status] || "bg-gray-50 text-gray-500 ring-gray-200";

  const labels: Record<string, string> = {
    uploaded: "Pending",
    queued: "Queued",
    processing: "Processing",
    processed: "Audited",
    pending_review: "Under Review",
    error: "Error",
  };

  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset ${styles}`}>
      {labels[status] || status}
    </span>
  );
}

function labelFor(docType: string): string {
  if (docType === "eob") return "EOB";
  if (docType === "sbc") return "SBC";
  if (docType === "plan_document") return "Plan Doc";
  return "Itemized Bill";
}

// ─── BenefitsGrid mapping (AMA-clean per P5 Hard Rule #3) ──────────────────

// categoryToDomain lives in src/lib/plan/category-display.ts (S289 — shared,
// fixture-asserted; adds the 7 previously-missing service_catalog categories
// that all fell to "other" and kept the LTC tile permanently at 0).

const TILE_DEFS: Array<{ id: string; domain: TileDomain; name: string }> = [
  { id: "preventive", domain: "preventive", name: "Preventive Care" },
  { id: "mental", domain: "mental", name: "Mental Health" },
  { id: "therapy", domain: "therapy", name: "Therapy & Rehab" },
  { id: "office", domain: "office", name: "Office Visits" },
  { id: "imaging", domain: "imaging", name: "Imaging" },
  { id: "lab", domain: "lab", name: "Lab & Testing" },
  { id: "rx", domain: "rx", name: "Prescriptions" },
  { id: "maternity", domain: "maternity", name: "Maternity & Family" },
  { id: "hospital", domain: "hospital", name: "Hospital" },
  { id: "emergency", domain: "emergency", name: "Emergency" },
  { id: "ltc", domain: "ltc", name: "Long-Term Care" },
  { id: "equip", domain: "equip", name: "Equipment & Supplies" },
];

function buildBenefitsTiles(
  benefits: AnalyzedBenefit[],
  usedBenefits: Set<string>,
): BenefitsGridTile[] {
  // categoryKey = candid category string of the FIRST benefit landing in the
  // bucket; powers the /plan#category-{categoryKey} deep-link anchor.
  type Bucket = {
    count: number;
    usedCount: number;
    topBenefit?: string;
    categoryKey?: string;
  };
  const grouped = new Map<TileDomain, Bucket>();
  for (const def of TILE_DEFS) grouped.set(def.domain, { count: 0, usedCount: 0 });

  const otherBucket: Bucket = { count: 0, usedCount: 0 };

  for (const item of benefits) {
    const domain = categoryToDomain(item.benefit.category);
    const bucket = domain === "other" ? otherBucket : grouped.get(domain)!;
    bucket.count++;
    if (usedBenefits.has(item.benefit.id)) bucket.usedCount++;
    if (!bucket.topBenefit) bucket.topBenefit = item.benefit.title;
    if (!bucket.categoryKey) bucket.categoryKey = item.benefit.category;
  }

  const tiles: BenefitsGridTile[] = TILE_DEFS.map((def) => {
    const entry = grouped.get(def.domain)!;
    return {
      id: def.id,
      name: def.name,
      sub: entry.topBenefit,
      count: entry.count,
      usedCount: entry.usedCount,
      domain: def.domain,
      categoryKey: entry.categoryKey,
    };
  });

  if (otherBucket.count > 0) {
    tiles.push({
      id: "other",
      name: "Other Services",
      sub: otherBucket.topBenefit,
      count: otherBucket.count,
      usedCount: otherBucket.usedCount,
      domain: "other",
      categoryKey: otherBucket.categoryKey,
    });
  }

  return tiles;
}
