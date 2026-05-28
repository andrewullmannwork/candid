"use client";

import { cn } from "@/lib/utils/cn";

/**
 * Recovery hero — top-of-page hero on `/claim` summarizing potential recovery
 * across the user's audited bills.
 *
 * S138 (B4.2 design fidelity sweep) — adopts design's full chrome per
 * `/Users/andrewullmann/Downloads/styles.css` lines 110-211:
 *   - 32px padding (was ~20-24px) per --hero-pad
 *   - Big-fig: clamp(48px, 7vw, 76px) per .rec-bigfig
 *   - 4-stat grid with vertical divider rules between stats (.rec-stat + .rec-stat::before)
 *   - Border-top above the stat row + 22px padding-top
 *
 * Per Phase 1 §1.D.1 + D-§1.D.1-A:
 *   - "calm" variant default (rail-accent visual; rendered with left blue rail)
 *   - "ink" variant deferred to Phase 2 fast-follow
 *
 * Design source-of-truth:
 *   plans/findings/design-handoffs/s112-full-refresh/project/claim-summary.jsx
 *   (RecoveryHero + Stat components, lines 1-50)
 *   + /Users/andrewullmann/Downloads/styles.css .rec / .rec-stat family.
 *
 * Composes:
 *   eyebrow "Potential recovery"
 *   bigfig with ↑ + $totalRecovery
 *   context paragraph
 *   CTA "Review Dispute Letter →" + hint "{disputesCount} dispute ready · {reviewCount} need your input"
 *   4-stat row: Bills analyzed / Issues flagged / Need your input / Disputes drafted (last emph)
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
        "relative mb-6 overflow-hidden rounded-3xl border border-gray-200 bg-white",
        "px-6 py-7 shadow-[0_1px_2px_rgba(15,23,42,0.03),0_12px_32px_-16px_rgba(15,23,42,0.08)] sm:px-8 sm:py-8",
      )}
    >
      {/* Left rail accent — calm variant only. Design: 4px blue gradient. */}
      {isCalm && (
        <div
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-blue-500 to-blue-700"
          aria-hidden="true"
        />
      )}

      <div className={cn("relative", isCalm && "pl-3")}>
        {/* Head row: bigfig + context (left) + CTA + hint (right) */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600">
              Potential recovery
            </div>
            <div className="mt-3.5 flex items-baseline gap-2">
              <span
                className="font-bold text-emerald-600"
                style={{ fontSize: "clamp(24px, 3.5vw, 38px)", lineHeight: 1 }}
              >
                ↑
              </span>
              <span
                className="font-bold tracking-[-0.035em] text-gray-900 tabular-nums"
                style={{ fontSize: "clamp(48px, 7vw, 76px)", lineHeight: 1 }}
              >
                ${formatCurrency(totalRecovery)}
              </span>
            </div>
            <p className="mt-3 max-w-[52ch] text-sm leading-[1.55] text-gray-600">
              Across {billsCount} {billsCount === 1 ? "bill" : "bills"} you uploaded, Candid found{" "}
              <strong className="font-semibold text-gray-900">
                ${formatCurrency(totalRecovery)} you can recover
              </strong>{" "}
              — refunds and overcharges to dispute with your insurer and providers.
            </p>
          </div>

          {/* CTA column — only renders if there's an actionable next step */}
          {(disputesCount > 0 || issuesCount > 0) && (
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <button
                type="button"
                onClick={onPrimary}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all hover:-translate-y-px",
                  isCalm
                    ? "bg-gray-900 text-white hover:bg-gray-800"
                    : "bg-blue-600 text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)]",
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

        {/* 4-stat row — design uses grid w/ vertical divider rules between stats. */}
        <div className="mt-6 grid grid-cols-2 gap-x-0 gap-y-4 border-t border-gray-100 pt-5 sm:grid-cols-4">
          <Stat
            label="Bills analyzed"
            value={billsCount}
            sub="Uploaded"
            divider={false}
          />
          <Stat
            label="Issues flagged"
            value={issuesCount}
            sub={issuesCount === 1 ? "Overcharge" : "Overcharges"}
            color={issuesCount > 0 ? "red" : "default"}
            divider
          />
          <Stat
            label="Need your input"
            value={reviewCount}
            sub="Unclear from plan"
            color={reviewCount > 0 ? "amber" : "default"}
            divider
          />
          <Stat
            label="Disputes drafted"
            value={disputesCount}
            sub="Ready to send"
            color={disputesCount > 0 ? "blue" : "default"}
            emph
            divider
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
  divider = false,
}: {
  label: string;
  value: number;
  sub: string;
  color?: "default" | "amber" | "blue" | "red";
  emph?: boolean;
  divider?: boolean;
}) {
  const valueColor =
    color === "red"
      ? "text-red-600"
      : color === "amber"
        ? "text-amber-600"
        : color === "blue"
          ? "text-blue-700"
          : "text-gray-900";

  return (
    <div
      className={cn(
        "relative px-0 sm:px-5",
        // First stat: no left padding (matches design .rec-stat:first-child).
        "sm:first:pl-0",
        // Vertical divider rule between stats — design .rec-stat + .rec-stat::before.
        divider && "sm:before:absolute sm:before:left-0 sm:before:top-1.5 sm:before:bottom-1.5 sm:before:w-px sm:before:bg-gray-200 sm:before:content-['']",
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-bold tracking-[-0.02em] tabular-nums",
          emph ? "text-[22px]" : "text-[22px]",
          valueColor,
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] font-medium text-gray-500">{sub}</div>
    </div>
  );
}
