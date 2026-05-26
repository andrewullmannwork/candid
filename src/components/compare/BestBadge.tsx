import { cn } from "@/lib/utils/cn";

/**
 * B3.3 — Tiny "Best" pill used across NumbersTable + BreadthTable + per-row
 * leader markers.
 *
 * Ties: caller renders the badge on every tied index per honesty rule (see
 * compare-aggregates.bestNumericIndices). Co-leader caller passes
 * `label="Co-Leader"` when there's a tie at the top.
 *
 * Defaults to "Best" label; callers can override with "Most breadth" /
 * "Category leader" / "Co-Leader" for variant rows.
 *
 * Includes a ✓ checkmark icon per Phase 1 design's `cmp-results-best` pattern.
 */

interface BestBadgeProps {
  label?: string;
  className?: string;
}

export function BestBadge({ label = "Best", className }: BestBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
        "bg-emerald-100 text-emerald-800",
        "text-[10px] font-bold uppercase tracking-wide leading-none",
        "ring-1 ring-emerald-200",
        className,
      )}
    >
      <svg
        className="w-2.5 h-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M5 13l4 4L19 7" />
      </svg>
      {label}
    </span>
  );
}
