"use client";

/**
 * Claim Impact Hero — big, gradient impact card at the top of the Claim page.
 *
 * Shows total potential savings identified across all bills + secondary stats.
 * When empty, shows $0 in muted tone with a "Upload your first bill" invitation.
 *
 * Design: large bold number, tight letter-spacing, gradient bg blue-50 → indigo-50,
 * rounded-2xl to match existing card scale. Secondary stats row in a 3-col grid.
 */

import Link from "next/link";

interface ImpactStats {
  potentialSavings: number;
  totalRecovered: number;
  billsAnalyzed: number;
  issuesFlagged: number;
  disputesFiled: number;
  // Session 35 — T2.8: dispute-recovery framing
  totalPotentialRecovery?: number;
  totalRefundComponent?: number;
  totalForgivenessComponent?: number;
}

export function ClaimImpactHero({
  stats,
  isEmpty,
}: {
  stats: ImpactStats;
  isEmpty: boolean;
}) {
  // Hero priority:
  // 1. Money already recovered (wins — keep as hero when present)
  // 2. Total potential recovery (new T2.8 framing — billed vs plan-should-owe)
  // 3. Fallback to legacy potential-savings number for claims that haven't
  //    been re-derived yet
  const potentialRecovery = stats.totalPotentialRecovery ?? stats.potentialSavings;
  const heroNumber = stats.totalRecovered > 0 ? stats.totalRecovered : potentialRecovery;
  const heroLabel = stats.totalRecovered > 0 ? "Recovered so far" : "Potential recovery";
  const hasBreakdown =
    stats.totalRecovered === 0 &&
    !!(stats.totalRefundComponent && stats.totalRefundComponent > 0) ||
    !!(stats.totalForgivenessComponent && stats.totalForgivenessComponent > 0);
  const useGreenGradient = heroNumber > 0 && !isEmpty;

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border p-6 sm:p-8 ${
        useGreenGradient
          ? "border-green-100 bg-gradient-to-br from-green-50 via-emerald-50 to-white"
          : "border-blue-100 bg-gradient-to-br from-blue-50 via-indigo-50 to-white"
      }`}
    >
      {/* Decorative gradient blob */}
      <div
        className={`pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full blur-3xl ${
          useGreenGradient ? "bg-green-200/30" : "bg-blue-200/30"
        }`}
      />
      <div
        className={`pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full blur-3xl ${
          useGreenGradient ? "bg-emerald-200/30" : "bg-indigo-200/30"
        }`}
      />

      <div className="relative">
        <p
          className={`text-xs font-semibold uppercase tracking-wider ${
            useGreenGradient ? "text-green-700" : "text-blue-700"
          }`}
        >
          {heroLabel}
        </p>
        <div className="mt-2 flex items-baseline gap-3">
          <p
            className={`font-bold tracking-tight ${
              isEmpty ? "text-gray-300" : useGreenGradient ? "text-green-700" : "text-gray-900"
            }`}
            style={{ fontSize: "clamp(2.5rem, 6vw, 3.5rem)", lineHeight: 1 }}
          >
            ${heroNumber.toLocaleString()}
          </p>
          {!isEmpty && stats.totalRecovered > 0 && potentialRecovery > 0 && (
            <span className="text-sm font-medium text-gray-500">
              / ${potentialRecovery.toLocaleString()} potential
            </span>
          )}
        </div>

        {isEmpty ? (
          <p className="mt-3 max-w-md text-sm text-gray-500">
            Upload your first bill to see how much Candid can save you. We audit every line, flag overcharges, and draft dispute letters.
          </p>
        ) : (
          <>
            {hasBreakdown && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
                {stats.totalRefundComponent && stats.totalRefundComponent > 0 && (
                  <span>
                    <span className="font-semibold text-green-700">
                      ${stats.totalRefundComponent.toLocaleString()}
                    </span>{" "}
                    refund of what&apos;s already paid
                  </span>
                )}
                {stats.totalForgivenessComponent && stats.totalForgivenessComponent > 0 && (
                  <span>
                    <span className="font-semibold text-green-700">
                      ${stats.totalForgivenessComponent.toLocaleString()}
                    </span>{" "}
                    forgiveness of outstanding balances
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 text-sm text-gray-600">
              Across {stats.billsAnalyzed} {stats.billsAnalyzed === 1 ? "bill" : "bills"} ·{" "}
              {stats.issuesFlagged} {stats.issuesFlagged === 1 ? "issue" : "issues"} flagged ·{" "}
              {stats.disputesFiled} {stats.disputesFiled === 1 ? "dispute" : "disputes"} filed
            </p>
          </>
        )}

        {/* Secondary stats row */}
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-blue-100 pt-4">
          <HeroStat
            value={stats.billsAnalyzed}
            label="Bills analyzed"
            muted={isEmpty}
          />
          <HeroStat
            value={stats.issuesFlagged}
            label="Issues flagged"
            muted={isEmpty}
            color={stats.issuesFlagged > 0 ? "amber" : undefined}
          />
          <HeroStat
            value={stats.disputesFiled}
            label="Disputes filed"
            muted={isEmpty}
            color={stats.disputesFiled > 0 ? "blue" : undefined}
          />
        </div>

        {/* Primary CTA when empty */}
        {isEmpty && (
          <div className="mt-5">
            <Link
              href="/upload"
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              Upload your first bill
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function HeroStat({
  value,
  label,
  muted,
  color,
}: {
  value: number;
  label: string;
  muted: boolean;
  color?: "amber" | "blue";
}) {
  const numberColor = muted
    ? "text-gray-300"
    : color === "amber"
      ? "text-amber-600"
      : color === "blue"
        ? "text-blue-600"
        : "text-gray-900";

  return (
    <div>
      <p className={`text-xl font-bold tabular-nums ${numberColor}`}>{value}</p>
      <p className="mt-0.5 text-[11px] font-medium text-gray-500">{label}</p>
    </div>
  );
}
