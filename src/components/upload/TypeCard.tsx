"use client";

/**
 * TypeCard — Bill/Plan picker chrome for /upload (B2-UP.1 port).
 *
 * Implements D-§1.B.1-A (2-tier user-facing pick collapses to Bill / Plan;
 * backend regex classifier + Pattern 1 #16 DocTypeConfirmationModal resolve
 * fine-grained eob vs itemized_bill / sbc vs plan_document). Storage-layer
 * 4-doc-type enum (DocType in doc-type-vocabulary.ts) is UNCHANGED.
 */
import type { ReactNode } from "react";

export interface TypeCardProps {
  active: boolean;
  onClick: () => void;
  tone: "peach" | "mint";
  icon: ReactNode;
  title: string;
  sub: string;
}

const TONE_STYLES: Record<
  TypeCardProps["tone"],
  { iconBg: string; iconInk: string; activeBorder: string; activeBg: string }
> = {
  peach: {
    iconBg: "bg-orange-100",
    iconInk: "text-orange-700",
    activeBorder: "border-orange-400",
    activeBg: "bg-orange-50/60",
  },
  mint: {
    iconBg: "bg-emerald-100",
    iconInk: "text-emerald-700",
    activeBorder: "border-emerald-400",
    activeBg: "bg-emerald-50/60",
  },
};

export function TypeCard({ active, onClick, tone, icon, title, sub }: TypeCardProps) {
  const t = TONE_STYLES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex w-full items-center gap-3 rounded-2xl border-2 p-4 text-left transition-all ${
        active ? `${t.activeBorder} ${t.activeBg}` : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${t.iconBg} ${t.iconInk}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${active ? "text-slate-900" : "text-slate-900"}`}>{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{sub}</div>
      </div>
      {active && (
        <div className={`absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full ${t.iconBg} ${t.iconInk}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
    </button>
  );
}
