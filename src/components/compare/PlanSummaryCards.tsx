"use client";

import { cn } from "@/lib/utils/cn";
import { unwrapValue } from "@/components/display-state";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { getCorroborationCopy, letterFor, planColorFor } from "./compare-colors";
import { cardsGridLgClass } from "./compare-grid";

/**
 * B3.3 — Per-plan summary cards in results view per §1.C.3 Recommendation 2.
 *
 * Each card:
 *   • Letter avatar (A/B/C) with gradient (blue/purple/pink)
 *   • Source pill — semantics per refined D-§1.C.3-J + Q7:
 *       - active user_plan          → green-check "Your plan"
 *       - other user_plan (upload)  → outline "Uploaded by you"
 *       - canonical                 → outline + bucketed corroboration copy
 *   • Plan name (truncated to 2 lines)
 *   • Sub (insurer · planType · metalLevel · stateYear) — joined non-null
 *   • Top-2 bestForTags chips with `why` tooltip (Pattern 1 #11 disclosure)
 *
 * Layout:
 *   - Cards align to data column grid template (label col empty on lg+) so
 *     each card sits directly above its matching data column in the tables
 *     below. Mobile stacks 1-col without the empty placeholder.
 *   - Card is flex-col with trait chips pushed to the bottom via `mt-auto`
 *     so they vertically align across cards of varying internal height.
 *
 * Fit Score DEFERRED per D-§1.C.3-C — no score row, no Best-fit badge.
 */

interface PlanSummaryCardsProps {
  plans: ComparePlanPayload[];
  /** User's ACTIVE plan id (from /api/plan/current). Used to distinguish the
   *  "Your plan" pill from "Uploaded by you" (comparison-only uploads). Null
   *  when user has no active plan. */
  userActiveInsurancePlanId: string | null;
}

function planTypeText(planType: unknown): string | null {
  const t = unwrapValue<string | null>(planType as never);
  if (!t) return null;
  return String(t).toUpperCase();
}

function joinSubparts(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim().length > 0)).join(" · ");
}

export function PlanSummaryCards({
  plans,
  userActiveInsurancePlanId,
}: PlanSummaryCardsProps) {
  if (plans.length === 0) return null;
  const gridClass = cn(
    "grid grid-cols-1 gap-4",
    cardsGridLgClass(plans.length),
  );

  return (
    <div className={gridClass}>
      {/* "THE PLANS" label sits in the label column on lg+ so cards align to
          data columns below. Hidden on mobile (cards stack 1-col). */}
      <div className="hidden lg:flex items-end pb-1 pl-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600">
          The plans
        </span>
      </div>
      {plans.map((plan, idx) => (
        <PlanSummaryCard
          key={`${plan.ref.kind}-${plan.ref.id}-${idx}`}
          plan={plan}
          index={idx}
          isUserActive={
            plan.ref.kind === "user_plan" &&
            userActiveInsurancePlanId !== null &&
            plan.ref.id === userActiveInsurancePlanId
          }
        />
      ))}
    </div>
  );
}

function PlanSummaryCard({
  plan,
  index,
  isUserActive,
}: {
  plan: ComparePlanPayload;
  index: number;
  isUserActive: boolean;
}) {
  const color = planColorFor(index);
  const letter = letterFor(index);
  const sub = joinSubparts([
    plan.insurerName || null,
    planTypeText(plan.planSummary.planType),
    plan.planSummary.metalLevel,
    plan.planSummary.year != null
      ? plan.planSummary.state
        ? `${plan.planSummary.state} ${plan.planSummary.year}`
        : String(plan.planSummary.year)
      : plan.planSummary.state ?? null,
  ]);
  const tags = (plan.bestForTags ?? []).slice(0, 2);

  return (
    <div
      data-plan={letter}
      className="h-full relative rounded-2xl bg-white ring-1 ring-slate-200 p-5 flex flex-col gap-3 shadow-sm"
    >
      {/* Head row: letter avatar + source pill (matches design cmp-summary-plan-head).
          flex-wrap lets the source pill drop below the avatar on narrow cards
          when the corroboration copy is long (e.g., "Verified by 1,000+ members
          on the same plan"). */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div
          className={cn(
            "shrink-0 w-11 h-11 rounded-xl text-white font-bold text-base flex items-center justify-center shadow-sm",
            color.gradient,
          )}
          aria-hidden="true"
        >
          {letter}
        </div>
        <SourcePill
          sourceLabel={plan.sourceLabel}
          isUserActive={isUserActive}
          corroborationCount={plan.corroborationCount}
        />
      </div>

      {/* Name + sub stack below the head. */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
          {plan.planName || "Unnamed plan"}
        </h3>
        {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
      </div>

      {tags.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
          {tags.map((tag) => (
            <span
              key={tag.key}
              title={tag.why}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200 text-[11px] font-semibold"
            >
              <svg
                className="w-3 h-3"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
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

function SourcePill({
  sourceLabel,
  isUserActive,
  corroborationCount,
}: {
  sourceLabel: "canonical" | "user_plan";
  isUserActive: boolean;
  corroborationCount: number | null;
}) {
  if (sourceLabel === "user_plan" && isUserActive) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 text-[11px] font-semibold">
        <svg
          className="w-3 h-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Your plan
      </span>
    );
  }
  if (sourceLabel === "user_plan") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 ring-1 ring-blue-200 text-[11px] font-semibold">
        Uploaded by you
      </span>
    );
  }
  // Canonical (search-picked) — bucketed corroboration copy.
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 text-slate-700 ring-1 ring-slate-200 text-[11px] font-semibold">
      {getCorroborationCopy(corroborationCount)}
    </span>
  );
}
