"use client";

/**
 * S70 — Per-plan identity header card. Used inside CompareHeader at the top of
 * each column to render the insurer / plan-name / metal / year / "Your plan"
 * tag stack in a consistent treatment.
 *
 * Also used as an "empty column" placeholder when a planRef failed to resolve
 * (lookup miss or 404) so the rest of the comparison table still aligns.
 */

import type { ComparePlanPayload } from "@/lib/plan/compare";

interface PlanColumnProps {
  plan: ComparePlanPayload | null;
  /** Fallback display name when plan is null (e.g., "Plan B"). */
  fallbackLabel?: string;
}

export function PlanColumn({ plan, fallbackLabel = "Couldn't load" }: PlanColumnProps) {
  if (!plan) {
    return (
      <div className="p-4 bg-slate-50">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          {fallbackLabel}
        </p>
        <p className="text-sm text-slate-400 mt-0.5">
          We couldn&rsquo;t pull data for this plan. Try a different selection.
        </p>
      </div>
    );
  }
  return (
    <div className="p-4 bg-slate-50">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide truncate">
        {plan.insurerName || "—"}
      </p>
      <p className="text-sm font-semibold text-slate-900 mt-0.5 truncate" title={plan.planName}>
        {plan.planName}
      </p>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
        {plan.planSummary.metalLevel && (
          <span className="inline-block uppercase tracking-wide">{plan.planSummary.metalLevel}</span>
        )}
        {plan.planSummary.metalLevel && plan.planSummary.year && <span>·</span>}
        {plan.planSummary.year && <span>{plan.planSummary.year}</span>}
        {plan.sourceLabel === "user_plan" && (
          <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
            Your plan
          </span>
        )}
      </div>
      {plan.bestForTags && plan.bestForTags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {plan.bestForTags.map((tag) => (
            <span
              key={tag.key}
              title={tag.why}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 ring-1 ring-blue-200"
            >
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l2.39 7.36H22l-6.18 4.49 2.36 7.36L12 16.71l-6.18 4.5 2.36-7.36L2 9.36h7.61z" />
              </svg>
              {tag.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
