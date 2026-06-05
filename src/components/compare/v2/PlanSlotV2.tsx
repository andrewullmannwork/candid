"use client";

import { cn } from "@/lib/utils/cn";
import { letterFor, planColorFor } from "../compare-colors";
import type { CurrentPlanSummary, SlotState } from "../PlanSlot";
import type { RecentPlan } from "../compare-sessions";
import { ComparePickerV2 } from "./ComparePickerV2";

/**
 * Compare v2 (PR5) — design-faithful plan slot (.cmp-slot). Header avatar + the
 * reusable ComparePickerV2 when empty, or a green "Selected" card when committed.
 * Same SlotState contract as the v1 PlanSlot (drop-in for the parent's handlers);
 * v1 PlanSlot is untouched (flag-OFF byte-identical).
 */

interface PlanSlotV2Props {
  index: number;
  optional: boolean;
  currentPlan: CurrentPlanSummary | null;
  state: SlotState;
  /** Canonical/plan ids already chosen in other slots (excluded from search). */
  excludeIds: string[];
  recents: RecentPlan[];
  onChange: (next: SlotState) => void;
}

export function PlanSlotV2({
  index,
  optional,
  currentPlan,
  state,
  excludeIds,
  recents,
  onChange,
}: PlanSlotV2Props) {
  const letter = letterFor(index);
  const color = planColorFor(index);

  const committed =
    state.kind === "current"
      ? {
          eyebrow: "Your current plan",
          title: state.plan.planName,
          sub: [state.plan.insurerName, state.plan.planType, state.plan.metalLevel, state.plan.state]
            .filter(Boolean)
            .join(" · "),
        }
      : state.kind === "search" && state.selected
        ? {
            eyebrow: "From plan search",
            title: state.selected.name,
            sub: [state.selected.insurerName, state.selected.type, state.selected.metalLevel, state.selected.state]
              .filter(Boolean)
              .join(" · "),
          }
        : state.kind === "upload" && state.file
          ? {
              eyebrow: "Document upload",
              title: state.file.name,
              sub: `${Math.round(state.file.size / 1024).toLocaleString()} KB · PDF · parses on Compare`,
            }
          : null;

  return (
    <div className="relative bg-white rounded-3xl ring-1 ring-slate-200 shadow-sm p-5 sm:p-6 min-h-[340px] flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <div
          className={cn(
            "w-10 h-10 rounded-2xl flex items-center justify-center text-white font-bold shadow-sm",
            color.gradient,
          )}
        >
          {letter}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            Plan {letter}
            {optional && <span className="text-xs font-normal text-slate-400 ml-1">(optional)</span>}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {committed
              ? "Selected"
              : letter === "A"
                ? "Pick your first plan"
                : letter === "B"
                  ? "Pick another plan"
                  : "Add a third for a richer comparison"}
          </p>
        </div>
        {committed && (
          <button
            type="button"
            onClick={() => onChange({ kind: "empty" })}
            aria-label="Clear selection"
            className="shrink-0 text-slate-400 hover:text-rose-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {committed ? (
        <div className="flex-1 rounded-2xl bg-gradient-to-br from-emerald-50 via-white to-emerald-50 ring-1 ring-emerald-200 p-4 flex items-start gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center mt-0.5">
            <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">{committed.eyebrow}</p>
            <p className="text-sm font-semibold text-slate-900 break-words mt-0.5">{committed.title}</p>
            {committed.sub && <p className="text-xs text-slate-500 mt-0.5 break-words">{committed.sub}</p>}
          </div>
        </div>
      ) : (
        <ComparePickerV2
          currentPlan={index === 0 ? currentPlan : null}
          excludeIds={excludeIds}
          recents={recents}
          onPick={onChange}
        />
      )}
    </div>
  );
}
