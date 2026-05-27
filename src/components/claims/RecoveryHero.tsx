"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Recovery hero — top-of-page hero on `/claim` summarizing potential recovery
 * across the user's audited bills. Per Phase 1 §1.D.1 + D-§1.D.1-A:
 *   - "calm" variant default (rail-accent visual; rendered with left blue rail)
 *   - "ink" variant deferred to Phase 2 fast-follow
 *
 * Design source-of-truth:
 *   plans/findings/design-handoffs/s112-full-refresh/project/claim-summary.jsx
 *   (RecoveryHero + Stat components, lines 1-50)
 *
 * Composes:
 *   eyebrow "Potential recovery"
 *   bigfig with ↑ + $totalRecovery
 *   context paragraph
 *   CTA "Review Dispute Letter →" + hint "{disputesCount} dispute ready · {reviewCount} need your input"
 *   4-stat row: Bills analyzed / Issues flagged / Need your input / Disputes drafted (last emph)
 *
 * Replaces the legacy <ClaimImpactHero> visually; preserves the same stats data
 * shape via the {@link RecoveryHeroStats} prop so the data path is unchanged.
 */

export interface RecoveryHeroStats {
  /** Total $ recoverable across all bills (T2.8 framing). */
  totalRecovery: number;
  /** Total bills audited. */
  billsCount: number;
  /** Confirmed overcharge count. */
  issuesCount: number;
  /** Drafted-dispute count. */
  disputesCount: number;
  /** Bills with review-needed state (unclear from plan). */
  reviewCount: number;
}

interface RecoveryHeroProps {
  stats: RecoveryHeroStats;
  variant?: "calm" | "ink";
  /** Click handler for the primary CTA. */
  onPrimary?: () => void;
  /** Override CTA label (defaults to "Review Dispute Letter" or "Draft a dispute" when no drafts exist). */
  primaryLabel?: string;
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function RecoveryHero({
  stats,
  variant = "calm",
  onPrimary,
  primaryLabel,
}: RecoveryHeroProps) {
  const { totalRecovery, billsCount, issuesCount, disputesCount, reviewCount } = stats;
  const isCalm = variant === "calm";

  // CTA label adapts to whether the user has draft disputes ready vs. only
  // flagged-but-undrafted bills. When neither, default to a soft "Review bills".
  const ctaLabel =
    primaryLabel ??
    (disputesCount > 0
      ? "Review Dispute Letter"
      : issuesCount > 0
        ? "Draft a dispute"
        : "Review bills");

  // Hint copy mirrors the design canvas literal: "{n} dispute ready · {m} need your input".
  // Both clauses are conditional so we don't render "0 dispute ready" awkwardness.
  const hintParts: string[] = [];
  if (disputesCount > 0) {
    hintParts.push(`${disputesCount} dispute${disputesCount === 1 ? "" : "s"} ready`);
  }
  if (reviewCount > 0) {
    hintParts.push(`${reviewCount} need${reviewCount === 1 ? "s" : ""} your input`);
  }
  const hint = hintParts.join(" · ");

  return (
    <div
      className={cn(
        "relative mb-6 overflow-hidden rounded-2xl border border-gray-100 bg-white",
        "px-5 py-5 sm:px-6 sm:py-6",
      )}
    >
      {/* Left rail accent — calm variant only */}
      {isCalm && (
        <div className="absolute inset-y-0 left-0 w-1 bg-blue-600" aria-hidden="true" />
      )}

      <div className={cn("relative", isCalm && "pl-4")}>
        {/* Head row: bigfig + context (left) + CTA + hint (right) */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold uppercase tracking-[0.15em] text-blue-700">
              Potential recovery
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-green-600 sm:text-4xl">
                ↑
              </span>
              <span
                className="font-bold tracking-tight text-gray-900 tabular-nums"
                style={{ fontSize: "clamp(2rem, 5vw, 2.75rem)", lineHeight: 1.05 }}
              >
                ${formatCurrency(totalRecovery)}
              </span>
            </div>
            <p className="mt-2 max-w-prose text-sm text-gray-600">
              Across {billsCount} {billsCount === 1 ? "bill" : "bills"} you uploaded, Candid found{" "}
              <strong className="font-semibold text-gray-900">
                ${formatCurrency(totalRecovery)} you can recover
              </strong>{" "}
              — refunds and overcharges to dispute with your insurer and providers.
            </p>
          </div>

          {/* CTA column — only renders if there's an actionable next step */}
          {(disputesCount > 0 || issuesCount > 0) && (
            <div className="flex flex-col items-stretch gap-1 sm:items-end">
              <button
                type="button"
                onClick={onPrimary}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors",
                  isCalm
                    ? "bg-gray-900 text-white hover:bg-gray-800"
                    : "bg-blue-600 text-white hover:bg-blue-700",
                )}
              >
                {ctaLabel}
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </button>
              {hint && (
                <div className="text-[11px] text-gray-500 sm:text-right">{hint}</div>
              )}
            </div>
          )}
        </div>

        {/* 4-stat row */}
        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 sm:grid-cols-4">
          <Stat
            label="Bills analyzed"
            value={billsCount}
            sub="Uploaded"
          />
          <Stat
            label="Issues flagged"
            value={issuesCount}
            sub={issuesCount === 1 ? "Overcharge" : "Overcharges"}
            color={issuesCount > 0 ? "red" : "default"}
          />
          <Stat
            label="Need your input"
            value={reviewCount}
            sub="Unclear from plan"
            color={reviewCount > 0 ? "amber" : "default"}
          />
          <Stat
            label="Disputes drafted"
            value={disputesCount}
            sub="Ready to send"
            color={disputesCount > 0 ? "blue" : "default"}
            emph
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color = "default",
  emph = false,
}: {
  label: string;
  value: number;
  sub: string;
  color?: "default" | "amber" | "blue" | "red";
  emph?: boolean;
}) {
  const valueColor =
    color === "red"
      ? "text-red-600"
      : color === "amber"
        ? "text-amber-600"
        : color === "blue"
          ? "text-blue-600"
          : "text-gray-900";

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-bold tabular-nums",
          emph ? "text-2xl" : "text-xl",
          valueColor,
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>
    </div>
  );
}
