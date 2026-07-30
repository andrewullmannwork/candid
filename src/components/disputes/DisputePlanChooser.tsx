'use client';

/**
 * DisputePlanChooser — the #2 confirm/override chooser for the mid-year
 * plan-change × disputes feature (dispute_plan_pinning_v1, Phase 2).
 *
 * When a claim's year has more than one of the user's own insurance plans, the
 * dispute could have been rendered under either, so we ask the user which plan
 * they were on for that service. Built on the ModalShell primitive (NOT
 * PlanSearchModal — that 5-mode canonical-bind flow is left untouched per D3).
 * The selected plan id is returned via onConfirm and becomes the dispute's pin
 * (dispute_outcomes.insurance_plan_id) at /api/disputes/generate.
 *
 * Presentational only — no data fetching, no DB. The caller supplies the
 * already-fetched plan list (GET /api/plan/by-year) and the default selection.
 * Reused by the Phase 4 per-dispute re-bind control.
 */

import { useState, type ReactNode } from 'react';
import { ModalShell } from '@/components/modal';
import { cn } from '@/lib/utils/cn';

export interface DisputePlanChooserPlan {
  insurancePlanId: string;
  planName: string | null;
  insurerName: string | null;
  planType: string | null;
  /** S291 — the plan's own year. The API has always sent it; declaring it lets
   *  callers compare it against the bill's care year. */
  planYear?: number | null;
  coveragePeriodStart: string | null;
  coveragePeriodEnd: string | null;
  isActive: boolean;
}

interface DisputePlanChooserProps {
  open: boolean;
  onClose: () => void;
  plans: DisputePlanChooserPlan[];
  /** Pre-selected plan id (caller computes via DOS precedence). */
  defaultPlanId: string | null;
  /** Claim's date of service (YYYY-MM-DD) — drives the subtitle + per-row hint. */
  serviceDate: string | null;
  /** Claim's plan year — shown in the subtitle. */
  year: number | null;
  /** True while the chosen dispute is being drafted (disables the controls). */
  submitting?: boolean;
  /** Override the header + confirm label for reuse (Phase 4 re-bind). */
  eyebrow?: string;
  title?: string;
  subtitle?: ReactNode;
  confirmLabel?: string;
  /** Optional "don't see your plan? search the library / upload" affordance. */
  onSearchLibrary?: () => void;
  onConfirm: (insurancePlanId: string) => void;
}

function fmtDate(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return value;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** DOS falls inside the plan's coverage window (string compare is safe for ISO dates). */
function inWindow(plan: DisputePlanChooserPlan, dos: string | null): boolean {
  return !!(
    plan.coveragePeriodStart &&
    plan.coveragePeriodEnd &&
    dos &&
    dos >= plan.coveragePeriodStart &&
    dos <= plan.coveragePeriodEnd
  );
}

export function DisputePlanChooser({
  open,
  onClose,
  plans,
  defaultPlanId,
  serviceDate,
  year,
  submitting = false,
  onConfirm,
  eyebrow = 'Plan for this dispute',
  title = 'Which plan were you on?',
  subtitle,
  confirmLabel = 'Draft letter with this plan',
  onSearchLibrary,
}: DisputePlanChooserProps) {
  const [selectedId, setSelectedId] = useState<string | null>(defaultPlanId);
  const [prevOpen, setPrevOpen] = useState(open);

  // Reset the selection each time the chooser opens. Render-phase state sync —
  // the React-sanctioned alternative to a setState-in-effect (which the lint
  // flags for cascading renders).
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSelectedId(defaultPlanId);
  }

  const serviceDateLabel = fmtDate(serviceDate);

  const defaultSubtitle = (
    <>
      You had more than one plan{year != null ? ` in ${year}` : ''}. Pick the plan you had when this
      service happened
      {serviceDateLabel ? (
        <>
          {' — '}
          <span className="text-gray-900 font-medium">{serviceDateLabel}</span>
        </>
      ) : null}
      .
    </>
  );

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="md"
      eyebrow={eyebrow}
      title={title}
      subtitle={subtitle ?? defaultSubtitle}
      dismissable={!submitting}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2.5 text-[14px] font-semibold text-gray-700 hover:bg-gray-100 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectedId) onConfirm(selectedId);
            }}
            disabled={!selectedId || submitting}
            className="px-4 py-2.5 text-[14px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:opacity-50"
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {plans.map((plan) => {
          const selected = plan.insurancePlanId === selectedId;
          const matchesDate = inWindow(plan, serviceDate);
          const start = fmtDate(plan.coveragePeriodStart);
          const end = fmtDate(plan.coveragePeriodEnd);
          const coverageWindow = start && end ? `${start} – ${end}` : null;
          const meta = [plan.insurerName, plan.planType, coverageWindow].filter(Boolean).join(' · ');
          return (
            <button
              key={plan.insurancePlanId}
              type="button"
              onClick={() => setSelectedId(plan.insurancePlanId)}
              aria-pressed={selected}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                selected
                  ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                  : 'border-gray-200 bg-white hover:border-gray-300',
              )}
            >
              <span
                className={cn(
                  'flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border',
                  selected ? 'border-blue-600' : 'border-gray-300',
                )}
                aria-hidden="true"
              >
                {selected && <span className="w-[9px] h-[9px] rounded-full bg-blue-600" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold text-gray-900 truncate">
                  {plan.planName || 'Unnamed plan'}
                </span>
                {meta && <span className="block mt-0.5 text-[12px] text-gray-500 truncate">{meta}</span>}
              </span>
              {matchesDate ? (
                <span className="flex-shrink-0 text-[11px] font-semibold px-2 py-1 rounded-lg bg-blue-100 text-blue-700">
                  Matches service date
                </span>
              ) : plan.isActive ? (
                <span className="flex-shrink-0 text-[11px] font-semibold px-2 py-1 rounded-lg bg-green-100 text-green-700">
                  Active now
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {onSearchLibrary && (
        <button
          type="button"
          onClick={onSearchLibrary}
          disabled={submitting}
          className="mt-3 text-[13px] font-medium text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50"
        >
          Don&apos;t see your plan? Search Candid&apos;s library or upload it
        </button>
      )}
    </ModalShell>
  );
}
