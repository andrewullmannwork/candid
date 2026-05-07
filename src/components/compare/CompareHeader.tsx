"use client";

/**
 * S70 — Top-line metrics row for the comparison table.
 *
 * Renders premium / OOP max / deductible across N columns. Uses Phase 4.0
 * DisplayState badges when consumer_read_filter_v1 is ON.
 */

import { decoratedShape, DisplayStateBadge } from "@/components/display-state";
import { PlanColumn } from "@/components/compare/PlanColumn";
import type { ComparePlanPayload } from "@/lib/plan/compare";

interface CompareHeaderProps {
  plans: ComparePlanPayload[];
}

// Tailwind JIT requires literal class names — can't interpolate.
const COL_GRID_CLASS: Record<number, string> = {
  3: "grid-cols-[200px_1fr_1fr]",
  4: "grid-cols-[200px_1fr_1fr_1fr]",
};

function colsClass(planCount: number): string {
  return COL_GRID_CLASS[planCount + 1] ?? "grid-cols-[200px_1fr_1fr]";
}

function formatUsd(value: number | null): string {
  if (value == null) return "—";
  return `$${value.toLocaleString()}`;
}

function MetricCell({
  decorated,
  format,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decorated: any;
  format: (v: number | null) => string;
}) {
  const { value, state, reason } = decoratedShape<number | null>(decorated);
  return (
    <div className="text-center">
      <p className="text-xl sm:text-2xl font-bold text-slate-900 tabular-nums">
        {format(value)}
      </p>
      {state && reason && (
        <div className="mt-1 flex justify-center">
          <DisplayStateBadge state={state} reason={reason} size="xs" />
        </div>
      )}
    </div>
  );
}

export function CompareHeader({ plans }: CompareHeaderProps) {
  const columnsClass = colsClass(plans.length);
  return (
    <section className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
      {/* Plan-name row */}
      <div className={`grid ${columnsClass} divide-x divide-slate-100`}>
        <div className="p-4 bg-slate-50">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">
            The numbers
          </p>
        </div>
        {plans.map((plan) => (
          <PlanColumn key={plan.ref.id} plan={plan} />
        ))}
      </div>

      {/* Premium row — top of metrics so it anchors as the "what does this cost me?" question. */}
      <MetricRow plans={plans} label="Monthly premium" pick={(p) => p.planSummary.premiumMonthly} format={formatUsd} sublabel="Out of pocket from your paycheck" />
      {/* In-network deductible */}
      <MetricRow plans={plans} label="In-network deductible" pick={(p) => p.planSummary.inDeductible} format={formatUsd} />
      {/* Out-of-network deductible */}
      <MetricRow plans={plans} label="Out-of-network deductible" pick={(p) => p.planSummary.outDeductible} format={formatUsd} />
      {/* In-network OOP max */}
      <MetricRow plans={plans} label="In-network OOP max" pick={(p) => p.planSummary.inOopMax} format={formatUsd} />
      {/* Out-of-network OOP max */}
      <MetricRow plans={plans} label="Out-of-network OOP max" pick={(p) => p.planSummary.outOopMax} format={formatUsd} />
    </section>
  );
}

function MetricRow({
  plans,
  label,
  pick,
  format,
  sublabel,
}: {
  plans: ComparePlanPayload[];
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: (p: ComparePlanPayload) => any;
  format: (v: number | null) => string;
  sublabel?: string;
}) {
  const columnsClass = colsClass(plans.length);
  return (
    <div className={`grid ${columnsClass} divide-x divide-slate-100 border-t border-slate-100`}>
      <div className="p-4 flex flex-col justify-center">
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {sublabel && <p className="text-[11px] text-slate-400 mt-0.5">{sublabel}</p>}
      </div>
      {plans.map((plan) => (
        <div key={plan.ref.id} className="p-4">
          <MetricCell decorated={pick(plan)} format={format} />
        </div>
      ))}
    </div>
  );
}
