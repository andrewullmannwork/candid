"use client";

import { cn } from "@/lib/utils/cn";
import { decoratedShape, DisplayStateBadge } from "@/components/display-state";
import { ComparisonSection } from "@/components/comparison-section";
import type { ComparePlanPayload, ComparePlanSummary } from "@/lib/plan/compare";
import type { PremiumEntry } from "../premium-model";
import { asNumber, usd } from "../compare-aggregates";
import { rankBadges } from "../cost-model";
import { compareGridClass } from "../compare-grid";
import { CompareRankBadge } from "./CompareRankBadge";
import { PremiumCellV2 } from "./PremiumCellV2";
import { MobilePlanLabel } from "../MobilePlanLabel";
import { EmptyState } from "./EmptyState";
import type { CompareMode } from "./CompareModeToggle";

/**
 * Compare v2 (S157 PR2 + S158 PR3/PR4) — "THE NUMBERS" section.
 *
 * 5 rows (premium / in+out deductible / in+out OOP). Deductible + OOP rows carry
 * tie-aware Best/Highest badges (PR3) + the IN-OOP "ceiling" emphasis. PR4 swaps the
 * premium row to the PremiumCellV2 suggestion/confirm affordance per plan (no tie
 * badge there — the cell is the affordance; the premium comparison verdict lives in
 * the Yearly Lens). The in-deductible sublabel reflects the bill-mode dedMet toggle.
 */

type SummaryKey = "premiumMonthly" | "inDeductible" | "outDeductible" | "inOopMax" | "outOopMax";

interface NumbersTableV2Props {
  plans: ComparePlanPayload[];
  mode: CompareMode;
  dedMet: boolean;
  /** The user's active (profile) insurance_plans id — gates "Your"-framed premium copy. */
  userActiveInsurancePlanId: string | null;
  premiumEntryFor: (plan: ComparePlanPayload) => PremiumEntry;
  premiumMembersFor: (plan: ComparePlanPayload) => number | null;
  onPremiumConfirm: (plan: ComparePlanPayload) => void;
  onPremiumSave: (plan: ComparePlanPayload, value: number, inclEmployer: boolean) => void;
}

interface RowSpec {
  label: string;
  sublabel?: string;
  summaryKey: SummaryKey;
  perMonth?: boolean;
  emphasize?: boolean;
}

const ROWS: RowSpec[] = [
  { label: "Monthly premium", sublabel: "Out of pocket from your paycheck", summaryKey: "premiumMonthly", perMonth: true },
  { label: "In-network deductible", sublabel: "Individual", summaryKey: "inDeductible" },
  { label: "Out-of-network deductible", sublabel: "Individual", summaryKey: "outDeductible" },
  { label: "In-network OOP max", sublabel: "Your ceiling", summaryKey: "inOopMax", emphasize: true },
  { label: "Out-of-network OOP max", sublabel: "Individual", summaryKey: "outOopMax" },
];

function pickFromSummary(summary: ComparePlanSummary, key: SummaryKey): unknown {
  return summary[key];
}

export function NumbersTableV2(props: NumbersTableV2Props) {
  const { plans } = props;
  const gridClass = compareGridClass(plans.length);
  return (
    <ComparisonSection eyebrow="The numbers" title="Premiums, deductibles, and ceilings">
      <div className="rounded-2xl bg-white ring-1 ring-slate-200 overflow-hidden">
        {ROWS.map((row, idx) => (
          <NumericRowV2 key={row.summaryKey} row={row} gridClass={gridClass} isFirst={idx === 0} {...props} />
        ))}
      </div>
    </ComparisonSection>
  );
}

function NumericRowV2({
  row,
  plans,
  mode,
  dedMet,
  gridClass,
  isFirst,
  userActiveInsurancePlanId,
  premiumEntryFor,
  premiumMembersFor,
  onPremiumConfirm,
  onPremiumSave,
}: NumbersTableV2Props & { row: RowSpec; gridClass: string; isFirst: boolean }) {
  const isPremiumRow = row.summaryKey === "premiumMonthly";
  // Tie-aware lower-is-better ranking (cost rows → Best / Highest). The premium row
  // is the PremiumCellV2 affordance instead, so it gets no row badge.
  const vals = plans.map((p) => asNumber(pickFromSummary(p.planSummary, row.summaryKey)) ?? Infinity);
  const badges = isPremiumRow ? plans.map(() => null) : rankBadges(vals);

  const sublabel =
    row.summaryKey === "inDeductible" && mode === "bill" && dedMet ? "Marked as met" : row.sublabel;

  return (
    <div
      className={cn(
        "grid divide-y sm:divide-y-0 sm:divide-x divide-slate-100",
        gridClass,
        !isFirst && "border-t border-slate-100",
        row.emphasize && "bg-blue-50/40",
      )}
    >
      <div className="p-4 flex flex-col justify-center bg-slate-50 sm:bg-transparent">
        <p className="text-sm font-semibold sm:font-medium text-slate-700">{row.label}</p>
        {sublabel && (
          <p
            className={cn(
              "text-[11px] mt-0.5",
              row.emphasize ? "font-semibold uppercase tracking-wide text-blue-600" : "text-slate-400",
            )}
          >
            {sublabel}
          </p>
        )}
      </div>
      {plans.map((plan, planIdx) => {
        if (isPremiumRow) {
          return (
            <div key={`${plan.ref.id}-${planIdx}`} className="p-4 flex flex-col items-start sm:items-center gap-1">
              <MobilePlanLabel plan={plan} index={planIdx} />
              <PremiumCellV2
                entry={premiumEntryFor(plan)}
                membersCount={premiumMembersFor(plan)}
                isActivePlan={plan.ref.kind === "user_plan" && plan.ref.id === userActiveInsurancePlanId}
                onConfirm={() => onPremiumConfirm(plan)}
                onSave={(v, incl) => onPremiumSave(plan, v, incl)}
              />
            </div>
          );
        }

        const decorated = pickFromSummary(plan.planSummary, row.summaryKey);
        const { value, state, reason } = decoratedShape<number | null>(decorated as never);
        const isMissing = value == null;
        const badge = isMissing ? null : badges[planIdx];
        const isBest = badge === "best";

        return (
          <div key={`${plan.ref.id}-${planIdx}`} className="p-4 flex flex-col items-start sm:items-center gap-1">
            <MobilePlanLabel plan={plan} index={planIdx} />
            {isMissing ? (
              <EmptyState kind="unk" />
            ) : (
              <>
                <div className="flex items-center justify-center gap-1.5 flex-wrap">
                  <span
                    className={cn(
                      isBest
                        ? "text-base font-semibold text-emerald-600"
                        : cn("text-base font-semibold text-slate-900", row.emphasize && "text-lg"),
                    )}
                  >
                    {row.perMonth ? `${usd(value as number)}/mo` : usd(value as number)}
                  </span>
                  <CompareRankBadge kind={badge} worstLabel="Highest" />
                </div>
                {state && state !== "hidden" && reason && (
                  <DisplayStateBadge state={state} reason={reason} size="xs" />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
