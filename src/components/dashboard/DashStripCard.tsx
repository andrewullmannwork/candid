"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * DashStripCard — paired plan + upload card row.
 *
 * Replaces today's 4-state full-width plan-verification banner by collapsing
 * those states into card chrome variants per D-§1.C.1-A. Each plan-card variant
 * uses 3 simultaneous visual cues (icon color + ring color + eyebrow copy) to
 * match the attention level the prior banner held — without this rigor, the
 * load-bearing "we need your SBC" / "your doc is processing" signals collapse
 * (Critical Pass note in §1.C.1).
 *
 * Per S112 §1.C.1 Recommendation 2 + styles.css .strip-card-*.
 */

// ─── Plan card ──────────────────────────────────────────────────────────────

type PlanState = "verified" | "unverified" | "processing" | "no_plan";

interface PlanCardProps {
  state: PlanState;
  planName?: string | null;
  /** Optional sub-meta line: "PPO · 2023 · 90 benefits parsed · in-network deductible $5,800" */
  metaLine?: ReactNode;
  /** Optional eyebrow trailer (e.g. "2026 plan year active") for year-rollover distribution. */
  eyebrowSuffix?: string;
  /** Number of pages completed when state="processing". */
  processingCompletedPages?: number;
  /** Number of pages total when state="processing". */
  processingTotalPages?: number;
  /** Where the View / Upload / Set up button navigates. Required. */
  ctaHref: string;
  ctaLabel: string;
}

const PLAN_STATE_STYLES: Record<
  PlanState,
  { ring: string; iconBg: string; iconInk: string; eyebrow: string; eyebrowInk: string }
> = {
  verified: {
    ring: "ring-green-200",
    iconBg: "bg-green-50",
    iconInk: "text-green-700",
    eyebrow: "YOUR PLAN ON FILE",
    eyebrowInk: "text-green-700",
  },
  unverified: {
    ring: "ring-amber-200",
    iconBg: "bg-amber-50",
    iconInk: "text-amber-700",
    eyebrow: "PLAN VERIFICATION NEEDED",
    eyebrowInk: "text-amber-700",
  },
  processing: {
    ring: "ring-blue-200",
    iconBg: "bg-blue-50",
    iconInk: "text-blue-700",
    eyebrow: "PROCESSING YOUR PLAN",
    eyebrowInk: "text-blue-700",
  },
  no_plan: {
    ring: "ring-gray-200",
    iconBg: "bg-gray-100",
    iconInk: "text-gray-600",
    eyebrow: "ADD YOUR PLAN",
    eyebrowInk: "text-gray-600",
  },
};

function PlanIcon({ state }: { state: PlanState }) {
  if (state === "verified") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (state === "unverified") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
    );
  }
  if (state === "processing") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }
  // no_plan
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function DashStripPlanCard({
  state,
  planName,
  metaLine,
  eyebrowSuffix,
  processingCompletedPages,
  processingTotalPages,
  ctaHref,
  ctaLabel,
}: PlanCardProps) {
  const s = PLAN_STATE_STYLES[state];

  const title =
    state === "no_plan"
      ? "Set up your profile"
      : state === "processing"
        ? "Reading your plan document"
        : planName || "Your plan";

  const sub =
    state === "processing"
      ? processingTotalPages && processingTotalPages > 0
        ? `Page ${processingCompletedPages ?? 0} of ${processingTotalPages} — this usually takes a few minutes.`
        : "This usually takes a few minutes. Your benefits will update automatically."
      : state === "no_plan"
        ? "Add your insurance details to see covered benefits."
        : state === "unverified"
          ? "Upload your SBC for accurate, verified benefits."
          : metaLine;

  return (
    <div
      className={cn(
        "flex items-center gap-3.5 flex-wrap p-4 rounded-2xl bg-white ring-1",
        s.ring,
      )}
    >
      <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", s.iconBg, s.iconInk)}>
        <PlanIcon state={state} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "text-[10px] font-bold uppercase tracking-[0.12em]",
            s.eyebrowInk,
          )}
        >
          {s.eyebrow}
          {eyebrowSuffix && <span className="text-gray-500 ml-2 normal-case font-medium">· {eyebrowSuffix}</span>}
        </div>
        <div className="text-sm font-semibold text-gray-900 mt-0.5 truncate">{title}</div>
        {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
      </div>
      <Link
        href={ctaHref}
        className="shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-lg text-gray-700 ring-1 ring-gray-200 bg-white hover:bg-gray-50 transition-colors"
      >
        {ctaLabel}
        <span aria-hidden="true" className="ml-1">›</span>
      </Link>
    </div>
  );
}

// ─── Upload card ────────────────────────────────────────────────────────────

interface UploadCardProps {
  /** Summary line for the eyebrow distribution per D-§1.C.1-D (e.g., "5 documents on file"). */
  summary?: string;
}

export function DashStripUploadCard({ summary }: UploadCardProps) {
  return (
    <div className="flex items-center gap-3.5 flex-wrap p-4 rounded-2xl bg-white ring-1 ring-gray-200">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-blue-50 text-blue-700">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-600">
          UPLOAD ANOTHER BILL
        </div>
        <div className="text-sm font-semibold text-gray-900 mt-0.5">EOB, itemized bill, or statement</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {summary || "Drag in any document — we'll audit it within a minute."}
        </div>
      </div>
      <Link
        href="/upload"
        className="shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
      >
        Upload
      </Link>
    </div>
  );
}
