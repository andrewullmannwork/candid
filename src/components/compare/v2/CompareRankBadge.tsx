import { cn } from "@/lib/utils/cn";
import type { Badge } from "../cost-model";

/**
 * Compare v2 (PR3) — tie-aware row verdict badge (design RankBadge).
 *
 * Renders the Best (green) or worst (amber "Priciest") badge assigned by
 * cost-model.rankBadges. Context labels per the design's actual worstLabel props:
 *   • service cells + section average → Best / "Priciest" (defaults)
 *   • THE NUMBERS rows                → Best / "Highest"
 *   • SERVICE BREADTH count rows      → Most / "Fewest"
 *   • bill-mode totals band           → "Lowest average" / "Highest average"
 *
 * Distinct from BestBadge — that is a single "leader" marker reused by v1 + the
 * collapsed category summary; this is the tie-aware best/worst verdict on a
 * comparable row, and adds the amber worst treatment v1 never had.
 */

interface CompareRankBadgeProps {
  kind: Badge;
  bestLabel?: string;
  worstLabel?: string;
  className?: string;
}

export function CompareRankBadge({
  kind,
  bestLabel = "Best",
  worstLabel = "Priciest",
  className,
}: CompareRankBadgeProps) {
  if (kind === "best") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
          "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
          "text-[10px] font-bold uppercase tracking-wide leading-none",
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
        {bestLabel}
      </span>
    );
  }
  if (kind === "worst") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
          "bg-amber-50 text-amber-800 ring-1 ring-amber-300",
          "text-[10px] font-bold uppercase tracking-wide leading-none",
          className,
        )}
      >
        <svg
          className="w-2.5 h-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
        {worstLabel}
      </span>
    );
  }
  return null;
}
