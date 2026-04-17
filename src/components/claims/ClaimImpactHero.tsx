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
}

export function ClaimImpactHero({
  stats,
  isEmpty,
}: {
  stats: ImpactStats;
  isEmpty: boolean;
}) {
  // When user has recovered money, that's the hero number. Otherwise show savings potential.
  const heroNumber = stats.totalRecovered > 0 ? stats.totalRecovered : stats.potentialSavings;
  const heroLabel = stats.totalRecovered > 0 ? "Recovered so far" : "Potential savings identified";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-indigo-50 to-white p-6 sm:p-8">
      {/* Decorative gradient blob */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full bg-blue-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-indigo-200/30 blur-3xl" />

      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
          {heroLabel}
        </p>
        <div className="mt-2 flex items-baseline gap-3">
          <p
            className={`font-bold tracking-tight ${
              isEmpty ? "text-gray-300" : "text-gray-900"
            }`}
            style={{ fontSize: "clamp(2.5rem, 6vw, 3.5rem)", lineHeight: 1 }}
          >
            ${heroNumber.toLocaleString()}
          </p>
          {!isEmpty && stats.potentialSavings > 0 && stats.totalRecovered > 0 && (
            <span className="text-sm font-medium text-gray-500">
              / ${stats.potentialSavings.toLocaleString()} potential
            </span>
          )}
        </div>

        {isEmpty ? (
          <p className="mt-3 max-w-md text-sm text-gray-500">
            Upload your first bill to see how much Candid can save you. We audit every line, flag overcharges, and draft dispute letters.
          </p>
        ) : (
          <p className="mt-2 text-sm text-gray-600">
            Across {stats.billsAnalyzed} {stats.billsAnalyzed === 1 ? "bill" : "bills"} ·{" "}
            {stats.issuesFlagged} {stats.issuesFlagged === 1 ? "issue" : "issues"} flagged ·{" "}
            {stats.disputesFiled} {stats.disputesFiled === 1 ? "dispute" : "disputes"} filed
          </p>
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
