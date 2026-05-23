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
 *
 * Session 72 v2 (per user direction): per-row badges are NOISY at the service
 * level (dozens of rows × 5 badge variants = visual chatter). Replaced with a
 * single bottom-aligned aggregate badge cluster per plan column showing the
 * UNIQUE sources represented across that plan's services. Verified trumps —
 * if any service hits Verified, only that badge shows.
 */

import { useMemo, useState } from "react";
import {
  decoratedShape,
  DisplayStateBadge,
  unwrapValue,
} from "@/components/display-state";
import type { DisplayState, DisplayStateReason } from "@/components/display-state";
import type { ComparePlanPayload, CompareBenefit } from "@/lib/plan/compare";

interface CompareCategoriesProps {
  plans: ComparePlanPayload[];
}

// Representative reason per state, used for tooltip hover on the aggregate
// cluster badges (the cluster doesn't have a single canonical reason since
// it represents many services).
const REPRESENTATIVE_REASON: Record<DisplayState, DisplayStateReason | null> = {
  candid_verified: "community_corroborated",
  user_verified_community: "from_user_document_smart_skip", // CF-40 v4 dual-badge tier
  user_verified: "from_user_document_cite_grade",
  community: "canonical_below_threshold",
  public_data: "cms_marketplace",
  estimate: "inferred_from_similar_plans", // v5 (S119 B1.3a) — inferred values; weaker than Public Data
  hidden: null,
};

const AGGREGATE_TOOLTIP: Record<DisplayState, string> = {
  candid_verified: "Some services on this plan are Verified — corroborated by ≥3 Candid users.",
  user_verified_community: "Some services on this plan match a multi-parse-stable canonical — your upload contributed; community parses corroborate.",
  user_verified: "Some services on this plan came from your uploaded plan document or values you typed/confirmed yourself.",
  community: "Some services on this plan came from another Candid user's parse on this canonical.",
  public_data: "Some services on this plan came from public datasets (CMS, etc.) — upload your SBC for the real story.",
  estimate: "Some services on this plan are Estimates inferred from similar plans — upload your SBC for the real number.", // v5 (S119 B1.3a)
  hidden: "",
};

// MUST match CompareHeader's COL_GRID_CLASS exactly so top + service-section
// grids align column-for-column across viewports. Session 72 v3: tightened to
// minmax(120px,160px) so plan columns get more horizontal real estate.
const COL_GRID_CLASS: Record<number, string> = {
  3: "grid-cols-[minmax(120px,160px)_1fr_1fr]",
  4: "grid-cols-[minmax(120px,160px)_1fr_1fr_1fr]",
};

function colsClass(planCount: number): string {
  return COL_GRID_CLASS[planCount + 1] ?? "grid-cols-[minmax(120px,160px)_1fr_1fr]";
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
  // Sort priority:
  //   1. Useful tier (≥1 plan covers the service) above non-useful tier (0 plans
  //      cover) — keeps "covered/covered", "covered/not-covered", and
  //      "covered/no-data" rows at the top; pushes "not-covered/not-covered",
  //      "no-data/no-data", and "not-covered/no-data" rows to the bottom where
  //      they're easy to skip.
  //   2. Within the useful tier, more-covered first (covered/covered ahead of
  //      covered/not-covered).
  //   3. Tie-break by category + title for stable alphabetical ordering.
  return Array.from(slugMap.values()).sort((a, b) => {
    const aCovered = a.perPlan.filter((p) => p?.covered === true).length;
    const bCovered = b.perPlan.filter((p) => p?.covered === true).length;
    const aUseful = aCovered > 0;
    const bUseful = bCovered > 0;
    if (aUseful !== bUseful) return aUseful ? -1 : 1;
    if (aUseful && aCovered !== bCovered) return bCovered - aCovered;
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
  const inDescription = benefit.costInNetworkDescription;
  const priorAuth = unwrapValue(benefit.costSharing.priorAuthRequired);
  // Session 72 v2: per-cell badge removed — aggregated at section bottom.
  // Prior-auth pill stays inline since it's per-service, not source-related.
  return (
    <div>
      <p className="text-sm font-medium text-slate-900">{inDescription}</p>
      <p className="text-xs text-slate-500 mt-0.5">
        OON: {benefit.costOutOfNetworkDescription}
      </p>
      {priorAuth && (
        <div className="mt-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            Prior auth
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Compute the unique set of display states across all of a single plan's
 * service-row decorations. Returns the set ordered worst → best so that the
 * bottom cluster reads consistently. If any service is candid_verified
 * ("Verified"), it trumps and is the only badge surfaced.
 */
function aggregatePlanStates(plan: ComparePlanPayload): DisplayState[] {
  const set = new Set<DisplayState>();
  for (const benefit of plan.benefits) {
    const copayShape = decoratedShape(benefit.costSharing.inNetwork.copay);
    const coinShape = decoratedShape(benefit.costSharing.inNetwork.coinsurance);
    const state = copayShape.state ?? coinShape.state;
    if (state && state !== "hidden") set.add(state);
  }
  if (set.has("candid_verified")) return ["candid_verified"];
  // Order: worst (public_data) → best (user_verified). Reads left-to-right
  // in increasing trust.
  const ORDER: DisplayState[] = ["public_data", "community", "user_verified"];
  return ORDER.filter((s) => set.has(s));
}

export function CompareCategories({ plans }: CompareCategoriesProps) {
  const rows = useMemo(() => buildRows(plans), [plans]);
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, 12);
  const columnsClass = colsClass(plans.length);

  // Service breadth headline.
  const coveredCounts = plans.map((p) => p.coveredServiceCount);

  // Pre-compute per-plan source aggregates so the "Where this data comes from"
  // row (rendered right after the breadth headline) shows ALL unique non-Hidden
  // states represented across each plan's services. Verified trumps everything.
  const planAggregates = plans.map((plan) => aggregatePlanStates(plan));

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

      {/* Session 72 v3: aggregate badge cluster RIGHT AFTER the breadth row
          (was at the bottom of the services section). Shows unique sources
          represented across each plan's services. Verified trumps — single
          Verified badge if any service hits ≥3-user corroboration; otherwise
          all unique non-Hidden state badges show. */}
      <div className={`grid ${columnsClass} divide-x divide-slate-100 border-t border-slate-100 bg-slate-50/60`}>
        <div className="p-4">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">
            Where this data comes from
          </p>
          <p className="text-xs text-slate-500 mt-1">Sources represented across services</p>
        </div>
        {plans.map((plan, idx) => {
          const states = planAggregates[idx];
          return (
            <div
              key={`agg-${plan.ref.id}`}
              className="p-4 flex flex-wrap items-center gap-1.5"
            >
              {states.length === 0 ? (
                <p className="text-xs text-slate-400 italic">—</p>
              ) : (
                states.map((s) => {
                  const reason = REPRESENTATIVE_REASON[s];
                  if (!reason) return null;
                  return (
                    <DisplayStateBadge
                      key={s}
                      state={s}
                      reason={reason}
                      size="xs"
                      tooltip={AGGREGATE_TOOLTIP[s]}
                    />
                  );
                })
              )}
            </div>
          );
        })}
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
