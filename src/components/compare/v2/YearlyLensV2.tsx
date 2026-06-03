"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { usd } from "../compare-aggregates";
import { rankBadges, type Badge } from "../cost-model";
import {
  YEARLY_UNITS,
  billedFromUnits,
  estimateYearlyFromUnits,
  householdPeople,
  unitCountsFor,
  type Household,
  type UsageLevel,
} from "../yearly-model";
import { letterFor, planColorFor } from "../compare-colors";
import { CompareRankBadge } from "./CompareRankBadge";

/**
 * Compare v2 (PR4) — "Estimated cost for a year" lens (design YearlyLens), copay
 * tab only. Drives the APPROVED basket engine (estimateYearlyFromUnits — copay-vs-
 * coinsurance per real rule, §11) from intuitive-unit + household inputs; premium is
 * the member's effective premium (confirmed or ghost).
 *
 * VERDICT GUARDRAIL (§4.1): the per-plan TOTAL Lowest/Highest badge renders ONLY
 * when every plan's premium is grounded; otherwise the lens ranks CARE cost (solid)
 * and softens the total — a fabricated premium can never crown a winner.
 */

const USAGE_LABELS: Record<UsageLevel, string> = {
  healthy: "Healthy",
  average: "Average",
  heavy: "Heavy use",
};

interface YearlyLensV2Props {
  plans: ComparePlanPayload[];
  effPremium: (plan: ComparePlanPayload) => number | null;
  premiumGrounded: (plan: ComparePlanPayload) => boolean;
  usage: UsageLevel;
  setUsage: (u: UsageLevel) => void;
  household: Household;
  setHousehold: (h: Household) => void;
  unitOverrides: Record<string, number> | null;
  setUnitOverrides: (o: Record<string, number> | null) => void;
}

export function YearlyLensV2({
  plans,
  effPremium,
  premiumGrounded,
  usage,
  setUsage,
  household,
  setHousehold,
  unitOverrides,
  setUnitOverrides,
}: YearlyLensV2Props) {
  const [showAdjust, setShowAdjust] = useState(false);
  if (plans.length < 2) return null;

  const people = householdPeople(household);
  const isFamily = people > 1;
  const counts = unitCountsFor(usage, household, unitOverrides);
  const billed = billedFromUnits(counts);
  const isAdjusted = unitOverrides != null;

  const ests = plans.map((p) =>
    estimateYearlyFromUnits(p, {
      usage,
      household,
      unitOverrides,
      premiumMonthly: effPremium(p),
      familyDeductible: p.planSummary.inDeductibleFamily,
      familyOop: p.planSummary.inOopMaxFamily,
    }),
  );
  const allGrounded = plans.every((p) => premiumGrounded(p));
  // Guardrail: badge the TOTAL only when every premium is grounded; else rank CARE.
  const verdictBadges: Badge[] = allGrounded
    ? rankBadges(ests.map((e) => (e.total == null ? Infinity : e.total)))
    : rankBadges(ests.map((e) => e.care));
  const maxTotal = Math.max(1, ...ests.map((e) => e.total ?? e.care));

  const setUsageReset = (u: UsageLevel) => {
    setUsage(u);
    setUnitOverrides(null);
  };
  const setHH = (patch: Partial<Household>) => {
    setHousehold({ ...household, ...patch });
    setUnitOverrides(null);
  };
  const setUnit = (key: string, v: string) =>
    setUnitOverrides({ ...(unitOverrides ?? {}), [key]: Math.max(0, Math.round(Number(v) || 0)) });

  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-4 sm:p-5 mt-4 shadow-sm">
      {/* header + usage selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Estimated cost for a year</h3>
          <p className="text-[12px] text-slate-500">
            Premiums plus your share of care{isFamily ? ", for your household" : ""}.
          </p>
        </div>
        <div role="tablist" aria-label="Usage level" className="inline-flex rounded-lg bg-slate-100 p-1 gap-1">
          {(Object.keys(USAGE_LABELS) as UsageLevel[]).map((k) => {
            const active = usage === k && !isAdjusted;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setUsageReset(k)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-semibold transition-colors",
                  active
                    ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                    : "text-slate-500 hover:text-slate-700",
                )}
              >
                {USAGE_LABELS[k]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Who's covered */}
      <div className="flex items-center gap-2 flex-wrap mt-3">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Who&rsquo;s covered</span>
        <button
          type="button"
          onClick={() => setHH({ spouse: false, kids: 0 })}
          className={cn(
            "px-2.5 py-1 rounded-full text-xs font-semibold ring-1",
            !household.spouse && !household.kids
              ? "bg-blue-600 text-white ring-blue-600"
              : "bg-white text-slate-600 ring-slate-200",
          )}
        >
          Just me
        </button>
        <button
          type="button"
          onClick={() => setHH({ spouse: !household.spouse })}
          className={cn(
            "px-2.5 py-1 rounded-full text-xs font-semibold ring-1",
            household.spouse ? "bg-blue-600 text-white ring-blue-600" : "bg-white text-slate-600 ring-slate-200",
          )}
        >
          + Spouse
        </button>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ring-1 ring-slate-200 bg-white">
          <span className="text-xs text-slate-500">Kids</span>
          <button
            type="button"
            aria-label="Fewer kids"
            onClick={() => setHH({ kids: Math.max(0, (household.kids || 0) - 1) })}
            className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 text-sm leading-none"
          >
            −
          </button>
          <span className="text-xs font-semibold text-slate-700 w-3 text-center">{household.kids || 0}</span>
          <button
            type="button"
            aria-label="More kids"
            onClick={() => setHH({ kids: Math.min(3, (household.kids || 0) + 1) })}
            className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 text-sm leading-none"
          >
            +
          </button>
        </span>
        {isFamily && (
          <span className="text-[11px] text-slate-400">{people} people · family deductible &amp; OOP applied</span>
        )}
      </div>

      {/* per-plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
        {plans.map((p, j) => {
          const e = ests[j];
          const badge = verdictBadges[j];
          const premPct = e.premiumAnnual ? Math.round((e.premiumAnnual / maxTotal) * 100) : 0;
          const carePct = Math.round((e.care / maxTotal) * 100);
          const rough = e.servicesTotal > 0 && e.dataCoverage < 0.7;
          return (
            <div
              key={`${p.ref.id}-${j}`}
              className={cn(
                "rounded-xl p-3 ring-1",
                badge === "best"
                  ? "ring-emerald-200 bg-emerald-50/40"
                  : badge === "worst"
                    ? "ring-amber-200 bg-amber-50/40"
                    : "ring-slate-200",
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={cn(
                    "shrink-0 w-6 h-6 rounded-md text-white text-[11px] font-bold flex items-center justify-center",
                    planColorFor(j).gradient,
                  )}
                  aria-hidden="true"
                >
                  {letterFor(j)}
                </span>
                <span className="text-[12px] font-medium text-slate-600 truncate">{p.planName}</span>
                <CompareRankBadge kind={badge} bestLabel="Lowest" worstLabel="Highest" className="ml-auto" />
              </div>
              <div className="text-xl font-bold text-slate-900 tabular-nums">
                {e.total != null ? usd(e.total) : usd(e.care)}
                <span className="text-[11px] font-normal text-slate-400">
                  {e.total != null ? "/yr est." : "/yr care"}
                </span>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-slate-100 mt-2">
                <div className="bg-blue-400" style={{ width: `${premPct}%` }} />
                <div className="bg-emerald-400" style={{ width: `${carePct}%` }} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1">
                <span>
                  <i className="inline-block w-2 h-2 rounded-sm bg-blue-400 mr-1" />
                  Premium {e.premiumAnnual != null ? usd(e.premiumAnnual) : "—"}
                </span>
                <span>
                  <i className="inline-block w-2 h-2 rounded-sm bg-emerald-400 mr-1" />
                  Care {usd(e.care)}
                </span>
              </div>
              <div className={cn("text-[11px] mt-1.5", rough ? "text-amber-600" : "text-slate-400")}>
                {rough && "⚠ "}
                Based on {e.servicesWithData} of {e.servicesTotal} services with plan data
              </div>
            </div>
          );
        })}
      </div>

      {!allGrounded && (
        <p className="text-[11px] text-slate-500 mt-3">
          Ranking by <strong>care cost</strong> — confirm every plan&rsquo;s premium above for a total-cost verdict.
        </p>
      )}

      {/* Adjust my care */}
      <div className="mt-4 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => setShowAdjust((s) => !s)}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700"
        >
          <svg
            className={cn("w-3.5 h-3.5 transition-transform", showAdjust && "rotate-90")}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {showAdjust ? "Hide my care inputs" : "Adjust my care"}
          {isAdjusted && (
            <span className="px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-700 text-[10px] font-bold uppercase">
              Customized
            </span>
          )}
        </button>
        {showAdjust && (
          <div className="mt-3">
            <p className="text-[12px] text-slate-500 mb-2">
              How much care do you{isFamily ? " and your household" : ""} expect this year? Enter counts you actually
              know — grey values are typical {USAGE_LABELS[usage].toLowerCase()} defaults.
              {isAdjusted && (
                <button
                  type="button"
                  onClick={() => setUnitOverrides(null)}
                  className="ml-2 text-blue-600 hover:text-blue-700 font-semibold"
                >
                  Reset to typical
                </button>
              )}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {YEARLY_UNITS.map((u) => {
                const overridden = unitOverrides != null && unitOverrides[u.key] != null;
                return (
                  <label
                    key={u.key}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg ring-1 px-2.5 py-1.5",
                      overridden ? "ring-blue-200 bg-blue-50/40" : "ring-slate-200",
                    )}
                  >
                    <span className="text-[12px] text-slate-600 min-w-0 truncate">{u.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={counts[u.key]}
                        aria-label={u.label}
                        onChange={(ev) => setUnit(u.key, ev.target.value)}
                        className={cn(
                          "w-12 text-right bg-white rounded-md ring-1 ring-slate-200 px-1.5 py-0.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400",
                          overridden ? "text-blue-700 font-semibold" : "text-slate-700",
                        )}
                      />
                      <span className="text-[10px] text-slate-400 w-14">{u.unit}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="text-[12px] text-slate-500 mt-2">
              Adds up to <strong className="text-slate-700">{usd(billed)}/yr</strong> of care
              <span className="text-[11px] text-slate-400 ml-1">({isAdjusted ? "your numbers" : "illustrative"})</span>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed mt-3">
        Estimate for {usd(billed)} of care a year{isFamily ? ` across ${people} people` : ""}: you pay toward each
        plan&rsquo;s{isFamily ? " family " : " "}deductible first, then its own average coinsurance (
        {plans.map((p, j) => `${letterFor(j)} ${Math.round(ests[j].coinsuranceUsed * 100)}%`).join(" · ")}), capped at
        the out-of-pocket max. Premiums are as entered{isFamily ? " — set a household premium above for a precise total" : ""}.
        Use it to compare, not to budget.
      </p>
    </div>
  );
}
