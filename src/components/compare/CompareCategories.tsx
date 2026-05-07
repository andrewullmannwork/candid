"use client";

/**
 * S70 — Service-breadth + service-depth comparison rows.
 *
 * For each known service slug across all compared plans, render one row that
 * shows the in-network cost description per plan. Includes a "breadth"
 * summary card up top that calls out total covered-service counts.
 *
 * Per [[plans/mvp_friday_master]] §S70 + [[Candid_10k]] §3.1:
 *   - Service breadth ("Plan A covers 48; Plan B covers 53")
 *   - Service depth ("Plan A: $30 PCP copay; Plan B: $40 + after deductible")
 */

import { useMemo, useState } from "react";
import {
  decoratedShape,
  DisplayStateBadge,
  unwrapValue,
} from "@/components/display-state";
import type { ComparePlanPayload, CompareBenefit } from "@/lib/plan/compare";

interface CompareCategoriesProps {
  plans: ComparePlanPayload[];
}

const COL_GRID_CLASS: Record<number, string> = {
  3: "grid-cols-[220px_1fr_1fr]",
  4: "grid-cols-[220px_1fr_1fr_1fr]",
};

function colsClass(planCount: number): string {
  return COL_GRID_CLASS[planCount + 1] ?? "grid-cols-[220px_1fr_1fr]";
}

interface RowEntry {
  slug: string;
  title: string;
  category: string;
  /** Indexed by plan order; null when this plan has no row for that slug. */
  perPlan: Array<CompareBenefit | null>;
}

function buildRows(plans: ComparePlanPayload[]): RowEntry[] {
  const slugMap = new Map<string, RowEntry>();
  for (let planIdx = 0; planIdx < plans.length; planIdx++) {
    for (const benefit of plans[planIdx].benefits) {
      let row = slugMap.get(benefit.serviceSlug);
      if (!row) {
        row = {
          slug: benefit.serviceSlug,
          title: benefit.title,
          category: benefit.category,
          perPlan: plans.map(() => null),
        };
        slugMap.set(benefit.serviceSlug, row);
      }
      row.perPlan[planIdx] = benefit;
    }
  }
  // Sort by category then by title.
  return Array.from(slugMap.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.title.localeCompare(b.title);
  });
}

function CostCell({ benefit }: { benefit: CompareBenefit | null }) {
  if (!benefit) {
    return <p className="text-sm text-slate-400 italic">Not in this plan&rsquo;s data</p>;
  }
  if (benefit.covered === false) {
    return <p className="text-sm font-medium text-slate-500">Not covered</p>;
  }
  // Use the in-network cost description for the dominant signal.
  const inDescription = benefit.costInNetworkDescription;
  // Pull state from the in-network copay decoration as a representative signal.
  const copayShape = decoratedShape(benefit.costSharing.inNetwork.copay);
  const coinShape = decoratedShape(benefit.costSharing.inNetwork.coinsurance);
  // Use whichever has a state populated (copay first).
  const state = copayShape.state ?? coinShape.state;
  const reason = copayShape.reason ?? coinShape.reason;
  const priorAuth = unwrapValue(benefit.costSharing.priorAuthRequired);
  return (
    <div>
      <p className="text-sm font-medium text-slate-900">{inDescription}</p>
      <p className="text-xs text-slate-500 mt-0.5">
        OON: {benefit.costOutOfNetworkDescription}
      </p>
      {(state || priorAuth) && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          {state && reason && <DisplayStateBadge state={state} reason={reason} size="xs" />}
          {priorAuth && (
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
              Prior auth
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function CompareCategories({ plans }: CompareCategoriesProps) {
  const rows = useMemo(() => buildRows(plans), [plans]);
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, 12);
  const columnsClass = colsClass(plans.length);

  // Service breadth headline.
  const coveredCounts = plans.map((p) => p.coveredServiceCount);

  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
      {/* Breadth headline */}
      <div className={`grid ${columnsClass} divide-x divide-slate-100`}>
        <div className="p-4 bg-slate-50">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">
            Service breadth
          </p>
          <p className="text-xs text-slate-600 mt-1">
            How many services this plan covers
          </p>
        </div>
        {plans.map((plan, idx) => (
          <div key={plan.ref.id} className="p-4 bg-slate-50">
            <p className="text-2xl font-bold text-slate-900 tabular-nums">{coveredCounts[idx]}</p>
            <p className="text-xs text-slate-500 mt-0.5">covered services on file</p>
          </div>
        ))}
      </div>

      {/* Per-service rows */}
      {visibleRows.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-sm text-slate-500">
            No service-level data on file for these plans yet. Upload an SBC to enrich the comparison.
          </p>
        </div>
      ) : (
        visibleRows.map((row) => (
          <div
            key={row.slug}
            className={`grid ${columnsClass} divide-x divide-slate-100 border-t border-slate-100`}
          >
            <div className="p-4">
              <p className="text-sm font-medium text-slate-700">{row.title}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mt-0.5">{row.category}</p>
            </div>
            {row.perPlan.map((b, idx) => (
              <div key={`${row.slug}-${idx}`} className="p-4">
                <CostCell benefit={b} />
              </div>
            ))}
          </div>
        ))
      )}

      {rows.length > 12 && (
        <div className="border-t border-slate-100 p-4 text-center">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-sm font-semibold text-blue-600 hover:text-blue-700"
          >
            {showAll ? "Show fewer services" : `Show all ${rows.length} services`}
          </button>
        </div>
      )}
    </section>
  );
}
