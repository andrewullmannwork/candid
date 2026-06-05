"use client";

import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import type { AverageShare, Badge } from "../cost-model";
import { usd } from "../compare-aggregates";
import { cardsGridLgClass } from "../compare-grid";
import { letterFor, planColorFor } from "../compare-colors";
import { CompareRankBadge } from "./CompareRankBadge";

/**
 * Compare v2 (PR3) — bill-mode controls (design .cmp-billbar):
 *   • "If a bill comes to $___" input + quick presets ($500 / $2.5k / $10k / $35k)
 *   • "Deductible already met this year" iOS-style switch
 *   • the column-aligned "Average you'd pay" per-plan band (Lowest/Highest average)
 *
 * The totals band uses cardsGridLgClass so it lines up with the plan summary cards
 * above (design: column-aligned). Each per-plan figure is the AVERAGE member share
 * across that plan's in-network services (never a sum — a single bill's share can't
 * exceed the bill), computed upstream in ResultsViewV2 and passed in.
 */

const PRESETS = [500, 2500, 10000, 35000] as const;

function presetLabel(v: number): string {
  return v >= 1000 ? `$${v / 1000}k` : `$${v}`;
}

interface BillControlsV2Props {
  bill: number;
  setBill: (n: number) => void;
  dedMet: boolean;
  setDedMet: (b: boolean) => void;
  plans: ComparePlanPayload[];
  grandTotals: AverageShare[];
  totalBadges: Badge[];
}

export function BillControlsV2({
  bill,
  setBill,
  dedMet,
  setDedMet,
  plans,
  grandTotals,
  totalBadges,
}: BillControlsV2Props) {
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-4 sm:p-5 mt-4 shadow-sm">
      <div className="flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-8">
        {/* bill input + presets */}
        <div className="min-w-0">
          <label
            htmlFor="cmp-bill"
            className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5"
          >
            If a bill comes to
          </label>
          <div className="flex items-center gap-1 rounded-xl ring-1 ring-slate-200 bg-slate-50 px-3 py-2 w-fit">
            <span className="text-lg font-semibold text-slate-400">$</span>
            <input
              id="cmp-bill"
              type="number"
              min={0}
              step={50}
              value={bill}
              onChange={(e) => setBill(Math.max(0, Math.round(+e.target.value || 0)))}
              className="w-28 bg-transparent text-lg font-semibold text-slate-900 tabular-nums focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {PRESETS.map((v) => {
              const active = bill === v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBill(v)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors",
                    active
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                  )}
                >
                  {presetLabel(v)}
                </button>
              );
            })}
          </div>
        </div>

        {/* deductible-met switch */}
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={dedMet}
            aria-label="Deductible already met this year"
            onClick={() => setDedMet(!dedMet)}
            className={cn(
              "relative shrink-0 mt-0.5 w-10 h-6 rounded-full transition-colors",
              dedMet ? "bg-blue-600" : "bg-slate-300",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform",
                dedMet && "translate-x-4",
              )}
            />
          </button>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800">
              Deductible already met this year
            </span>
            <span className="block text-[12px] text-slate-500 leading-snug">
              {dedMet
                ? "Coverage applies right away"
                : "Off — you pay the bill until each plan's deductible is hit"}
            </span>
          </span>
        </label>
      </div>

      {/* Average you'd pay — column-aligned with the summary cards above */}
      <div
        className={cn(
          "grid grid-cols-1 gap-3 mt-5 pt-5 border-t border-slate-100",
          cardsGridLgClass(plans.length),
        )}
      >
        <div className="hidden lg:flex items-center">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 leading-tight">
            Average
            <br />
            you&rsquo;d pay
          </span>
        </div>
        {plans.map((plan, idx) => {
          const total = grandTotals[idx];
          const badge = totalBadges[idx];
          return (
            <div
              key={`${plan.ref.id}-${idx}`}
              className={cn(
                "rounded-xl p-3 ring-1",
                badge === "best"
                  ? "ring-emerald-200 bg-emerald-50/40"
                  : badge === "worst"
                    ? "ring-amber-200 bg-amber-50/40"
                    : "ring-slate-200 bg-slate-50/60",
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={cn(
                    "shrink-0 w-6 h-6 rounded-md text-white text-[11px] font-bold flex items-center justify-center",
                    planColorFor(idx).gradient,
                  )}
                  aria-hidden="true"
                >
                  {letterFor(idx)}
                </span>
                <span className="text-[12px] font-medium text-slate-600 truncate">
                  {plan.planName}
                </span>
              </div>
              <div className="text-xl font-bold text-slate-900 tabular-nums">
                {total.avg == null ? "—" : usd(total.avg)}
              </div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <CompareRankBadge kind={badge} bestLabel="Lowest average" worstLabel="Highest average" />
                {total.capped && <span className="text-[10px] text-slate-400">capped at OOP max</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
