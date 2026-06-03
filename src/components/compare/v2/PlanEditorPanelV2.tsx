"use client";

import { cn } from "@/lib/utils/cn";
import { letterFor, planColorFor } from "../compare-colors";
import type { CurrentPlanSummary, SlotState } from "../PlanSlot";
import type { RecentPlan } from "../compare-sessions";
import { ComparePickerV2 } from "./ComparePickerV2";

/**
 * Compare v2 (PR5) — swap/add editor (design PlanEditorPanel, inline-panel default).
 * Reuses ComparePickerV2 to change one results column or add a plan without leaving
 * the results view. Emits a SlotState; the parent resolves it to a ref + re-runs the
 * comparison (search/current → immediate; upload → the parse flow).
 */

interface PlanEditorPanelV2Props {
  isAdd: boolean;
  /** Column index of the plan being changed (for letter/color); the next slot when adding. */
  columnIndex: number;
  targetName?: string | null;
  currentPlan: CurrentPlanSummary | null;
  excludeIds: string[];
  recents: RecentPlan[];
  onPick: (slot: SlotState) => void;
  onClose: () => void;
}

export function PlanEditorPanelV2({
  isAdd,
  columnIndex,
  targetName,
  currentPlan,
  excludeIds,
  recents,
  onPick,
  onClose,
}: PlanEditorPanelV2Props) {
  const color = planColorFor(columnIndex);
  const letter = letterFor(columnIndex);
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4 sm:p-5 mt-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              "shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-white font-bold",
              isAdd ? "bg-slate-400" : color.gradient,
            )}
          >
            {isAdd ? "+" : letter}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              {isAdd ? "Add a plan to compare" : `Change Plan ${letter}`}
            </p>
            {!isAdd && targetName && <p className="text-xs text-slate-500 truncate">Replacing {targetName}</p>}
            {isAdd && (
              <p className="text-xs text-slate-500">Search, upload, or pick a recent — no need to start over.</p>
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-slate-400 hover:text-slate-700">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <ComparePickerV2
        currentPlan={currentPlan}
        excludeIds={excludeIds}
        recents={recents}
        onPick={onPick}
        allowUpload={false}
      />
    </div>
  );
}
