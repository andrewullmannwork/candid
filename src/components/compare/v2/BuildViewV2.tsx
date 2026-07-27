"use client";

import Link from "next/link";
import type { CurrentPlanSummary, SlotState } from "../PlanSlot";
import type { RecentPlan } from "../compare-sessions";
import { PlanSlotV2 } from "./PlanSlotV2";

/**
 * Compare v2 (PR5) — the reskinned build/picker view (hero + 3 PlanSlotV2 +
 * "Pick up where you left off"). Pure presentation over the parent's existing
 * build state + handlers; the consent gate, submit CTA, and Turnstile mount stay
 * in page.tsx (shared, unchanged). Rendered only when compare_v2_redesign is ON;
 * the v1 build JSX is untouched.
 */

/** Canonical/plan ids chosen in OTHER slots — excluded from this slot's search. */
function otherSelectedIds(slots: SlotState[], idx: number): string[] {
  const ids: string[] = [];
  slots.forEach((s, i) => {
    if (i === idx) return;
    if (s.kind === "search" && s.selected) ids.push(s.selected.canonicalPlanId ?? s.selected.id);
    if (s.kind === "current") ids.push(s.plan.canonicalPlanId ?? s.plan.insurancePlanId);
  });
  return ids;
}

interface BuildViewV2Props {
  slots: SlotState[];
  setSlot: (i: number, s: SlotState) => void;
  currentPlan: CurrentPlanSummary | null;
  recents: RecentPlan[];
}

export function BuildViewV2({ slots, setSlot, currentPlan, recents }: BuildViewV2Props) {
  return (
    <div>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700 mb-6"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to dashboard
      </Link>

      <div className="text-center mb-8 sm:mb-10">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 px-3 py-1 rounded-full ring-1 ring-blue-100 mb-5">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l2.39 7.36H22l-6.18 4.49 2.36 7.36L12 16.71l-6.18 4.5 2.36-7.36L2 9.36h7.61z" />
          </svg>
          New · Candid Compare
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 tracking-tight">
          Compare your plans, side by side.
        </h1>
        <p className="text-base sm:text-lg text-slate-600 mt-4 max-w-xl mx-auto leading-relaxed">
          Premiums, deductibles, OOP max, and what you&rsquo;d actually pay for a bill — every number traced to
          the source. Your plan, plus up to two others.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        {slots.map((slot, idx) => (
          <PlanSlotV2
            key={idx}
            index={idx}
            optional={idx === 2}
            currentPlan={currentPlan}
            state={slot}
            excludeIds={otherSelectedIds(slots, idx)}
            recents={recents}
            onChange={(next) => setSlot(idx, next)}
          />
        ))}
      </div>

      {/* S289 (Andrew) — the sessions bar ("Pick up where you left off")
          moved to page.tsx BELOW the submit CTA: the primary action reads
          first, saved comparisons second. */}
    </div>
  );
}
