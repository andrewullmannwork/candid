import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { type DisplayState } from "@/components/display-state";

// D-§1.C.2-I — aggregate-tier predicate for the "X of Y verified" pill color
// derivation. Verified-tier = user_verified | user_verified_community |
// candid_verified (per Display State v5 active in PROD post-S119 bundle).
// All other states (community / public_data / estimate / hidden) render the
// pill outline-amber. Mirrors `feedback_benefits_prose_preserve` durable rule —
// when source signal is verified-tier, surface that explicitly to the user.
function isVerifiedAggregateTier(s: DisplayState | null | undefined): boolean {
  return (
    s === "candid_verified" ||
    s === "user_verified" ||
    s === "user_verified_community"
  );
}

/**
 * CategoryAccordion — collapsible category header + body wrapper for /plan
 * benefits surface (B3.2 per §1.C.2 design).
 *
 * Header chrome (button): icon + name + "X of Y verified" aggregate badge +
 * usedCount/totalCount + progress bar + chev. Body is collapsible (children
 * prop only rendered when `open=true`).
 *
 * Controlled state via `open` + `onToggle` from parent — supports URL
 * `#category-X` hash deep-link (B3.1 wiring extended) + mutually-exclusive
 * "only one open at a time" UX (design source: single `openCat` state).
 *
 * The aggregate verification badge (DisplayStateBadge) is rendered when both
 * `aggregateState` + `aggregateReason` are non-null AND the state is in the
 * visible-tier set (parent computes via existing `isVisibleState` helper).
 * Passing both as null hides the badge.
 *
 * Per Andrew direction at B3.2 describe-before-code (2026-05-24): preserves
 * the 2-level disclosure pattern — this component supplies level 1 (category
 * accordion); per-row BenefitRow expand toggle stays inside the body
 * preserved byte-equivalent for cite-grade + howToAccess + whyUnderutilized
 * preservation (the screenshot is the contract).
 *
 * Per D-S112-G: inline Tailwind utilities; no variant CSS. `cn()` helper for
 * conditional classNames.
 */

interface CategoryAccordionProps {
  /** Stable category key. Used for `id="category-<key>"` deep-link target. */
  categoryKey: string;
  /** Human-readable category name (e.g., "Office visits"). */
  label: string;
  /** Pre-rendered icon node (caller controls icon mapping). */
  icon: ReactNode;
  /** Currently-used benefit count (drives progress bar fill). */
  usedCount: number;
  /** Total benefits in this category (drives progress bar denominator). */
  totalCount: number;
  /**
   * Verified-tier benefit count for the "X of Y verified" pill copy chrome
   * (D-§1.C.2-I). When omitted (e.g., legacy flag-OFF flow where rows have no
   * decoration), the pill is suppressed entirely so we don't render a misleading
   * "0 of N verified" against legacy raw data.
   */
  verifiedCount?: number;
  /**
   * Aggregate worst-signal display state — drives pill color only (verified-tier
   * → outline-green, anything else → outline-amber). Copy is always literal
   * "X of Y verified" per D-§1.C.2-I.
   */
  aggregateState?: DisplayState | null;
  /** Controlled open state from parent. */
  open: boolean;
  /** Toggle handler called when header button is clicked. */
  onToggle: () => void;
  /** Body content (rendered only when `open=true`). */
  children: ReactNode;
  className?: string;
}

export function CategoryAccordion({
  categoryKey,
  label,
  icon,
  usedCount,
  totalCount,
  verifiedCount,
  aggregateState,
  open,
  onToggle,
  children,
  className,
}: CategoryAccordionProps) {
  const pct = totalCount > 0 ? (usedCount / totalCount) * 100 : 0;
  const isFull = totalCount > 0 && usedCount === totalCount;
  const showVerifiedPill = typeof verifiedCount === "number";
  const verifiedTier = isVerifiedAggregateTier(aggregateState);

  return (
    <div
      id={`category-${categoryKey}`}
      className={cn(
        "border border-gray-100 rounded-2xl overflow-hidden bg-white",
        className,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-4 bg-gray-50/50 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="shrink-0">{icon}</span>
          <span className="font-semibold text-gray-900 truncate">{label}</span>
          {showVerifiedPill && (
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap",
                verifiedTier
                  ? "bg-green-50 text-green-700 border-green-200"
                  : "bg-amber-50 text-amber-700 border-amber-200",
              )}
            >
              {verifiedTier && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
              )}
              {verifiedCount} of {totalCount} verified
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "text-xs font-semibold",
              isFull ? "text-green-600" : "text-gray-400",
            )}
          >
            {usedCount}/{totalCount}
          </span>
          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <svg
            className={cn(
              "w-4 h-4 text-gray-400 transition-transform",
              open && "rotate-180",
            )}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </button>

      {open && <div className="divide-y divide-gray-50">{children}</div>}
    </div>
  );
}
