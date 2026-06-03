"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import type { ComparePlanPayload } from "@/lib/plan/compare";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { CompareTopbar } from "../CompareTopbar";
import { asNumber } from "../compare-aggregates";
import { averageMemberShare, costBasisOf, rankBadges } from "../cost-model";
import {
  premiumMonthlyFor,
  suggestionToEntry,
  type PremiumEntry,
  type PremiumInputs,
} from "../premium-model";
import type { Household, UsageLevel } from "../yearly-model";
import { PlanSummaryCardsV2 } from "./PlanSummaryCardsV2";
import { NumbersTableV2 } from "./NumbersTableV2";
import { BreadthTableV2 } from "./BreadthTableV2";
import { ServiceCategoryAccordionsV2 } from "./ServiceCategoryAccordionsV2";
import { CompareModeToggle, type CompareMode } from "./CompareModeToggle";
import { BillControlsV2 } from "./BillControlsV2";
import { YearlyLensV2 } from "./YearlyLensV2";
import { PlanEditorPanelV2 } from "./PlanEditorPanelV2";
import type { CurrentPlanSummary, SlotState } from "../PlanSlot";
import type { RecentPlan } from "../compare-sessions";

/**
 * Compare v2 (S157 PR2 + S158 PR3/PR4) — results view (the flag-ON success body).
 *
 * Composes the reskinned sections over the SAME /api/plan/compare payload v1
 * consumes. Owns the results-level state (the design's CompareResults): mode/bill/
 * dedMet (PR3) + the premium suggestion/confirm map + usage/household/unit overrides
 * (PR4). Bill mode → BillControlsV2 + per-cell shares + section/plan averages; copay
 * mode → the Yearly Lens. Premiums are confirm-able suggestions; saving the user's
 * own plan persists via /api/plan/field, and every entry records a user-scoped
 * flywheel observation (best-effort — never blocks the UI).
 */

type EditableField =
  | "premium_monthly"
  | "in_deductible_individual"
  | "out_deductible_individual"
  | "in_oop_max_individual"
  | "out_oop_max_individual";

interface ResultsViewV2Props {
  plans: ComparePlanPayload[];
  onStartOver: () => void;
  onBackToPicker: () => void;
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
  // PR5 swap/add editor (ref-space; resolved + re-compared by page.tsx).
  currentPlan: CurrentPlanSummary | null;
  recents: RecentPlan[];
  onReplaceColumn: (columnIndex: number, slot: SlotState) => void;
  onAddColumn: (slot: SlotState) => void;
  onRemoveColumn: (columnIndex: number) => void;
}

const COPAY_DISCLAIMER =
  "Comparisons are built from your uploaded plan documents and verified data from Candid members on the same plan. Out-of-network details vary by provider — confirm with your insurer before scheduling care.";

const BILL_DISCLAIMER =
  "In “What I'd pay for a bill,” each row shows your share if that service's bill were the amount you enter — from a fresh deductible unless you mark it met, and capped at each plan's out-of-pocket maximum. Section and plan figures are the average across those services, so they never exceed the bill itself. Numbers are illustrative; out-of-network details vary by provider — always confirm with your insurer.";

export function ResultsViewV2({
  plans,
  onStartOver,
  onBackToPicker,
  userActiveInsurancePlanId,
  onFieldSaved,
  currentPlan,
  recents,
  onReplaceColumn,
  onAddColumn,
  onRemoveColumn,
}: ResultsViewV2Props) {
  const { user } = useAuth();
  const [mode, setMode] = useState<CompareMode>("copay");
  const [bill, setBill] = useState(2500);
  const [dedMet, setDedMet] = useState(false);

  // PR4 premium state: per-plan member action (entered/confirmed). Absent → the
  // ghost/prefilled default derived from the suggestion.
  const [premiums, setPremiums] = useState<Record<string, PremiumEntry>>({});
  const [usage, setUsage] = useState<UsageLevel>("average");
  const [household, setHousehold] = useState<Household>({ spouse: false, kids: 0 });
  const [unitOverrides, setUnitOverrides] = useState<Record<string, number> | null>(null);
  // PR5 swap/add editor: which column is being changed (index) / "add" / closed.
  const [openEdit, setOpenEdit] = useState<number | "add" | null>(null);

  const columnCanonicalId = (p: ComparePlanPayload): string | null =>
    p.canonicalPlanId ?? (p.ref.kind === "canonical" ? p.ref.id : null);
  // Exclude already-chosen plans from the editor's search (all other columns; for
  // "add", every current column).
  const editorExcludeIds = (forColumn: number | "add"): string[] =>
    plans
      .filter((_, i) => forColumn === "add" || i !== forColumn)
      .map(columnCanonicalId)
      .filter((id): id is string => !!id);

  // ── Bill-mode grand totals (average member share — never a sum). ───────────
  const bases = plans.map((p) => costBasisOf(p));
  const grandTotals = plans.map((p, i) => averageMemberShare(p.benefits, bases[i], bill, dedMet));
  const totalBadges = rankBadges(grandTotals.map((t) => (t.avg == null ? Infinity : t.avg)));

  // ── Premium suggestion / confirm ───────────────────────────────────────────
  function premiumInputsFor(plan: ComparePlanPayload): PremiumInputs {
    const isOwn = plan.sourceLabel === "user_plan";
    return {
      ownPlan: isOwn
        ? {
            premiumEmployee: plan.planSummary.premiumEmployee,
            premiumSubsidy: plan.planSummary.premiumSubsidy,
            premiumTotal: asNumber(plan.planSummary.premiumMonthly),
            frequency: plan.planSummary.premiumFrequency,
          }
        : null,
      community: null, // flywheel ≥N aggregation read-back is a follow-up
      metalLevel: plan.planSummary.metalLevel,
    };
  }
  const entryFor = (plan: ComparePlanPayload): PremiumEntry =>
    premiums[plan.ref.id] ?? suggestionToEntry(premiumMonthlyFor(premiumInputsFor(plan)));
  const effPremium = (plan: ComparePlanPayload): number | null => entryFor(plan).value;
  // §4.1 grounded: confirmed, own-plan stored, or ≥N community — NOT a bare estimate.
  const premiumGrounded = (plan: ComparePlanPayload): boolean => {
    const e = entryFor(plan);
    return e.value != null && (e.confirmed || e.source === "your_plan" || e.source === "community");
  };

  async function authedPost(url: string, body: Record<string, unknown>) {
    if (!user) return;
    try {
      const token = await user.firebaseUser.getIdToken();
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch {
      /* best-effort — premium persistence/flywheel must never break the UI */
    }
  }
  function fireFlywheel(plan: ComparePlanPayload, value: number, inclEmployer: boolean) {
    void authedPost("/api/compare/premium-observation", {
      premiumMonthly: value,
      inclEmployer,
      canonicalPlanId: plan.ref.kind === "canonical" ? plan.ref.id : null,
      insurancePlanId: plan.ref.kind === "user_plan" ? plan.ref.id : null,
      planLabel: plan.planName,
      metalLevel: plan.planSummary.metalLevel,
      state: plan.planSummary.state,
    });
  }
  const setPremium = (plan: ComparePlanPayload, entry: PremiumEntry) =>
    setPremiums((m) => ({ ...m, [plan.ref.id]: entry }));

  const onPremiumConfirm = (plan: ComparePlanPayload) => {
    const e = entryFor(plan);
    if (e.value == null) return;
    setPremium(plan, { ...e, confirmed: true });
    fireFlywheel(plan, e.value, e.inclEmployer);
  };
  const onPremiumSave = (plan: ComparePlanPayload, value: number, inclEmployer: boolean) => {
    setPremium(plan, { value, confirmed: true, source: "user_input", inclEmployer });
    const isActiveOwn =
      plan.ref.kind === "user_plan" && plan.ref.id === userActiveInsurancePlanId;
    if (isActiveOwn) {
      void authedPost("/api/plan/field", { planId: plan.ref.id, field: "premium_monthly", value });
      onFieldSaved?.(plan.ref.id, "premium_monthly", value);
    }
    fireFlywheel(plan, value, inclEmployer);
  };

  return (
    <div>
      <button
        type="button"
        onClick={onBackToPicker}
        className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700 mb-6"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to plan picker
      </button>

      <CompareTopbar planCount={plans.length} onStartOver={onStartOver} />

      <div className="mb-2">
        <CompareModeToggle mode={mode} onMode={setMode} />
      </div>

      {mode === "bill" ? (
        <BillControlsV2
          bill={bill}
          setBill={setBill}
          dedMet={dedMet}
          setDedMet={setDedMet}
          plans={plans}
          grandTotals={grandTotals}
          totalBadges={totalBadges}
        />
      ) : (
        <YearlyLensV2
          plans={plans}
          effPremium={effPremium}
          premiumGrounded={premiumGrounded}
          usage={usage}
          setUsage={setUsage}
          household={household}
          setHousehold={setHousehold}
          unitOverrides={unitOverrides}
          setUnitOverrides={setUnitOverrides}
        />
      )}

      <div className="mt-6">
        <PlanSummaryCardsV2
          plans={plans}
          userActiveInsurancePlanId={userActiveInsurancePlanId}
          onChangePlan={(i) => setOpenEdit(i)}
          onRemovePlan={onRemoveColumn}
        />

        {/* PR5 swap/add editor — change a column or add a third plan inline. */}
        {plans.length < 3 && openEdit !== "add" && (
          <button
            type="button"
            onClick={() => setOpenEdit("add")}
            className="w-full mt-4 rounded-2xl border-2 border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50/40 transition-all py-3 text-sm font-semibold text-slate-600 hover:text-blue-700"
          >
            + Add a third plan — search or pick a recent
          </button>
        )}
        {openEdit !== null && (
          <PlanEditorPanelV2
            isAdd={openEdit === "add"}
            columnIndex={openEdit === "add" ? plans.length : openEdit}
            targetName={openEdit === "add" ? null : plans[openEdit]?.planName}
            currentPlan={currentPlan}
            excludeIds={editorExcludeIds(openEdit)}
            recents={recents}
            onPick={(slot) => {
              if (openEdit === "add") onAddColumn(slot);
              else onReplaceColumn(openEdit, slot);
              setOpenEdit(null);
            }}
            onClose={() => setOpenEdit(null)}
          />
        )}

        <NumbersTableV2
          plans={plans}
          mode={mode}
          dedMet={dedMet}
          premiumEntryFor={entryFor}
          premiumMembersFor={(p) => p.corroborationCount}
          onPremiumConfirm={onPremiumConfirm}
          onPremiumSave={onPremiumSave}
        />
        <BreadthTableV2 plans={plans} />
        <ServiceCategoryAccordionsV2 plans={plans} mode={mode} bill={bill} dedMet={dedMet} />
      </div>

      <p className="mt-10 text-[12px] text-slate-500 leading-relaxed max-w-3xl mx-auto text-center px-4">
        {mode === "bill" ? BILL_DISCLAIMER : COPAY_DISCLAIMER}
      </p>

      <div className="mt-8">
        <ShareWithFriend surface="compare_results" />
      </div>
    </div>
  );
}
