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
import { PageHeader } from "@/components/page-header";
import { BenefitsScoreboard } from "@/components/benefits-scoreboard";
import { DataSourceContextLine } from "@/components/data-source-context-line";
import { PlanStat } from "@/components/plan/PlanStat";
import { CategoryAccordion } from "@/components/plan/CategoryAccordion";
import { EocPriorAuthCard, EocAboutPlanCard, EocServiceCoverageDetail, type EocServiceItem } from "@/components/plan/EocCoverageRules";
import type { EocReaderSurfaces } from "@/lib/plan/eoc-reader-resolution";

// B3.2 — POS slug render helper. Backend ships 11 canonical slugs (per
// process-plan.ts:1068 + mig 009 CHECK constraint); display rendering is
// frontend-side. Title-case the slug (e.g., outpatient_facility → "Outpatient
// Facility") with 2 overrides where the auto-render reads poorly. No new
// vocabulary — same pattern as the inline title-case fallback used for benefit
// categories at line 793.
function formatPlaceOfService(pos: string | null | undefined): string {
  if (!pos || pos === "any") return "All locations";
  if (pos === "pcp_office") return "Primary care office";
  return pos.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// B3.2 — Matrix verification badge per S126 Advanced Imaging Matrix design.
// Display State v5's 6 visible states collapse to 3 visual tiers for the
// matrix's dense per-row chrome. The full state semantics + cite-grade
// excerpts stay in the API response for the dispute-letter consumer (Pattern
// P-8 preserved at the data layer) — only the /plan display chrome in the
// nested-variant case drops cite-grade affordances in favor of these badges.
// Per Andrew direction S126: "whenever nesting we will drop the UI for the
// cite-grade verification and use badges instead. AND of course we will keep
// the cite-grade for dispute letters." Full lock in
// plans/findings/design-handoffs/s126-advanced-imaging-matrix/README.md.
function MatrixVerifyTag({ state }: { state: DisplayState | null | undefined }) {
  if (state === "candid_verified") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full bg-green-600 text-white whitespace-nowrap">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.6 5 5 1.5-5 1.5L12 16l-1.6-5L5.4 9.5l5-1.5z" />
        </svg>
        Candid Verified
      </span>
    );
  }
  if (state === "user_verified" || state === "user_verified_community") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 whitespace-nowrap">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 13l4 4L19 7" />
        </svg>
        Verified
      </span>
    );
  }
  // community / public_data / estimate / null → estimated
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
      Estimated
    </span>
  );
}

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
  // S202 §9: present only when eoc_reader_resolution_v1 is ON (plan-wide + by-location PA + About).
  eocReader?: EocReaderSurfaces;
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
// B3.2 — AmberBanner + DataSourceBanner DELETED; replaced by the
// <DataSourceContextLine> primitive (B3.1; deferred from B1.2). The primitive
// covers all 7 copy variants the deleted banners covered + matches /dashboard.

// ── Plan Summary Card ──────────────────────────────────────────────────────────

function PlanSummaryCard({ planName, planYear, planSummary, dataSource, insurancePlanId, userHasDoc, insurer }: {
  planName?: string;
  planYear?: number | null;
  planSummary?: AnalyzeResponse["planSummary"];
  dataSource: string;
  insurancePlanId?: string;
  userHasDoc?: boolean;
  insurer?: string;
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

  // B3.2 — Session 77 cite-grade verbatim fallback preserved verbatim; lifted
  // out of the inline IIFE so the renderer can be reused by the new PlanStat
  // 4-grid below.
  const renderDecoratedValue = (
    field: typeof inDed,
    placeholder: string,
  ): React.ReactNode => {
    if (field.state !== null && !isVisibleState(field.state)) {
      return <span className="text-gray-300">&mdash;</span>;
    }
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

  // B3.2 §1.C.2 design — eyebrow + insurer + planName + planType pill + sub +
  // 4-grid PlanStat. PRESERVES Session 73 S71-hotfix-3 aggregation behavior
  // (premium + planType excluded from worst-trumps) + Session 77 cite-grade
  // verbatim fallback + VerifyAffordance worst-signal field per Phase 4.0.5-F.
  const displayTitle = [insurer, planName].filter(Boolean).join(" ") || "Your Plan";

  return (
    <div className="mt-4 p-5 bg-white border border-gray-200 rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">
            Your plan on file
          </p>
          <h3 className="mt-1 text-base font-semibold text-gray-900 leading-tight">
            <span className="truncate">{displayTitle}</span>
            {planType.value && (
              <span className="ml-2 inline-flex align-middle text-[11px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                {planType.value}
                {planSummary.metalLevel && ` · ${planSummary.metalLevel}`}
              </span>
            )}
          </h3>
          {planYear && (
            <p className="mt-0.5 text-xs text-gray-500">{planYear} plan year</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* CF-19 (Session 64): summary-card aggregate badge — verified-tier only;
              S71 hotfix #3 (Session 73) preserved (no legacy verification_status badge). */}
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
        </div>
      )}

      {/* 4-grid PlanStat per §1.C.2 design (collapses to 2-col on narrow). */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <PlanStat label="Deductible (in-network)" value={renderDecoratedValue(inDed, "Upload SBC")} />
        <PlanStat label="Deductible (out-of-network)" value={renderDecoratedValue(outDed, "—")} />
        <PlanStat label="OOP Max (in-network)" value={renderDecoratedValue(inOop, "Upload SBC")} />
        <PlanStat label="OOP Max (out-of-network)" value={renderDecoratedValue(outOop, "—")} />
      </div>
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
  // Auto-expand benefit from URL hash (e.g. /plan#benefit-id). Hashes prefixed
  // with `category-` are reserved for category-section scroll (see useEffect
  // below); they are NOT treated as benefit IDs.
  const [expandedBenefit, setExpandedBenefit] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.slice(1);
    if (!hash || hash.startsWith("category-")) return null;
    return hash;
  });
  // B3.2 — mutually-exclusive single-open category accordion per §1.C.2 design
  // (benefits.jsx `openCat` single-value pattern). Init from URL hash:
  //   #category-<key>  → open that category directly
  //   #<benefit-id>    → category determined post-analyze (effect below)
  const [openCategory, setOpenCategory] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.slice(1);
    if (hash.startsWith("category-")) return hash.slice("category-".length);
    return null;
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
    benefitId: string;    // slug — /api/plan/corrections POST contract
    serviceSlug: string;  // slug — /api/plan/corrections POST contract
    title: string;        // display title — form header copy
    // B3.2 — groupKey = display title within category; used to match active
    // form back to its parent group row at render time. Stable across re-fetches
    // (titles come from service_catalog.name); decoupled from primarySlug which
    // may change if API reorders variants.
    groupKey: string;
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
        const idToken = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({}),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to analyze plan");
        }

        const data: AnalyzeResponse = await res.json();
        setResult(data);

        // Scroll category section into view when arriving from /dashboard tile
        // (B3.1) — hash format `category-<categoryKey>`. Defers one frame so
        // the category sections have rendered with their `id` attributes.
        //
        // B3.2 extension — also handle `#<benefit-id>` deep-link case: find the
        // parent category for that benefit, open that CategoryAccordion, and
        // scroll the row into view (expandedBenefit useState init already set
        // expandedBenefit=hash so the row body shows once the accordion opens).
        if (typeof window !== "undefined") {
          const hash = window.location.hash.slice(1);
          if (hash.startsWith("category-")) {
            requestAnimationFrame(() => {
              const el = document.getElementById(hash);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          } else if (hash) {
            // Per-benefit deep-link — look up category from the analyze response.
            const parent = data.benefits.find((b) => b.benefit.id === hash);
            if (parent) {
              setOpenCategory(parent.benefit.category);
              requestAnimationFrame(() => {
                const el = document.getElementById(`category-${parent.benefit.category}`);
                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLoading(false);
      }
    }

    analyze();

    // Load historical plans + check feature flags (non-critical, parallel)
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
      } catch { /* non-critical — corrections + rollover flags fall back to OFF */ }
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

  // B3.2 — Separate covered vs not-covered, then group covered by category AND
  // display title. Title-based grouping (not benefit.id / slug) is intentional:
  // the backend assigns distinct slugs to some POS-variants of the same
  // user-perceived benefit (e.g., 3 rows titled "Advanced Imaging (CT/PET/MRI)"
  // may have slugs `advanced_imaging` / `advanced_imaging_outpatient` /
  // `advanced_imaging_independent_facility`). Grouping by slug under-merges and
  // leaves visible duplicates that look identical to the user — exactly the
  // bug Andrew flagged. Grouping by title within category catches every
  // perceived duplicate without false-merging across categories (categories are
  // the outer grouping). usedBenefits + expandedBenefit state keys on the
  // group title; correctionTarget.benefitId continues to use the primary
  // variant's actual slug for the /api/plan/corrections POST contract.
  const notCoveredItems: AnalyzedBenefit[] = [];
  const grouped = new Map<string, Map<string, AnalyzedBenefit[]>>();
  for (const item of result.benefits) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((item as any).covered === false) {
      notCoveredItems.push(item);
      continue;
    }
    const cat = item.benefit.category;
    const titleKey = item.benefit.title;
    if (!grouped.has(cat)) grouped.set(cat, new Map());
    const catMap = grouped.get(cat)!;
    if (!catMap.has(titleKey)) catMap.set(titleKey, []);
    catMap.get(titleKey)!.push(item);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coveredBenefits = result.benefits.filter((b) => (b as any).covered !== false);
  // B3.2 — totalUsed counts distinct benefit-titles the user has checked off
  // (not POS-variant rows or distinct slugs). Matches the title-keyed toggle
  // semantics used by the per-group parent rows below.
  const distinctCoveredTitles = new Set(coveredBenefits.map((b) => b.benefit.title));
  const totalUsed = Array.from(distinctCoveredTitles).filter((title) => usedBenefits.has(title)).length;
  const totalCoveredBenefitIds = distinctCoveredTitles.size;

  // B3.2 — HSA-eligible benefit count drives banner copy + visibility gate.
  const hsaEligibleCount = result.benefits.filter((b) => b.benefit.hsaFsaEligible).length;

  // B3.2 — subtitle adapts to plan state. PageHeader sub prop accepts string.
  const headerSub = isGeneric
    ? `General benefits available with most ${result.planType || ""} plans — not specific to your plan.`
    : result.planName
      ? `Benefits your ${result.planName} plan covers. Check off what you\u2019re using.`
      : "Benefits your insurance plan covers. Check off what you\u2019re using to track your progress.";

  return (
    <div className="max-w-3xl">
      <PageHeader title="Your Benefits" sub={headerSub} />

      {/* Data source transparency — methodology disclosure per Pattern 1 #11.
          Replaces S107-era AmberBanner+DataSourceBanner with the B3.1
          DataSourceContextLine primitive for cross-surface consistency
          (/dashboard already uses this). 7 copy variants \u00d7 3 tiers preserved. */}
      <DataSourceContextLine
        dataSource={result.dataSource}
        planSource={(result as unknown as Record<string, unknown>).planSource as string | undefined}
        planType={result.planType}
        verificationStatus={result.planSummary?.verificationStatus}
        className="mt-2 mb-4"
      />

      {/* Plan summary card (only for matched/uploaded plans). NEW chrome per
          \u00a71.C.2 design: eyebrow + insurer/plan + planType pill + 4-grid PlanStat. */}
      <PlanSummaryCard
        planName={result.planName}
        planYear={yearRolloverEnabled ? result.planYear : null}
        planSummary={result.planSummary}
        dataSource={result.dataSource}
        insurancePlanId={result.insurancePlanId}
        userHasDoc={userHasDoc}
        insurer={result.insurer}
      />

      {/* D-§1.C.2-E: inline profile-completeness prompt REMOVED from /plan;
          /dashboard's banner stack (B3.1) governs profile-completeness UX
          across the app. Avoids cross-page banner duplication. */}

      {/* BenefitsScoreboard + HSA banner row per \u00a71.C.2 design. The standalone
          80\u00d780 ring above the accordion is REMOVED per D-\u00a71.C.2-K (embedded
          56\u00d756 ring inside BenefitsScoreboard is the single source of truth). */}
      <div className="mt-6 flex flex-wrap gap-4 items-stretch">
        <div className="flex-[2_1_360px] min-w-0 p-5 bg-white border border-gray-100 rounded-2xl">
          <div className="flex items-center gap-5">
            <BenefitsScoreboard
              verifiedCount={totalUsed}
              totalCount={totalCoveredBenefitIds}
              label=""
              size="md"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">
                {totalUsed === 0
                  ? "Start checking off benefits you use"
                  : totalUsed < totalCoveredBenefitIds / 2
                    ? "Good start — keep discovering"
                    : totalUsed < totalCoveredBenefitIds
                      ? "You\u2019re getting great value"
                      : "You\u2019re maximizing your plan!"}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {totalCoveredBenefitIds - totalUsed} covered benefits you may not be using yet
                {hsaEligibleCount > 0 && (
                  <>
                    {" \u00b7 "}
                    <span className="font-semibold text-purple-700">
                      {hsaEligibleCount} HSA/FSA eligible.
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* HSA banner (D-\u00a71.C.2-C). B-LAND.1 / S130: always clickable; routes
            to /hsa-marketplace (coming-soon stub locked behind overlay; partner
            sign-up form lives there). Flag gate removed per Wire B1 — page is
            locked so no premature reveal. */}
        {hsaEligibleCount > 0 && (
          <Link
            href="/hsa-marketplace?tab=plan"
            className="flex-[1_1_280px] min-w-0 flex items-center gap-3 p-4 bg-purple-50 border border-purple-100 rounded-2xl hover:bg-purple-100/70 hover:border-purple-200 transition-colors"
          >
            <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-purple-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-purple-900 leading-tight">
                {hsaEligibleCount} {hsaEligibleCount === 1 ? "benefit is" : "benefits are"} HSA/FSA eligible
              </p>
              <p className="text-xs text-purple-700 mt-0.5">
                Pay with pre-tax savings — and shop the HSA/FSA marketplace.
              </p>
            </div>
            <svg className="w-4 h-4 text-purple-700 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}
      </div>

      {/* Benefits by category — B3.2 grouped render: one parent row per
          benefit-id (POS variants stacked inside the expanded body). */}
      <div className="mt-6 space-y-4">
        {Array.from(grouped.entries()).map(([category, catMap]) => {
          // Build per-benefit-id groups, dropping benefit-ids whose variants
          // are all hidden-tier. Preserves CF-19 (Session 64) visibility rule
          // at the variant level: a benefit-id stays IFF at least one of its
          // variants would render under flag-ON; flag-OFF falls back to
          // legacy "show all" semantics.
          const groups: Array<{
            // groupKey: within-category grouping key — display title. Stable
            // across renders since titles come from service_catalog.name keyed
            // on benefit slug (see /api/plan/analyze:249-250).
            groupKey: string;
            // primarySlug: actual benefit-id (slug) of the first variant — used
            // for /api/plan/corrections POST contract + the VerifyAffordance
            // serviceSlug fallback. Distinct from groupKey because multiple
            // slugs can share a display title (the whole reason we group by
            // title, not slug).
            primarySlug: string;
            visibleVariants: AnalyzedBenefit[];
            visibleVariantDisplays: Array<ReturnType<typeof computeRowDisplay>>;
            aggregateState: DisplayState | null;
          }> = [];
          for (const [titleKey, variants] of catMap) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const variantDisplays = variants.map((v) => computeRowDisplay(v as any));
            const variantFlagOff = variantDisplays.every((r) => r === null);
            // Per-variant renderability mirrors the pre-B3.2 per-row rule:
            // render when rowDisplay is null (legacy raw — no decoration info)
            // OR the state is in the visible-tier set. The earlier filter that
            // checked only `isVisibleState(displays[i]?.state)` incorrectly
            // dropped null-display variants in mixed-mode groups (where some
            // variants are decorated, others are legacy), which hid 2 of 3 cost
            // variants on /plan benefits like Advanced Imaging and made the
            // group fall back to single-variant render.
            const variantRenderable = variantDisplays.map((d) => d === null || isVisibleState(d.state));
            const visibleVariants = variantFlagOff
              ? variants
              : variants.filter((_, i) => variantRenderable[i]);
            if (visibleVariants.length === 0) continue;
            const visibleVariantDisplays = variantFlagOff
              ? variantDisplays
              : variantDisplays.filter((_, i) => variantRenderable[i]);
            const aggregateState = aggregateRowState(visibleVariantDisplays.map((r) => r?.state ?? null));
            groups.push({
              groupKey: titleKey,
              primarySlug: visibleVariants[0].benefit.id,
              visibleVariants,
              visibleVariantDisplays,
              aggregateState,
            });
          }
          if (groups.length === 0) return null;

          // Whole-category flagOff: true only if every variant in every group
          // has a null rowDisplay (legacy-shape data; pill suppressed).
          const flagOff = groups.every((g) => g.visibleVariantDisplays.every((r) => r === null));
          // Counts in benefit-id terms (one count per benefit-type, not per
          // POS-variant row). Matches user mental model "I used N of M benefit
          // types" and the per-benefit-id toggle/expand semantics below.
          const usedInCategory = groups.filter((g) => usedBenefits.has(g.groupKey)).length;
          const totalInCategory = groups.length;
          const verifiedInCategory = flagOff
            ? undefined
            : groups.filter((g) => g.aggregateState === "candid_verified" || g.aggregateState === "user_verified" || g.aggregateState === "user_verified_community").length;
          // Category-level worst-signal aggregate (across all visible variants
          // in all visible groups) — drives the X-of-Y pill color.
          const categoryAggState = aggregateRowState(groups.flatMap((g) => g.visibleVariantDisplays.map((r) => r?.state ?? null)));
          const safeAggState = categoryAggState && isVisibleState(categoryAggState) ? categoryAggState : null;
          const label = BENEFIT_CATEGORY_LABELS[category as BenefitCategory] || SERVICE_CATEGORY_LABELS[category] || category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          const isOpen = openCategory === category;
          return (
            <CategoryAccordion
              key={category}
              categoryKey={category}
              label={label}
              icon={<CategoryIcon category={category} />}
              usedCount={usedInCategory}
              totalCount={totalInCategory}
              verifiedCount={verifiedInCategory}
              aggregateState={safeAggState}
              open={isOpen}
              onToggle={() => setOpenCategory(isOpen ? null : category)}
            >
              {groups.map((group) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const primary = group.visibleVariants[0] as any;
                  const isUsed = usedBenefits.has(group.groupKey);
                  const isExpanded = expandedBenefit === group.groupKey;
                  const isMultiVariant = group.visibleVariants.length > 1;
                  // Worst-signal variant's display drives SourceQuote /
                  // VerifyAffordance affordances in the single-variant case
                  // (preserves prior PROD behavior). Multi-variant case renders
                  // a per-variant SourceQuote/VerifyAffordance inside each
                  // stacked section instead — see "Cost by location" block.
                  const aggDisplay = group.visibleVariantDisplays.find((r) => r?.state === group.aggregateState) ?? null;
                  return (
                    <div key={group.groupKey} className={`group transition-colors ${isUsed ? "bg-green-50/30 hover:bg-green-50/50" : "bg-white hover:bg-gray-50/80"}`}>
                      <div className="flex items-start gap-3 p-4">
                        {/* Checkbox — toggles benefit-id ("I used this benefit
                            type" — single state shared across all POS variants
                            per S98 intent; rendering is one parent row per
                            benefit-id post-B3.2 so the shared toggle no longer
                            looks like duplicate-row sync). */}
                        <button
                          onClick={() => toggleBenefit(group.groupKey)}
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
                          onClick={() => setExpandedBenefit(isExpanded ? null : group.groupKey)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h4 className={`font-medium ${isUsed ? "text-green-800" : "text-gray-900"}`}>
                                {primary.benefit.title}
                                {isGeneric && (
                                  <span className="ml-2 text-[10px] font-medium text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                                    estimated
                                  </span>
                                )}
                                {/* POS context tag — fires only in the
                                    single-variant case where a specific
                                    placeOfService (non-"any") would otherwise
                                    be invisible to the user (the multi-variant
                                    matrix surfaces POS per row internally; no
                                    need to duplicate in the title row). */}
                                {!isMultiVariant && primary.placeOfService && primary.placeOfService !== "any" && (
                                  <span className="ml-2 text-[10px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded whitespace-nowrap">
                                    {formatPlaceOfService(primary.placeOfService)}
                                  </span>
                                )}
                              </h4>
                              {/* Subtitle: single variant → today's description.
                                  Multi-variant → full per-POS list inline so user
                                  sees the cost-by-location breakdown without
                                  expanding per Andrew direction #2. line-clamp-2
                                  bounds growth on dense rows. */}
                              <p className="mt-0.5 text-sm text-gray-500 line-clamp-2">
                                {isMultiVariant
                                  ? group.visibleVariants.map((v, vi) => {
                                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                      const vRaw = v as any;
                                      const posLabel = formatPlaceOfService(vRaw.placeOfService);
                                      return (
                                        <span key={vi}>
                                          {vi > 0 && " · "}
                                          {posLabel && <span className="font-medium text-gray-700">{posLabel}: </span>}
                                          {v.benefit.description}
                                        </span>
                                      );
                                    })
                                  : primary.benefit.description}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {primary.benefit.hsaFsaEligible && (
                                <span className="text-[10px] font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                                  HSA/FSA
                                </span>
                              )}
                              {/* B3.2 — per-row expand discoverability (Issue 1
                                  hover-affordance bundle): tiny uppercase
                                  "Details" hint rises on row hover; collapses
                                  to chev-only at rest to preserve list density. */}
                              <span
                                className={`hidden sm:inline text-[10px] font-semibold uppercase tracking-wide transition-opacity ${
                                  isExpanded ? "opacity-100 text-gray-500" : "opacity-0 group-hover:opacity-100 text-gray-400"
                                }`}
                              >
                                {isExpanded ? "Hide" : "Details"}
                              </span>
                              <svg
                                className={`w-4 h-4 text-gray-400 transition-all group-hover:text-gray-600 ${isExpanded ? "rotate-180 text-gray-600" : ""}`}
                                fill="none" stroke="currentColor" viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>
                        </button>
                      </div>

                      {/* Expanded body — multi-variant case stacks per-POS
                          sections; single-variant case preserves today's flat
                          layout. Both cases render shared per-benefit prose
                          (howToAccess + whyUnderutilized + disclaimer + Flag
                          issue + correction form) ONCE at the bottom — those
                          fields are per-benefit-id in BENEFITS_CATALOG, not
                          per-POS. */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pl-12 space-y-3">
                          {isMultiVariant ? (
                            // Matrix per S126 Advanced Imaging Matrix design.
                            // Per-variant SourceQuote + VerifyAffordance
                            // intentionally DROPPED from this nested chrome
                            // (badges replace cite-grade affordance per Andrew
                            // direction S126); cite-grade data still surfaces
                            // in API response for dispute-letter consumer.
                            // Single-variant case below keeps full cite-grade
                            // affordance unchanged.
                            <div className="border border-gray-200 rounded-xl overflow-hidden">
                              <div className="grid grid-cols-[1.4fr_1fr_1fr] bg-gray-50 text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
                                <div className="px-4 py-2.5 border-r border-gray-100">Facility</div>
                                <div className="px-4 py-2.5 border-r border-gray-100">In-network</div>
                                <div className="px-4 py-2.5">Out-of-network</div>
                              </div>
                              {group.visibleVariants.map((v, vi) => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const vRaw = v as any;
                                const vDisplay = group.visibleVariantDisplays[vi];
                                const posLabel = formatPlaceOfService(vRaw.placeOfService);
                                const inCost = vRaw.costSharing?.inNetwork?.costDescription;
                                const outCost = vRaw.costSharing?.outOfNetwork?.costDescription;
                                return (
                                  <div key={vi} className="grid grid-cols-[1.4fr_1fr_1fr] border-t border-gray-100">
                                    <div className="px-4 py-3.5 border-r border-gray-100">
                                      <div className="flex flex-col gap-1.5">
                                        <span className="text-[13.5px] font-bold text-gray-900 leading-tight">
                                          {posLabel}
                                        </span>
                                        <div className="flex flex-wrap gap-1">
                                          <MatrixVerifyTag state={vDisplay?.state} />
                                          {vRaw.visitLimit && (
                                            <span className="inline-flex items-center text-[10.5px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full whitespace-nowrap">
                                              {vRaw.visitLimit}
                                            </span>
                                          )}
                                          {vRaw.priorAuthRequired && (
                                            <span className="inline-flex items-center text-[10.5px] font-medium bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full whitespace-nowrap">
                                              Prior auth
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="px-4 py-3.5 border-r border-gray-100">
                                      {inCost ? (
                                        <div className="text-sm font-semibold text-gray-900 tabular-nums space-y-0.5 leading-snug">
                                          {inCost.split("; ").map((line: string, i: number) => (
                                            <p key={i}>{line}</p>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-sm text-gray-400">&mdash;</span>
                                      )}
                                    </div>
                                    <div className="px-4 py-3.5">
                                      {outCost ? (
                                        <div className="text-sm font-semibold text-gray-900 tabular-nums space-y-0.5 leading-snug">
                                          {outCost.split("; ").map((line: string, i: number) => (
                                            <p key={i}>{line}</p>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-sm text-gray-400">&mdash;</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <>
                              {primary.costSharing && (
                                <div className="grid grid-cols-2 gap-3 p-3 bg-gray-50 rounded-xl">
                                  <div>
                                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">In-Network</p>
                                    <div className="mt-0.5 space-y-0.5">
                                      {(primary.costSharing.inNetwork?.costDescription || "Covered").split("; ").map((line: string, i: number) => (
                                        <p key={i} className="text-sm font-medium text-gray-900">{line}</p>
                                      ))}
                                    </div>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Out-of-Network</p>
                                    <div className="mt-0.5 space-y-0.5">
                                      {primary.costSharing.outOfNetwork?.costDescription
                                        ? primary.costSharing.outOfNetwork.costDescription.split("; ").map((line: string, i: number) => (
                                            <p key={i} className="text-sm font-medium text-gray-900">{line}</p>
                                          ))
                                        : <p className="text-sm text-gray-300">&mdash;</p>
                                      }
                                    </div>
                                  </div>
                                </div>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {primary.visitLimit && (
                                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-blue-50 text-blue-700 px-2 py-1 rounded-lg">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    {primary.visitLimit}
                                  </span>
                                )}
                                {primary.priorAuthRequired && (
                                  result?.eocReader ? (
                                    <a
                                      href="#eoc-prior-authorization"
                                      title="See your plan's prior-authorization rules"
                                      className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-700 px-2 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                      </svg>
                                      Prior auth required
                                    </a>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-50 text-amber-700 px-2 py-1 rounded-lg">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                      </svg>
                                      Prior auth required
                                    </span>
                                  )
                                )}
                              </div>
                              {/* S202 §9 Surface 1 — per-service detail + ONE consolidated cite (cost folds into the disclosure when the reader is on) */}
                              <EocServiceCoverageDetail
                                item={primary as unknown as EocServiceItem}
                                costQuote={result?.eocReader && aggDisplay && aggDisplay.excerpt && (aggDisplay.reason === "from_user_document_cite_grade" || aggDisplay.reason === "community_corroborated") ? aggDisplay.excerpt : undefined}
                              />
                              {!result?.eocReader && aggDisplay && aggDisplay.excerpt && (aggDisplay.reason === "from_user_document_cite_grade" || aggDisplay.reason === "community_corroborated") && (
                                <SourceQuote excerpt={aggDisplay.excerpt} />
                              )}
                              {aggDisplay && needsUploadCTA(aggDisplay.state) && (
                                <VerifyAffordance
                                  state={aggDisplay.state}
                                  reason={aggDisplay.reason}
                                  planId={result?.insurancePlanId}
                                  fieldName="in_copay"
                                  serviceSlug={primary.serviceSlug || group.primarySlug}
                                  searchedSectionsCount={aggDisplay.searchedSectionsCount}
                                  userHasDoc={userHasDoc}
                                />
                              )}
                            </>
                          )}

                          {/* Relevance note (when no cost grid — for generic
                              benefits). Per-benefit-id (catalog-derived). */}
                          {!primary.costSharing && primary.relevanceNote && (
                            <div className="p-3 bg-blue-50 rounded-xl">
                              <p className="text-sm text-blue-800">
                                <span className="font-medium">For your plan:</span>{" "}
                                {primary.relevanceNote}
                              </p>
                            </div>
                          )}

                          {/* Shared per-benefit prose (rendered ONCE for the
                              group — howToAccess + whyUnderutilized live in
                              BENEFITS_CATALOG keyed on benefit-id, not POS). */}
                          {primary.benefit.howToAccess && (
                            <div>
                              <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                How to access this benefit
                              </h5>
                              <p className="mt-1 text-sm text-gray-600">
                                {primary.benefit.howToAccess}
                              </p>
                            </div>
                          )}

                          {primary.benefit.whyUnderutilized && (
                            <div>
                              <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                Why people miss this
                              </h5>
                              <p className="mt-1 text-sm text-gray-600">
                                {primary.benefit.whyUnderutilized}
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
                                  benefitId: group.primarySlug,
                                  serviceSlug: primary.serviceSlug || group.primarySlug,
                                  title: primary.benefit.title,
                                  groupKey: group.groupKey,
                                })}
                                className="text-xs text-gray-400 hover:text-amber-600 shrink-0 ml-3 transition-colors"
                              >
                                Flag issue
                              </button>
                            )}
                          </div>

                          {/* Inline correction form */}
                          {correctionTarget?.groupKey === group.groupKey && (
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
            </CategoryAccordion>
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

        {/* S202 §9 Surface 2 — plan-level prior-auth card (bottom, above About; #eoc-prior-authorization deep-link target) */}
        {result?.eocReader && (result.eocReader.priorAuth.requires.length > 0 || result.eocReader.priorAuth.noApproval.length > 0) && (
          <EocPriorAuthCard anchorId="eoc-prior-authorization" requires={result.eocReader.priorAuth.requires} noApproval={result.eocReader.priorAuth.noApproval} />
        )}

        {/* S202 §9 Surface 3 — "Good to know" member info (collapsed) */}
        {result?.eocReader && result.eocReader.aboutGroups.length > 0 && (
          <EocAboutPlanCard groups={result.eocReader.aboutGroups} />
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
