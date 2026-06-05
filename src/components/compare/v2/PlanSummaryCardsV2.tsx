"use client";

import { cn } from "@/lib/utils/cn";
import { unwrapValue } from "@/components/display-state";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { getCorroborationCopy, letterFor, planColorFor } from "../compare-colors";
import { cardsGridLgClass } from "../compare-grid";

/**
 * Compare v2 (S157, PR2) — per-plan summary cards, results view.
 *
 * Evolves the B3.3 PlanSummaryCards for the reskin. Structure is intentionally
 * close to v1 — the redesign refined the summary card's chrome, it didn't
 * restructure it (and removed nothing that exists today; the "fit score" was
 * already deferred). The load-bearing reconciliation is the SOURCE PILL, which
 * maps the payload provenance onto Candid's Display-State v5 vocabulary:
 *   • active user_plan          → green-check "Your plan"  (user_verified tier)
 *   • other user_plan (upload)  → "Uploaded by you"
 *   • canonical (search-picked)  → bucketed corroboration copy (community tier;
 *                                  power-of-10 floor, never overstates — Rule #5)
 *
 * Swap/remove ("Change" / ×) actions are PR5 (picker + swap/add editor) — the
 * card action row is intentionally absent at PR2.
 *
 * Cards align to the data-column grid template on lg+ (the "THE PLANS" side
 * label occupies the label column) so each card sits above its matching data
 * column in the tables below; mobile stacks 1-col.
 */

interface PlanSummaryCardsV2Props {
  plans: ComparePlanPayload[];
  /** User's ACTIVE plan id (from /api/plan/current) — distinguishes "Your plan"
   *  from "Uploaded by you" (comparison-only uploads). Null when no active plan. */
  userActiveInsurancePlanId: string | null;
  /** PR5 swap/add editor — open the editor for a column / remove a column. */
  onChangePlan?: (index: number) => void;
  onRemovePlan?: (index: number) => void;
}

function planTypeText(planType: unknown): string | null {
  const t = unwrapValue<string | null>(planType as never);
  if (!t) return null;
  return String(t).toUpperCase();
}

function joinSubparts(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim().length > 0)).join(" · ");
}

export function PlanSummaryCardsV2({
  plans,
  userActiveInsurancePlanId,
  onChangePlan,
  onRemovePlan,
}: PlanSummaryCardsV2Props) {
  if (plans.length === 0) return null;
  const gridClass = cn("grid grid-cols-1 gap-4", cardsGridLgClass(plans.length));

  return (
    <div className={gridClass}>
      <div className="hidden lg:flex items-end pb-1 pl-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600">
          The plans
        </span>
      </div>
      {plans.map((plan, idx) => (
        <PlanSummaryCardV2
          key={`${plan.ref.kind}-${plan.ref.id}-${idx}`}
          plan={plan}
          index={idx}
          isUserActive={
            plan.ref.kind === "user_plan" &&
            userActiveInsurancePlanId !== null &&
            plan.ref.id === userActiveInsurancePlanId
          }
          onChange={onChangePlan ? () => onChangePlan(idx) : undefined}
          onRemove={onRemovePlan && plans.length > 2 ? () => onRemovePlan(idx) : undefined}
        />
      ))}
    </div>
  );
}

function PlanSummaryCardV2({
  plan,
  index,
  isUserActive,
  onChange,
  onRemove,
}: {
  plan: ComparePlanPayload;
  index: number;
  isUserActive: boolean;
  onChange?: () => void;
  onRemove?: () => void;
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
        <SourcePillV2
          sourceLabel={plan.sourceLabel}
          isUserActive={isUserActive}
          corroborationCount={plan.corroborationCount}
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
          {plan.planName || "Unnamed plan"}
        </h3>
        {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-2">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag.key}
                title={tag.why}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 ring-1 ring-amber-200 text-[11px] font-semibold"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2l2.39 7.36H22l-6.18 4.49 2.36 7.36L12 16.71l-6.18 4.5 2.36-7.36L2 9.36h7.61z" />
                </svg>
                {tag.label}
              </span>
            ))}
          </div>
        )}
        {onChange && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onChange}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Change
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label="Remove plan"
                className="ml-auto text-slate-400 hover:text-rose-600 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SourcePillV2({
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
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 text-slate-700 ring-1 ring-slate-200 text-[11px] font-semibold">
      {getCorroborationCopy(corroborationCount)}
    </span>
  );
}
