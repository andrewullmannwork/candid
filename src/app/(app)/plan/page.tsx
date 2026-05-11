"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import type { PlanAnalysisResult, AnalyzedBenefit } from "@/lib/plan/analyzer";
import type { BenefitCategory } from "@/lib/plan/benefits-catalog";
import { BENEFIT_CATEGORY_LABELS } from "@/lib/plan/benefits-catalog";
import {
  DisplayStateBadge,
  SourceQuote,
  VerifyAffordance,
  decoratedShape,
  aggregateRowState,
  isVisibleState,
  needsUploadCTA,
  isDocumentBacked,
  type DecoratedValue,
  type DisplayState,
} from "@/components/display-state";

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
  long_term_care: "Long-Term Care",
  other: "Other Services",
  general: "General",
};

// ── Extended API response type ─────────────────────────────────────────────────

// Phase 4 Task 4-B: when consumer_read_filter_v1 flag is ON, P-8-eligible fields
// arrive as DecoratedValue<T> wrappers; when OFF, raw T (legacy). Plan page
// branches via `decoratedShape()` helper at render time.
type MaybeDecorated<T> = T | DecoratedValue<T>;

interface AnalyzeResponse extends PlanAnalysisResult {
  dataSource: "user_plan" | "user_plan_with_canonical" | "matched_plan" | "cms_api" | "verified_plan" | "static_catalog";
  planName?: string;
  planYear?: number | null;
  insurancePlanId?: string;
  canonicalPlanId?: string | null;
  insurer?: string;
  planType?: string;
  planSummary?: {
    inDeductible?: MaybeDecorated<number | null>;
    outDeductible?: MaybeDecorated<number | null>;
    inOopMax?: MaybeDecorated<number | null>;
    outOopMax?: MaybeDecorated<number | null>;
    planType?: MaybeDecorated<string | null>;
    metalLevel?: string;
    verificationStatus?: string;
    premiumMonthly?: MaybeDecorated<number | null>;
    premiumSource?: string;
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

function AmberBanner({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
        <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-amber-900">{title}</p>
        <p className="text-xs text-amber-700 mt-0.5">{subtitle}</p>
        <Link href="/upload" className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Upload your plan document
        </Link>
      </div>
    </div>
  );
}

function DataSourceBanner({ dataSource, planName, planType, insurer, verificationStatus, planSource }: {
  dataSource: string;
  planName?: string;
  planType?: string;
  insurer?: string;
  verificationStatus?: string;
  planSource?: string;
}) {

  if (dataSource === "user_plan") {
    // SBC or plan document upload, or verified plan → green
    const isVerified = verificationStatus && verificationStatus !== "unverified";
    if (planSource === "sbc_upload" || planSource === "plan_doc_upload" || isVerified) {
      return (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-green-900">Results based on your uploaded document</p>
            <p className="text-xs text-green-700 mt-0.5">
              These benefits reflect the coverage details extracted from your plan documents.
            </p>
          </div>
        </div>
      );
    }

    // Manual entry → amber
    if (planSource === "manual") {
      return <AmberBanner
        title="Results based on the insurance details you provided"
        subtitle="Upload your plan document for more complete results."
      />;
    }

    // Insurance card scan or other unverified → amber
    return <AmberBanner
      title="Results based on your insurance card"
      subtitle="Upload your plan document for more complete results."
    />;
  }

  if (dataSource === "user_plan_with_canonical") {
    return (
      <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-green-900">Results based on your uploaded document</p>
          <p className="text-xs text-green-700 mt-0.5">
            Some benefits include coverage details from other members on the same plan.
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
            Results based on a Candid verified plan matching your insurance card
          </p>
          <p className="text-xs text-blue-700 mt-0.5">
            We matched your information to {planName || "a verified plan"} in our database.
          </p>
        </div>
      </div>
    );
  }

  if (dataSource === "verified_plan") {
    return <AmberBanner
      title="Results based on a plan similar to yours"
      subtitle="Upload your plan document for more complete results."
    />;
  }

  // static_catalog — dynamic based on plan type
  if (planType) {
    return <AmberBanner
      title={`Results based on your ${planType} plan type`}
      subtitle="Upload your plan document for more complete results."
    />;
  }

  // No plan type at all
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
            No insurance information on file
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            Results based on the typical user. Upload your insurance card and plan document for more complete results.
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

function PlanSummaryCard({ planName, planYear, planSummary, dataSource, insurancePlanId, userHasDoc }: {
  planName?: string;
  planYear?: number | null;
  planSummary?: AnalyzeResponse["planSummary"];
  dataSource: string;
  insurancePlanId?: string;
  userHasDoc?: boolean;
}) {
  if (!planSummary || dataSource === "static_catalog") return null;

  // Phase 4 Task 4-D: each P-8-eligible field unwraps to {value, state, reason}.
  // When flag OFF, state is null and DisplayStateBadge renders nothing.
  const inDed = decoratedShape<number | null>(planSummary.inDeductible);
  const outDed = decoratedShape<number | null>(planSummary.outDeductible);
  const inOop = decoratedShape<number | null>(planSummary.inOopMax);
  const outOop = decoratedShape<number | null>(planSummary.outOopMax);
  const planType = decoratedShape<string | null>(planSummary.planType);
  const premium = decoratedShape<number | null>(planSummary.premiumMonthly);

  // S71 hotfix #3 (Session 73) — card-level aggregate now excludes `premium`
  // and `planType` from the aggregation set. Premium is structurally not on
  // an SBC (CMS marketplace is the canonical source); planType inherits from
  // canonical when not on the user's doc. Including them in worst-trumps
  // aggregation made the card show "Public Data" / "Community" even when all
  // 4 cost-sharing fields were cite-grade User Verified — incoherent for users
  // who uploaded their plan ("the badge says Public Data but I uploaded my
  // document?"). Per-cell badges still display each field's own state below.
  const summaryAggState = aggregateRowState([
    inDed.state,
    outDed.state,
    inOop.state,
    outOop.state,
  ]);
  const summaryFields = [inDed, outDed, inOop, outOop];
  const summaryWorstField = summaryFields.find((f) => f.state === summaryAggState);
  const summaryAggReason = summaryWorstField?.reason ?? null;

  return (
    <div className="mt-4 p-4 bg-white border border-gray-200 rounded-xl">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 min-w-0">
          {planName || "Your Plan"}
          {planYear && (
            <span className="ml-2 text-xs font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
              {planYear}
            </span>
          )}
          {planType.value && (
            <span className="ml-2 text-xs font-medium text-gray-500">
              {planType.value}
              {planSummary.metalLevel && ` / ${planSummary.metalLevel}`}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* CF-19 (Session 64): summary-card aggregate badge.
              Per user direction: only render for verified-tier states. Estimated/
              unverified summary-card values hide individually below.
              S71 hotfix #3 (Session 73): legacy `verification_status` badge
              ("Document verified" / "Unverified") removed — superseded by the
              v3 Display State vocabulary above. The two badges co-rendering
              gave users mixed signals ("Public Data + Document verified" on
              the same card). */}
          {summaryAggState && summaryAggReason && isVisibleState(summaryAggState) && (
            <DisplayStateBadge state={summaryAggState} reason={summaryAggReason} size="xs" />
          )}
        </div>
      </div>
      {premium.value != null && (
        <div className="mt-3 flex items-baseline gap-1.5 flex-wrap">
          <span className="text-xl font-bold text-gray-900">
            ${premium.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="text-xs text-gray-500">/month</span>
          {planSummary.premiumSource === "county_specific" && (
            <span className="ml-1.5 text-[10px] font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded">Your county</span>
          )}
          {/* CF-19 (Session 64): per-field DisplayStateBadge removed — aggregate at card header. */}
        </div>
      )}
      {/* CF-19 v2 (Session 64) per user direction: per-field values render only when
          state is null (flag OFF — legacy) OR verified-tier (candid_verified / verified).
          Estimated values render with "Upload your plan document" CTA below; hidden
          (parser_failure) values show "—" + page-level banner aggregates failures. */}
      {(() => {
        const isVisible = (s: typeof inDed.state): boolean =>
          s === null || isVisibleState(s);
        const renderValue = (
          field: typeof inDed,
          placeholder: string,
        ): React.ReactNode => {
          if (!isVisible(field.state)) return <span className="text-gray-300">&mdash;</span>;
          // Session 77: conditional-context surfacing. When parser captured a
          // cite-grade verbatim quote describing a conditional plan rule (e.g.,
          // "Deductible: Waived for emergencies") but couldn't reduce it to a
          // single number, render the verbatim phrase as the field's display
          // text instead of hiding behind the placeholder. The text is already
          // verified by Pattern P-8 — it's a citable plan-document quote.
          if (
            field.value == null &&
            field.reason === "from_user_document_conditional_context" &&
            field.excerpt
          ) {
            return (
              <span
                className="text-xs italic text-slate-700 leading-snug"
                title="From your plan document"
              >
                &ldquo;{field.excerpt.trim()}&rdquo;
              </span>
            );
          }
          if (field.value == null) return <span className="text-gray-300">{placeholder}</span>;
          return `$${field.value.toLocaleString()}`;
        };
        return (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Deductible (in-network)</p>
              <p className="text-sm font-medium text-gray-900">{renderValue(inDed, "Upload SBC")}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Deductible (out-of-network)</p>
              <p className="text-sm font-medium text-gray-900">{renderValue(outDed, "—")}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">OOP Max (in-network)</p>
              <p className="text-sm font-medium text-gray-900">{renderValue(inOop, "Upload SBC")}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">OOP Max (out-of-network)</p>
              <p className="text-sm font-medium text-gray-900">{renderValue(outOop, "—")}</p>
            </div>
          </div>
        );
      })()}
      {/* Phase 4.0.5 Task 4.0.5-F: smart 2-button affordance for plan-identity
          scalars. Picks the worst-signal scalar across (inDed, outDed, inOop,
          outOop) — premium excluded since it's CMS-marketplace-sourced and re-parse
          can't help. fieldName routes to `in_deductible_individual` as the
          representative re-parse target; worstField.searchedSectionsCount drives
          shape decision (2-button when incomplete; 1-button when complete or
          undefined per Q-P4.0.5-7 forward-only fallback). */}
      {(() => {
        const candidates = [
          { state: inDed.state, reason: inDed.reason, count: inDed.searchedSectionsCount, fieldName: "in_deductible_individual" },
          { state: outDed.state, reason: outDed.reason, count: outDed.searchedSectionsCount, fieldName: "out_deductible_individual" },
          { state: inOop.state, reason: inOop.reason, count: inOop.searchedSectionsCount, fieldName: "in_oop_max_individual" },
          { state: outOop.state, reason: outOop.reason, count: outOop.searchedSectionsCount, fieldName: "out_oop_max_individual" },
        ].filter((c) => c.state !== null);
        if (candidates.length === 0) return null;
        // CF-19 v2: only Estimated state shows the upload affordance. Verified-tier states
        // get no inline prompt — value is trusted. Hidden states (parser_failure) get the
        // page-level banner instead.
        const worst = candidates.find((c) => needsUploadCTA(c.state)) ?? null;
        if (!worst || !worst.state || !worst.reason) return null;
        return (
          <div className="mt-3">
            <VerifyAffordance
              state={worst.state}
              reason={worst.reason}
              planId={insurancePlanId}
              fieldName={worst.fieldName}
              searchedSectionsCount={worst.count}
              userHasDoc={userHasDoc}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ── Row-level display state aggregation ────────────────────────────────────────
// Phase 4 Task 4-D: each benefit row has up to 6 P-8-eligible decorated cost fields
// (in/out copay + in/out coinsurance + annualLimit + priorAuthRequired). Aggregate
// to a single row-level DisplayState so the row badge represents the "weakest link"
// — user sees one badge per row, drill into expanded view for the verbatim source.
//
// Returns null when no decorated fields are present (flag OFF; legacy raw shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeRowDisplay(item: any): {
  state: DisplayState;
  reason: import("@/components/display-state").DisplayStateReason;
  excerpt: string | null;
  searchedSectionsCount: number | undefined;
} | null {
  const fields = [
    decoratedShape<number | null>(item?.costSharing?.inNetwork?.copay),
    decoratedShape<number | null>(item?.costSharing?.inNetwork?.coinsurance),
    decoratedShape<number | null>(item?.costSharing?.outOfNetwork?.copay),
    decoratedShape<number | null>(item?.costSharing?.outOfNetwork?.coinsurance),
    decoratedShape<string | null>(item?.costSharing?.annualLimit),
    decoratedShape<boolean | null>(item?.costSharing?.priorAuthRequired),
  ];
  const aggState = aggregateRowState(fields.map((f) => f.state));
  if (!aggState) return null;
  // CF-19 (Session 64) — 6-state vocabulary: any of the 3 verified-tier states
  // (candid_verified / document_verified / found_in_document) gets the same
  // "show source quote if cite-grade else surface reason" treatment.
  const isVerifiedTier = isDocumentBacked(aggState);
  if (isVerifiedTier) {
    // Prefer a field at this exact state that ALSO has an excerpt (cite-grade) so
    // the row's SourceQuote in expanded view has substance. Fall back to any field
    // at this state's reason if no excerpt is available.
    const withExcerpt = fields.find((f) => f.state === aggState && f.hasExcerpt && f.excerpt);
    if (withExcerpt) {
      return {
        state: aggState,
        reason: withExcerpt.reason!,
        excerpt: withExcerpt.excerpt,
        searchedSectionsCount: withExcerpt.searchedSectionsCount,
      };
    }
    const anyAtState = fields.find((f) => f.state === aggState);
    return {
      state: aggState,
      reason: anyAtState?.reason ?? "community_corroborated",
      excerpt: null,
      searchedSectionsCount: anyAtState?.searchedSectionsCount,
    };
  }
  // For non-verified-tier aggregate, surface the worst field's reason for the badge tooltip.
  // Phase 4.0.5: also surface that field's searchedSectionsCount so VerifyAffordance
  // can decide between 2-button (incomplete coverage) and 1-button (complete or undefined).
  const worstField = fields.find((f) => f.state === aggState);
  return {
    state: aggState,
    reason: worstField?.reason ?? "parser_failure",
    excerpt: null,
    searchedSectionsCount: worstField?.searchedSectionsCount,
  };
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

  // Feature flags
  const [correctionsEnabled, setCorrectionsEnabled] = useState(false);
  const [yearRolloverEnabled, setYearRolloverEnabled] = useState(false);

  // Historical plans state
  const [historicalPlans, setHistoricalPlans] = useState<Array<{
    id: string;
    plan_name: string | null;
    insurer_name: string | null;
    plan_type: string | null;
    plan_year: number | null;
    is_active: boolean;
    created_at: string;
  }>>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Correction form state
  const [correctionTarget, setCorrectionTarget] = useState<{
    benefitId: string;
    serviceSlug: string;
    title: string;
  } | null>(null);
  const [correctionField, setCorrectionField] = useState<string>("copay");
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionNotes, setCorrectionNotes] = useState("");
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionSuccess, setCorrectionSuccess] = useState(false);
  const [correctionError, setCorrectionError] = useState("");

  async function submitCorrection() {
    if (!user || !correctionTarget || !correctionValue) return;
    setCorrectionSubmitting(true);
    setCorrectionError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          action: "submit",
          serviceSlug: correctionTarget.serviceSlug,
          field: correctionField,
          proposedValue: correctionValue,
          notes: correctionNotes || undefined,
          insurancePlanId: result?.insurancePlanId || undefined,
          canonicalPlanId: result?.canonicalPlanId || undefined,
        }),
      });
      if (res.ok) {
        setCorrectionSuccess(true);
        setTimeout(() => { setCorrectionTarget(null); setCorrectionSuccess(false); setCorrectionValue(""); setCorrectionNotes(""); setCorrectionError(""); }, 2000);
      } else {
        const errData = await res.json().catch(() => ({}));
        setCorrectionError(errData.error || "Failed to submit correction. Please try again.");
      }
    } catch (err) {
      console.error("Correction submit failed:", err);
      setCorrectionError("Failed to submit correction. Please try again.");
    }
    setCorrectionSubmitting(false);
  }

  function toggleBenefit(id: string) {
    setUsedBenefits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("candid_used_benefits", JSON.stringify([...next]));
      return next;
    });
  }

  // S71 follow-up (Session 73) — REMOVED in-memory cache. The previous
  // `cachedResult` useRef bailed out of re-fetching whenever it had a prior
  // response, but on Next.js App Router the component instance can persist
  // across soft navigations (back-nav from /upload → /plan, sibling route
  // shifts, prefetch warmups). Result: after a user re-uploaded their SBC,
  // navigating to /plan served the pre-upload analyze response indefinitely
  // until a hard refresh. Same hazard on profile edits, dispute outcomes, any
  // path that mutates plan-shaped data. Always re-fetch on user change —
  // /api/plan/analyze is dynamic + cheap (no Haiku calls; just DB reads).
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

    // Load historical plans + check feature flag (non-critical, parallel)
    (async () => {
      try {
        const supabase = createBrowserClient();
        const [plansRes, flagRes, rolloverFlagRes] = await Promise.all([
          supabase
            .from("insurance_plans")
            .select("id, plan_name, insurer_name, plan_type, plan_year, is_active, created_at")
            .eq("user_id", user!.userId)
            .order("created_at", { ascending: false }),
          supabase
            .from("feature_flag_rules")
            .select("enabled")
            .eq("flag_key", "benefit_corrections")
            .eq("target_type", "global")
            .single(),
          supabase
            .from("feature_flag_rules")
            .select("enabled")
            .eq("flag_key", "plan_year_rollover")
            .eq("target_type", "global")
            .single(),
        ]);
        if (plansRes.data) setHistoricalPlans(plansRes.data);
        if (flagRes.data?.enabled) setCorrectionsEnabled(true);
        if (rolloverFlagRes.data?.enabled) setYearRolloverEnabled(true);
      } catch { /* non-critical */ }
    })();
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

  // S71.5-BADGE-VERIFY (Session 74): page-level signal "the user already uploaded
  // a plan document on this canonical." When true, inline VerifyAffordance copy
  // acknowledges the upload ("Upload a more complete plan document") instead of
  // cold-start framing. Codified in [[Candid_10k]] §3.1 Display State Achievement
  // & Graduation Rules §8 (page-level prompt rule).
  const planSourceVal = (result as unknown as Record<string, unknown>).planSource as string | undefined;
  const verificationStatusVal = result.planSummary?.verificationStatus;
  const userHasDoc =
    planSourceVal === "sbc_upload" ||
    planSourceVal === "plan_doc_upload" ||
    (verificationStatusVal != null && verificationStatusVal !== "unverified");

  // Separate covered vs not-covered benefits, then group covered by category
  const notCoveredItems: AnalyzedBenefit[] = [];
  const grouped = new Map<string, AnalyzedBenefit[]>();
  for (const item of result.benefits) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((item as any).covered === false) {
      notCoveredItems.push(item);
      continue;
    }
    const cat = item.benefit.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coveredBenefits = result.benefits.filter((b) => (b as any).covered !== false);
  const totalUsed = coveredBenefits.filter((b) => usedBenefits.has(b.benefit.id)).length;

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
        planSource={(result as unknown as Record<string, unknown>).planSource as string | undefined}
      />

      {/* Plan summary card (only for matched/uploaded plans) */}
      <PlanSummaryCard
        planName={result.planName}
        planYear={yearRolloverEnabled ? result.planYear : null}
        planSummary={result.planSummary}
        dataSource={result.dataSource}
        insurancePlanId={result.insurancePlanId}
        userHasDoc={userHasDoc}
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
                strokeDasharray={`${Math.round((totalUsed / Math.max(coveredBenefits.length, 1)) * 213.6)} 213.6`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-bold text-gray-900">{totalUsed}/{coveredBenefits.length}</span>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {totalUsed === 0
                ? "Start checking off benefits you use"
                : totalUsed < coveredBenefits.length / 2
                  ? "Good start \u2014 keep discovering"
                  : totalUsed < coveredBenefits.length
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
          // CF-19 (Session 64): per-row + category visibility filter.
          // Pre-compute each row's display state to determine visibility.
          // Categories with zero verified-tier rows are hidden entirely (no
          // empty container with broken progress bar). Flag-OFF case (all rowDisplays
          // null) falls back to legacy rendering — show all rows.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rowDisplays = benefits.map((b) => computeRowDisplay(b as any));
          const flagOff = rowDisplays.every((r) => r === null);
          const visibleBenefits = flagOff
            ? benefits
            : benefits.filter((_, i) => {
                const s = rowDisplays[i]?.state;
                return isVisibleState(s);
              });
          if (visibleBenefits.length === 0) return null;
          const usedInCategory = visibleBenefits.filter((b) => usedBenefits.has(b.benefit.id)).length;
          const visibleRowDisplays = flagOff
            ? rowDisplays
            : rowDisplays.filter((r) => {
                const s = r?.state;
                return isVisibleState(s);
              });
          const categoryAggState = aggregateRowState(visibleRowDisplays.map((r) => r?.state ?? null));
          const worstRowDisplay = visibleRowDisplays.find((r) => r?.state === categoryAggState);
          const categoryAggReason = worstRowDisplay?.reason ?? null;
          return (
            <div key={category} className="border border-gray-100 rounded-2xl overflow-hidden">
              {/* Category header with progress + aggregate badge */}
              <div className="flex items-center justify-between p-4 bg-gray-50/50">
                <div className="flex items-center gap-3 min-w-0">
                  <CategoryIcon category={category} />
                  <span className="font-semibold text-gray-900 truncate">
                    {BENEFIT_CATEGORY_LABELS[category as BenefitCategory] || SERVICE_CATEGORY_LABELS[category] || category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                  </span>
                  {/* Aggregate state badge — one per category. Per user direction Session 64
                      v2 simplification: render for verified-tier states (candid_verified /
                      verified) — and Estimated when category mostly has data from non-doc
                      sources (CMS marketplace etc.). Hidden categories (all parser_failure)
                      already filtered out by visibleBenefits.length === 0 check above. */}
                  {categoryAggState && categoryAggReason && isVisibleState(categoryAggState) && (
                    <DisplayStateBadge state={categoryAggState} reason={categoryAggReason} size="xs" />
                  )}
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
                  const rowDisplay = computeRowDisplay(item);
                  // CF-19 v2 (Session 64): rows render when state is null (flag OFF) OR
                  // verified-tier (candid_verified / verified) OR estimated. Only `hidden`
                  // (parser_failure / boilerplate) rows are skipped — page-level banner
                  // surfaces the parser_failure aggregate.
                  const isRenderable =
                    rowDisplay === null || isVisibleState(rowDisplay.state);
                  if (!isRenderable) return null;
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
                              {/* CF-19 (Session 64): per-row DisplayStateBadge removed —
                                  category-level badge in the header now carries the worst-
                                  signal aggregate. User-facing benefit (less noisy UI per user
                                  direction). Per-row reason still informs the row's
                                  VerifyAffordance + SourceQuote rendering in the expanded view. */}
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
                                <div className="mt-0.5 space-y-0.5">
                                  {(item.costSharing.inNetwork?.costDescription || "Covered").split("; ").map((line: string, i: number) => (
                                    <p key={i} className="text-sm font-medium text-gray-900">{line}</p>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Out-of-Network</p>
                                <div className="mt-0.5 space-y-0.5">
                                  {item.costSharing.outOfNetwork?.costDescription
                                    ? item.costSharing.outOfNetwork.costDescription.split("; ").map((line: string, i: number) => (
                                        <p key={i} className="text-sm font-medium text-gray-900">{line}</p>
                                      ))
                                    : <p className="text-sm text-gray-300">&mdash;</p>
                                  }
                                </div>
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

                          {/* Phase 4 Task 4-D: provenance evidence section. When the row has
                              cite-grade verbatim, render the SourceQuote (gold-standard
                              treatment per Q-DR-4E-2 case 1). When state is non-verified,
                              render the VerifyAffordance prompt to upload a more complete
                              plan document. Skipped entirely when no decoration is present
                              (rowDisplay null = flag OFF; preserves byte-identical legacy). */}
                          {/* CF-19 v2 (Session 64): SourceQuote renders only when the row
                              has cite-grade verbatim. Reason discriminates: only
                              from_user_document_cite_grade and community_corroborated (with
                              excerpt) qualify for blockquote treatment. */}
                          {rowDisplay && rowDisplay.excerpt && (rowDisplay.reason === "from_user_document_cite_grade" || rowDisplay.reason === "community_corroborated") && (
                            <SourceQuote excerpt={rowDisplay.excerpt} />
                          )}
                          {rowDisplay && needsUploadCTA(rowDisplay.state) && (
                            <VerifyAffordance
                              state={rowDisplay.state}
                              reason={rowDisplay.reason}
                              planId={result?.insurancePlanId}
                              fieldName="in_copay"
                              serviceSlug={item.serviceSlug || item.benefit.id}
                              searchedSectionsCount={rowDisplay.searchedSectionsCount}
                              userHasDoc={userHasDoc}
                            />
                          )}

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

                          <div className="pt-1 flex items-center justify-between">
                            <p className="text-xs text-gray-400">
                              {isGeneric
                                ? "This is a general benefit estimate. Upload your plan documents to see if your specific plan covers this."
                                : "Contact your insurer or check your plan documents to confirm this benefit is included in your specific plan."
                              }
                            </p>
                            {correctionsEnabled && !isGeneric && result && (result.dataSource === "user_plan" || result.dataSource === "user_plan_with_canonical") && (
                              <button
                                onClick={() => setCorrectionTarget({
                                  benefitId: item.benefit.id,
                                  serviceSlug: item.serviceSlug || item.benefit.id,
                                  title: item.benefit.title,
                                })}
                                className="text-xs text-gray-400 hover:text-amber-600 shrink-0 ml-3 transition-colors"
                              >
                                Flag issue
                              </button>
                            )}
                          </div>

                          {/* Inline correction form */}
                          {correctionTarget?.benefitId === item.benefit.id && (
                            <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                              {correctionSuccess ? (
                                <p className="text-sm text-green-700 font-medium">Correction submitted. Thank you!</p>
                              ) : (
                                <>
                                  <p className="text-xs font-semibold text-amber-900">
                                    Report an issue with &ldquo;{correctionTarget!.title}&rdquo;
                                  </p>
                                  <select
                                    value={correctionField}
                                    onChange={(e) => setCorrectionField(e.target.value)}
                                    className="w-full text-xs p-2 border border-amber-200 rounded-lg bg-white"
                                  >
                                    <option value="copay">Wrong copay</option>
                                    <option value="coinsurance">Wrong coinsurance</option>
                                    <option value="covered">Should be covered / not covered</option>
                                    <option value="prior_auth">Prior auth incorrect</option>
                                    <option value="deductible_applies">Deductible info wrong</option>
                                    <option value="annual_limit">Annual limit incorrect</option>
                                    <option value="other">Other issue</option>
                                  </select>
                                  <input
                                    type="text"
                                    placeholder="Correct value (e.g. $30, 20%, Yes, No)"
                                    value={correctionValue}
                                    onChange={(e) => setCorrectionValue(e.target.value)}
                                    className="w-full text-xs p-2 border border-amber-200 rounded-lg"
                                  />
                                  <input
                                    type="text"
                                    placeholder="Notes (optional)"
                                    value={correctionNotes}
                                    onChange={(e) => setCorrectionNotes(e.target.value)}
                                    className="w-full text-xs p-2 border border-amber-200 rounded-lg"
                                  />
                                  {correctionError && (
                                    <p className="text-xs text-red-600">{correctionError}</p>
                                  )}
                                  <div className="flex gap-2">
                                    <button
                                      onClick={submitCorrection}
                                      disabled={!correctionValue || correctionSubmitting}
                                      className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50"
                                    >
                                      {correctionSubmitting ? "Submitting..." : "Submit"}
                                    </button>
                                    <button
                                      onClick={() => { setCorrectionTarget(null); setCorrectionValue(""); setCorrectionNotes(""); setCorrectionError(""); }}
                                      className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Not Covered section — collapsed by default */}
        {notCoveredItems.length > 0 && (
          <div className="border border-gray-200 rounded-2xl overflow-hidden">
            <button
              onClick={() => setExpandedBenefit(expandedBenefit === "__not_covered_section__" ? null : "__not_covered_section__")}
              className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
                  <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                </div>
                <div className="text-left">
                  <span className="font-semibold text-gray-700">Not Covered</span>
                  <span className="ml-2 text-xs text-gray-400">{notCoveredItems.length} {notCoveredItems.length === 1 ? "service" : "services"} not covered by your plan</span>
                </div>
              </div>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${expandedBenefit === "__not_covered_section__" ? "rotate-180" : ""}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {expandedBenefit === "__not_covered_section__" && (
              <div className="divide-y divide-gray-100">
                {notCoveredItems.map((rawItem) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const item = rawItem as any;
                  return (
                    <div key={item.benefit.id} className="flex items-start gap-3 p-4 bg-gray-50/30">
                      <div className="mt-0.5 w-5 h-5 rounded-md border-2 border-gray-200 flex items-center justify-center shrink-0">
                        <svg className="w-3 h-3 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-gray-500">{item.benefit.title}</h4>
                        {item.coverageConditions && (
                          <p className="mt-0.5 text-sm text-gray-400">{item.coverageConditions}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Plan History (behind plan_year_rollover flag) ────────────────── */}
        {yearRolloverEnabled && historicalPlans.filter(p => !p.is_active).length > 0 && (
          <div className="mt-8">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              <svg className={`w-4 h-4 transition-transform ${showHistory ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              Plan History ({historicalPlans.filter(p => !p.is_active).length} previous {historicalPlans.filter(p => !p.is_active).length === 1 ? "plan" : "plans"})
            </button>

            {showHistory && (
              <div className="mt-3 space-y-2">
                {historicalPlans
                  .filter(p => !p.is_active)
                  .map(p => (
                    <div key={p.id} className="p-3 bg-gray-50 border border-gray-200 rounded-xl flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-700">
                          {p.insurer_name || "Unknown insurer"}
                          {p.plan_name && ` — ${p.plan_name}`}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {p.plan_type && `${p.plan_type} · `}
                          {p.plan_year ? `${p.plan_year} plan year` : `Added ${new Date(p.created_at).toLocaleDateString()}`}
                        </p>
                      </div>
                      <span className="text-[10px] font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                        Inactive
                      </span>
                    </div>
                  ))}
                <p className="text-xs text-gray-400 mt-1">
                  Past plans are preserved permanently. Claims and disputes filed under a previous plan still reference that plan&apos;s benefit data.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
