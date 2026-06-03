"use client";

import type { ComparePlanPayload } from "@/lib/plan/compare";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { CompareTopbar } from "../CompareTopbar";
import { PlanSummaryCardsV2 } from "./PlanSummaryCardsV2";
import { NumbersTableV2 } from "./NumbersTableV2";
import { BreadthTableV2 } from "./BreadthTableV2";
import { ServiceCategoryAccordionsV2 } from "./ServiceCategoryAccordionsV2";

/**
 * Compare v2 (S157, PR2) — results view, copay mode (the flag-ON success body).
 *
 * Composes the reskinned sections over the SAME /api/plan/compare payload the v1
 * view consumes — summary cards → THE NUMBERS → SERVICE BREADTH → the
 * service-by-service accordions (with the EmptyLegend + distinct na/nc/unk empty
 * states). Mounted by ResultsView in compare/page.tsx ONLY when
 * compare_v2_redesign is ON; error + "no plans" states stay shared upstream, so
 * this component is always handed a non-empty plan cohort.
 *
 * NOT in PR2 (later PRs): the "Copays & coinsurance | What I'd pay for a bill"
 * mode toggle + bill mode (PR3); the Yearly Lens + premium-confirm UX (PR4); the
 * swap/add editor + localStorage sessions (PR5). PR2 is the copay-mode reskin.
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
  /** Return to the picker with the current slot selections intact (vs onStartOver, which clears them). */
  onBackToPicker: () => void;
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}

export function ResultsViewV2({
  plans,
  onStartOver,
  onBackToPicker,
  userActiveInsurancePlanId,
  onFieldSaved,
}: ResultsViewV2Props) {
  return (
    <div>
      {/* Persistent back link (design: "Back to plan picker" in results — returns
          to the picker with selections intact, NOT the dashboard). */}
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

      <div>
        <PlanSummaryCardsV2 plans={plans} userActiveInsurancePlanId={userActiveInsurancePlanId} />
        <NumbersTableV2
          plans={plans}
          userActiveInsurancePlanId={userActiveInsurancePlanId}
          onFieldSaved={onFieldSaved}
        />
        <BreadthTableV2 plans={plans} />
        <ServiceCategoryAccordionsV2 plans={plans} />
      </div>

      {/* D-§1.C.3-M bottom disclaimer — Pattern 1 #11 methodology disclosure. */}
      <p className="mt-10 text-[12px] text-slate-500 leading-relaxed max-w-3xl mx-auto text-center px-4">
        Comparisons are built from your uploaded plan documents and verified data from Candid members
        on the same plan. Out-of-network details vary by provider — confirm with your insurer before
        scheduling care.
      </p>

      <div className="mt-8">
        <ShareWithFriend surface="compare_results" />
      </div>
    </div>
  );
}
