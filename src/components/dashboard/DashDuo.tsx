"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { ComparePlansVisual } from "@/components/dashboard/ComparePlansVisual";
import type { PipelineCounts } from "@/lib/claims/use-claim-pipeline";

/**
 * Dash-duo — Surface 1 of the clarity redesign (design_handoff_clarity_redesign
 * README §1 + dashboard.jsx). Replaces the equal-width dash-trio with an explicit
 * hierarchy:
 *
 *   - ClaimHero  (1.3fr, blue tint, highlight): $ recoverable + pipeline stat row
 *     (overcharges / needs input / letters ready) + full-width solid-blue CTA.
 *   - PlanHero   (1fr, teal tint): benefits count + tracker rows (unused benefits,
 *     in-network deductible, OOP max) + white/teal-border CTA.
 *   - CompareBand: Compare demoted to a slim full-width band below the duo.
 *
 * CTAs bottom-align across both cards (mt-auto); count labels pluralize.
 * Empty states (no bills / no plan) keep the upload-first framing from the
 * previous trio cards — the prototype doesn't model empties, so those variants
 * reuse the S125 copy inside the new chrome.
 */

// ── Shared card chrome (mirrors ProductHero's .ph-card treatment) ───────────

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CARD_BASE =
  "group relative overflow-hidden flex flex-col text-left rounded-[20px] p-6 min-h-[244px] border transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-14px_rgba(15,23,42,0.18)]";

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-3.5 w-3.5"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

// ── Claim hero ──────────────────────────────────────────────────────────────

export interface ClaimHeroProps {
  /** Bills analyzed (parsed claims, not raw documents). */
  billsCount: number;
  /** Total $ recoverable across all bills. */
  totalRecovery: number;
  counts: PipelineCounts;
}

/**
 * Claim hero — the money pipeline. Whole card navigates to /claim.
 * Empty state (no bills) keeps the upload-first framing.
 */
export function ClaimHero({ billsCount, totalRecovery, counts }: ClaimHeroProps) {
  const hasBills = billsCount > 0;

  return (
    <Link
      href={hasBills ? "/claim" : "/upload"}
      className={cn(
        CARD_BASE,
        "bg-gradient-to-br from-white via-blue-50 to-blue-100 border-blue-200 hover:border-blue-400",
        "ring-2 ring-offset-1 ring-blue-200/80 shadow-md",
      )}
    >
      {/* Top row */}
      <div className="flex justify-between items-center mb-5">
        <div className="text-[12px] font-bold uppercase tracking-[0.12em] whitespace-nowrap text-blue-700">
          Candid Claim
        </div>
        <span className="inline-flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full whitespace-nowrap bg-green-50 text-green-700 ring-1 ring-inset ring-green-300">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
          Active
        </span>
      </div>

      {hasBills ? (
        <>
          {/* Metric: $ recoverable */}
          <div className="flex items-end gap-2 mb-3">
            <span className="text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-gray-900">
              ${fmtMoney(totalRecovery)}
            </span>
            <span className="text-[16px] font-medium leading-tight text-gray-500 pb-0.5">
              recoverable
            </span>
          </div>

          <div className="text-[15px] font-bold text-gray-900 tracking-[-0.005em]">
            Money Candid found across your {billsCount} uploaded{" "}
            {billsCount === 1 ? "bill" : "bills"}
          </div>

          {/* Pipeline stat row */}
          <div className="flex gap-2.5 mt-4 pt-3.5 border-t border-slate-900/10 flex-1 items-start">
            <HeroStat
              count={counts.flagged}
              label={counts.flagged === 1 ? "overcharge found" : "overcharges found"}
            />
            <HeroStat
              count={counts.review}
              label={counts.review === 1 ? "needs your input" : "need your input"}
              dot={counts.review > 0 ? "amber" : undefined}
            />
            <HeroStat
              count={counts.drafted}
              label={counts.drafted === 1 ? "letter ready to send" : "letters ready to send"}
              dot={counts.drafted > 0 ? "blue" : undefined}
            />
          </div>

          <HeroCtaButton variant="primary">
            See details &amp; send disputes <ArrowRight />
          </HeroCtaButton>
        </>
      ) : (
        <>
          <div className="mb-3">
            <div className="w-[58px] h-[58px] rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
          </div>
          <div className="text-[15px] font-bold text-gray-900 tracking-[-0.005em] mb-2">
            Audit your first bill
          </div>
          <div className="text-[12.5px] leading-[1.55] text-gray-500 flex-1">
            Upload an EOB or itemized bill — we&rsquo;ll find billing errors and overcharges in
            about a minute.
          </div>
          <HeroCtaButton variant="primary">
            Upload bill <ArrowRight />
          </HeroCtaButton>
        </>
      )}
    </Link>
  );
}

function HeroStat({
  count,
  label,
  dot,
}: {
  count: number;
  label: string;
  dot?: "amber" | "blue";
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5">
        {dot && (
          <span
            className={cn(
              "inline-block w-[7px] h-[7px] rounded-full",
              dot === "amber"
                ? "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
                : "bg-blue-600 shadow-[0_0_0_3px_rgba(37,99,235,0.16)]",
            )}
            aria-hidden="true"
          />
        )}
        <span className="text-[22px] font-bold tracking-[-0.01em] tabular-nums text-gray-900 leading-none">
          {count}
        </span>
      </div>
      <div className="text-[11.5px] text-gray-500 mt-1 leading-[1.3]">{label}</div>
    </div>
  );
}

function HeroCtaButton({
  variant,
  children,
}: {
  variant: "primary" | "plan";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-[18px] flex items-center justify-center gap-1.5 w-full px-5 py-3 rounded-[14px] text-[14px] font-semibold transition-all",
        // Bottom-align CTAs across both duo cards.
        "mt-auto",
        variant === "primary" &&
          "bg-blue-600 text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15),0_8px_32px_hsla(217,91%,60%,0.10)] group-hover:bg-blue-700 group-hover:-translate-y-px group-hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25),0_12px_40px_hsla(217,91%,60%,0.15)]",
        variant === "plan" &&
          "bg-white text-cyan-700 border border-cyan-200 shadow-[0_1px_4px_rgba(14,116,144,0.08)] group-hover:border-cyan-300 group-hover:bg-cyan-50 group-hover:-translate-y-px",
      )}
    >
      {children}
    </div>
  );
}

// ── Plan hero ───────────────────────────────────────────────────────────────

export interface PlanTracker {
  /** Applied-to-date dollars (accumulator ledger). */
  applied: number;
  /** Plan limit (denominator). */
  max: number;
}

export interface PlanHeroProps {
  totalBenefits: number;
  usedCount: number;
  hsaCount: number;
  /** True when the plan is verified (SBC/plan-doc backed). */
  verified: boolean;
  /** In-network deductible progress — null hides the row (no accumulator data). */
  deductible: PlanTracker | null;
  /** Out-of-pocket max progress — null hides the row. */
  oopMax: PlanTracker | null;
}

/**
 * Plan hero — benefits tracking. Tracker rows for deductible/OOP render only
 * when accumulator-ledger data exists (the `accumulator_ledger_v1` surface);
 * they light up automatically once that API is live and returns a ledger.
 */
export function PlanHero({
  totalBenefits,
  usedCount,
  hsaCount,
  verified,
  deductible,
  oopMax,
}: PlanHeroProps) {
  const hasPlan = totalBenefits > 0;
  const remaining = Math.max(0, totalBenefits - usedCount);

  return (
    <Link
      href={hasPlan ? "/plan" : "/upload"}
      className={cn(
        CARD_BASE,
        "bg-gradient-to-br from-white via-cyan-50 to-cyan-100 border-cyan-200 hover:border-cyan-300",
      )}
    >
      {/* Top row */}
      <div className="flex justify-between items-center mb-5">
        <div className="text-[12px] font-bold uppercase tracking-[0.12em] whitespace-nowrap text-cyan-800">
          Candid Plan
        </div>
        {verified ? (
          <span className="inline-flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full whitespace-nowrap bg-cyan-600/10 text-cyan-800 ring-1 ring-inset ring-cyan-200">
            Verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full whitespace-nowrap bg-green-50 text-green-700 ring-1 ring-inset ring-green-300">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
            Live
          </span>
        )}
      </div>

      {hasPlan ? (
        <>
          <div className="flex items-end gap-2 mb-3">
            <span className="text-[38px] font-bold leading-none tracking-[-0.03em] tabular-nums text-cyan-800">
              {totalBenefits}
            </span>
            <span className="text-[16px] font-medium leading-tight text-gray-500 pb-0.5">
              {totalBenefits === 1 ? "benefit on your plan" : "benefits on your plan"}
            </span>
          </div>

          <div className="text-[15px] font-bold text-gray-900 tracking-[-0.005em]">
            See what your plan really offers
          </div>

          {/* Tracker rows */}
          <div className="flex flex-col gap-[11px] mt-3.5 pt-3 border-t border-slate-900/10 flex-1 text-[12px]">
            <div className="flex justify-between items-baseline gap-2">
              <span className="text-gray-500 font-medium truncate">Unused benefits</span>
              <span className="text-gray-600 whitespace-nowrap">
                <b className="text-cyan-700 font-bold">
                  {remaining} of {totalBenefits}
                </b>
                {hsaCount > 0 && <> · {hsaCount} HSA/FSA eligible</>}
              </span>
            </div>
            {deductible && (
              <TrackRow label="In-network deductible" applied={deductible.applied} max={deductible.max} />
            )}
            {oopMax && <TrackRow label="Out-of-pocket max" applied={oopMax.applied} max={oopMax.max} />}
          </div>

          <HeroCtaButton variant="plan">
            Open Plan <ArrowRight />
          </HeroCtaButton>
        </>
      ) : (
        <>
          <div className="mb-3">
            <div className="w-[58px] h-[58px] rounded-2xl bg-cyan-100 text-cyan-700 flex items-center justify-center" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
          </div>
          <div className="text-[15px] font-bold text-gray-900 tracking-[-0.005em] mb-2">
            See what your plan covers
          </div>
          <div className="text-[12.5px] leading-[1.55] text-gray-500 flex-1">
            Add your plan to surface covered benefits and see which ones you haven&rsquo;t used
            yet.
          </div>
          <HeroCtaButton variant="plan">
            Upload plan <ArrowRight />
          </HeroCtaButton>
        </>
      )}
    </Link>
  );
}

function TrackRow({ label, applied, max }: { label: string; applied: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((applied / max) * 100)) : 0;
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-gray-500 font-medium truncate">{label}</span>
        <span className="text-gray-600 whitespace-nowrap">
          <b className="text-cyan-700 font-bold">${Math.round(applied).toLocaleString()}</b> of $
          {Math.round(max).toLocaleString()}
        </span>
      </div>
      <div className="h-[5px] rounded-full bg-cyan-700/15 overflow-hidden">
        <div className="h-full rounded-full bg-cyan-700" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Compare band ────────────────────────────────────────────────────────────

/**
 * Compare demoted to a slim full-width band below the duo — mini stacked-plans
 * visual + eyebrow "Candid Compare NEW" + bordered pill CTA.
 */
export function CompareBand() {
  return (
    <Link
      href="/compare"
      className={cn(
        "group w-full flex items-center gap-4 text-left rounded-2xl px-5 py-3.5",
        "bg-gradient-to-r from-white via-violet-50 to-violet-100 border border-violet-200",
        "transition-all duration-150 hover:border-violet-300 hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(91,33,182,0.08)]",
        "flex-wrap sm:flex-nowrap",
      )}
    >
      <div className="shrink-0 scale-[0.82] -my-1 -mx-0.5">
        <ComparePlansVisual />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.11em] text-violet-700">
          Candid Compare
          <span className="rounded-full bg-violet-600/10 ring-1 ring-inset ring-violet-300/60 px-1.5 py-px text-[9px]">
            NEW
          </span>
        </div>
        <div className="text-[14px] font-bold text-gray-900 mt-0.5">
          Shopping plans? See any plan&rsquo;s true yearly cost
        </div>
        <div className="text-[12px] text-gray-500 mt-0.5 leading-[1.45]">
          Premiums, deductibles, OOP max — plus what your actual bills would have cost on each. Up
          to 3 side by side.
        </div>
      </div>
      <span className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-violet-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-violet-700 shadow-[0_1px_4px_rgba(91,33,182,0.1)] transition-colors group-hover:border-violet-300 group-hover:bg-violet-50">
        Open Compare <ArrowRight className="h-3 w-3" />
      </span>
    </Link>
  );
}
