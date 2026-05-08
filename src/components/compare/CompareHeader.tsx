"use client";

/**
 * S70 — Top-line metrics row for the comparison table.
 *
 * Renders premium / OOP max / deductible across N columns. Uses Phase 4.0
 * DisplayState badges when consumer_read_filter_v1 is ON.
 */

import { useState } from "react";
import { decoratedShape, DisplayStateBadge } from "@/components/display-state";
import { PlanColumn } from "@/components/compare/PlanColumn";
import { useAuth } from "@/lib/auth/auth-context";
import type { ComparePlanPayload } from "@/lib/plan/compare";

type EditableField =
  | "premium_monthly"
  | "in_deductible_individual"
  | "out_deductible_individual"
  | "in_oop_max_individual"
  | "out_oop_max_individual";

interface CompareHeaderProps {
  plans: ComparePlanPayload[];
  /** Optimistic update callback when a user saves a missing field on one of
   *  their user_plan slots. Parent updates the matching plan's planSummary
   *  with the new value so the cell re-renders without a round-trip. */
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}

// Tailwind JIT requires literal class names — can't interpolate.
// Session 72 v3: label column = `minmax(120px,160px)` (was 180px max) so plan
// columns get more breathing room across viewports. Critical: this MUST match
// CompareCategories' grid template exactly so the two sections align. Plan
// names wrap (line-clamp-2) inside PlanColumn — they never force the column
// to push wider than the data cells below.
const COL_GRID_CLASS: Record<number, string> = {
  3: "grid-cols-[minmax(120px,160px)_1fr_1fr]",
  4: "grid-cols-[minmax(120px,160px)_1fr_1fr_1fr]",
};

function colsClass(planCount: number): string {
  return COL_GRID_CLASS[planCount + 1] ?? "grid-cols-[minmax(120px,160px)_1fr_1fr]";
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

export function CompareHeader({ plans, onFieldSaved }: CompareHeaderProps) {
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
          <PlanColumn key={plan.ref.id} plan={plan} planCount={plans.length} />
        ))}
      </div>

      {/* All five top-line metrics route through EditableMetricRow — when the
          plan is a user_plan and the value is null, the cell renders an inline
          "Add yours" form so the user can fill in a missing field without
          re-uploading their SBC. */}
      <EditableMetricRow
        plans={plans}
        label="Monthly premium"
        sublabel="Out of pocket from your paycheck"
        pick={(p) => p.planSummary.premiumMonthly}
        editField="premium_monthly"
        onFieldSaved={onFieldSaved}
      />
      <EditableMetricRow
        plans={plans}
        label="In-network deductible"
        pick={(p) => p.planSummary.inDeductible}
        editField="in_deductible_individual"
        onFieldSaved={onFieldSaved}
      />
      <EditableMetricRow
        plans={plans}
        label="Out-of-network deductible"
        pick={(p) => p.planSummary.outDeductible}
        editField="out_deductible_individual"
        onFieldSaved={onFieldSaved}
      />
      <EditableMetricRow
        plans={plans}
        label="In-network OOP max"
        pick={(p) => p.planSummary.inOopMax}
        editField="in_oop_max_individual"
        onFieldSaved={onFieldSaved}
      />
      <EditableMetricRow
        plans={plans}
        label="Out-of-network OOP max"
        pick={(p) => p.planSummary.outOopMax}
        editField="out_oop_max_individual"
        onFieldSaved={onFieldSaved}
      />
    </section>
  );
}

function EditableMetricRow({
  plans,
  label,
  sublabel,
  pick,
  editField,
  onFieldSaved,
}: {
  plans: ComparePlanPayload[];
  label: string;
  sublabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: (p: ComparePlanPayload) => any;
  editField: EditableField;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}) {
  const columnsClass = colsClass(plans.length);
  return (
    <div className={`grid ${columnsClass} divide-x divide-slate-100 border-t border-slate-100`}>
      <div className="p-4 flex flex-col justify-center">
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {sublabel && <p className="text-[11px] text-slate-400 mt-0.5">{sublabel}</p>}
      </div>
      {plans.map((plan) => {
        const decorated = pick(plan);
        const { value } = decoratedShape<number | null>(decorated);
        const isUserPlan = plan.ref.kind === "user_plan";
        const isMissing = value == null;
        return (
          <div key={plan.ref.id} className="p-4">
            {isMissing && isUserPlan ? (
              <FieldInlineEdit
                planId={plan.ref.id}
                field={editField}
                onSaved={(v) => onFieldSaved?.(plan.ref.id, editField, v)}
              />
            ) : (
              <MetricCell decorated={decorated} format={formatUsd} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FieldInlineEdit({
  planId,
  field,
  onSaved,
}: {
  planId: string;
  field: EditableField;
  onSaved: (value: number) => void;
}) {
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!user) return;
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
      setError("Enter a valid amount");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/field", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ planId, field, value: num }),
      });
      if (!res.ok) throw new Error("save failed");
      onSaved(num);
    } catch {
      setError("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="text-center">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-blue-600 mb-1.5">
        Add yours
      </p>
      <div className="flex items-center justify-center gap-1">
        <span className="text-slate-500 text-sm">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="0"
          disabled={saving}
          className="w-20 px-2 py-1 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!value || saving}
          className="px-2.5 py-1 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "…" : "Save"}
        </button>
      </div>
      {error && <p className="text-[10px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}

// MetricRow removed — superseded by EditableMetricRow which handles the
// inline-edit-when-null branch on top of the original render flow. Restore
// from git history if a non-editable variant is ever needed again.
